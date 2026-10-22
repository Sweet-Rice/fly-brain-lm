"""Unit and behavioral tests for harness.app_server.

Tests meaningful real sockets:
- Confinement of static assets to harness/ directory (no directory traversal, no dotfiles/secrets).
- Root redirect ("/" and "/app" -> "/app/").
- Fixed configured HTTP upstream on literal loopback (rejecting non-loopback bind/upstream).
- Whitelisted routes proxying (/health, /v1/models, /v1/completions, /v1/chat/completions).
- Bounded request body enforcement.
- Memory-only pass-through of Authorization header.
- Safe structured JSON error responses (no traceback or local filesystem paths leaked).
- Incremental SSE streaming before upstream completes.
- Propagation of downstream disconnect to cleanly close upstream connection.
- Optional model-server launcher: loading vs exited 503 types and /health checkpoint identity.
"""

import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import select
import socket
import struct
import sys
import textwrap
import threading
import time
from typing import Dict, List, Optional
import urllib.error
import urllib.request

import pytest

from harness.app_server import (
    DEFAULT_API_URL,
    DEFAULT_HOST,
    DEFAULT_PORT,
    MAX_REQUEST_BODY_SIZE,
    AppHTTPServer,
    ModelProcess,
    is_loopback_host,
    make_server,
    resolve_static_asset,
    validate_loopback_url,
)


@pytest.fixture
def dummy_upstream():
    """Runs a minimal real-socket upstream HTTP server on a loopback port."""

    class UpstreamHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def do_GET(self):
            if self.path == "/health":
                body = b'{"status": "ok", "model": "test-flybrain"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/v1/models":
                body = b'{"object": "list", "data": [{"id": "test-flybrain"}]}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self):
            auth = self.headers.get("Authorization")
            self.server.received_auth = auth

            content_len = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_len) if content_len > 0 else b"{}"
            try:
                data = json.loads(raw_body.decode("utf-8"))
            except Exception:
                data = {}

            if self.path in ("/v1/completions", "/v1/chat/completions"):
                if data.get("stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(b"data: {\"choices\": [{\"delta\": {\"content\": \"hello\"}}]}\n\n")
                    self.wfile.flush()
                    self.server.first_chunk_event.set()

                    self.server.active_client_sock = self.connection

                    # Gated pause or delay before second chunk
                    if getattr(self.server, "hold_second_chunk", False):
                        if hasattr(self.server, "second_chunk_held_event"):
                            self.server.second_chunk_held_event.set()
                        if hasattr(self.server, "resume_second_chunk_event"):
                            self.server.resume_second_chunk_event.wait(timeout=5.0)
                    elif getattr(self.server, "delay_before_second_chunk", 0.0) > 0:
                        time.sleep(self.server.delay_before_second_chunk)

                    if getattr(self.server, "reset_after_first_chunk", False):
                        # Simulate the model process dying mid-stream: abort with an RST
                        # instead of writing the next chunk.
                        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                        self.connection.close()
                        return

                    try:
                        self.wfile.write(b"data: {\"choices\": [{\"delta\": {\"content\": \" world\"}}]}\n\n")
                        self.wfile.flush()
                        self.wfile.write(b"data: [DONE]\n\n")
                        self.wfile.flush()
                    except Exception as e:
                        self.server.write_error = type(e).__name__
                    finally:
                        if hasattr(self.server, "completion_event"):
                            self.server.completion_event.set()
                else:
                    body = json.dumps({
                        "object": "chat.completion",
                        "choices": [{"message": {"role": "assistant", "content": "mocked response"}}],
                    }).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
    server.received_auth = None
    server.first_chunk_event = threading.Event()
    server.write_error = None
    server.delay_before_second_chunk = 0.0
    server.hold_second_chunk = False
    server.second_chunk_held_event = threading.Event()
    server.resume_second_chunk_event = threading.Event()
    server.completion_event = threading.Event()
    server.active_client_sock = None
    server.reset_after_first_chunk = False
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    host, port = server.server_address[:2]
    url = f"http://{host}:{port}"
    yield server, url

    server.shutdown()
    server.server_close()


def test_loopback_validation():
    """Verify loopback host and upstream URL restrictions."""
    assert is_loopback_host("127.0.0.1")
    assert is_loopback_host("localhost")
    assert is_loopback_host("::1")
    assert is_loopback_host("[::1]")
    assert not is_loopback_host("0.0.0.0")
    assert not is_loopback_host("8.8.8.8")
    assert not is_loopback_host("example.com")

    validate_loopback_url("http://127.0.0.1:8771")
    validate_loopback_url("http://localhost:8000/v1")
    validate_loopback_url("http://[::1]:8771")

    with pytest.raises(ValueError, match="scheme must be http"):
        validate_loopback_url("ftp://127.0.0.1:8771")

    with pytest.raises(ValueError, match="literal loopback"):
        validate_loopback_url("http://192.168.1.1:8771")

    with pytest.raises(ValueError, match="literal loopback"):
        make_server(host="0.0.0.0", port=0)


def test_root_and_app_redirects():
    """Verify that GET / and /app return 307 redirect to /app/."""
    server = make_server(port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)
        conn.request("GET", "/")
        resp = conn.getresponse()
        assert resp.status == 307
        assert resp.getheader("Location") == "/app/"
        conn.close()

        conn = http.client.HTTPConnection("127.0.0.1", port)
        conn.request("GET", "/app")
        resp = conn.getresponse()
        assert resp.status == 307
        assert resp.getheader("Location") == "/app/"
        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def test_static_asset_serving_and_confinement():
    """Verify assets under harness/ are served and traversal outside harness/ is prevented."""
    harness_dir = Path(__file__).resolve().parent.parent / "harness"
    server = make_server(port=0, assets_dir=harness_dir)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        # GET /app/ -> serves harness/app/index.html
        conn.request("GET", "/app/")
        resp = conn.getresponse()
        assert resp.status == 200
        assert "text/html" in resp.getheader("Content-Type")
        resp.read()

        # GET /app/main.js -> javascript mime type
        conn.request("GET", "/app/main.js")
        resp = conn.getresponse()
        assert resp.status == 200
        assert "text/javascript" in resp.getheader("Content-Type")
        resp.read()

        # HEAD /app/ -> 200 with headers but empty body
        conn.request("HEAD", "/app/")
        resp = conn.getresponse()
        assert resp.status == 200
        assert int(resp.getheader("Content-Length", 0)) > 0
        assert len(resp.read()) == 0

        # Traversal attacks: attempts to break out of harness/
        traversal_paths = [
            "/../README.md",
            "/app/../../model/serve/serve.py",
            "/%2e%2e/model/serve/serve.py",
            "/%2e%2e/%2e%2e/etc/passwd",
            "/.git/config",
            "/app/.git",
            "/app/.env",
        ]
        for path in traversal_paths:
            conn.request("GET", path)
            resp = conn.getresponse()
            assert resp.status == 404, f"Path {path} should return 404, got {resp.status}"
            resp_body = resp.read()
            assert b"README" not in resp_body
            assert b"password" not in resp_body
            assert b"root:" not in resp_body

        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def test_static_asset_symlink_confinement(tmp_path):
    """Verify confinement prevents symlink breakout via directory index.html and files."""
    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    outside_secret = tmp_path / "outside_secret.txt"
    outside_secret.write_text("CONFIDENTIAL_SYSTEM_SECRET")

    # Directory with index.html symlink pointing outside assets_dir
    bad_dir = assets_dir / "external_link_dir"
    bad_dir.mkdir()
    (bad_dir / "index.html").symlink_to(outside_secret)

    # Directory with index.html symlink pointing to hidden dotfile inside assets_dir
    hidden_dir = assets_dir / ".hidden_secret"
    hidden_dir.mkdir()
    hidden_file = hidden_dir / "hidden.html"
    hidden_file.write_text("HIDDEN_CONTENT")
    dot_dir = assets_dir / "dot_link_dir"
    dot_dir.mkdir()
    (dot_dir / "index.html").symlink_to(hidden_file)

    # Directory with valid regular index.html
    good_dir = assets_dir / "good_dir"
    good_dir.mkdir()
    good_file = good_dir / "index.html"
    good_file.write_text("PUBLIC_OK")

    # Directory with valid internal symlink to regular file within assets_dir
    sym_dir = assets_dir / "sym_dir"
    sym_dir.mkdir()
    (sym_dir / "index.html").symlink_to(good_file)

    # Direct file symlink pointing outside assets_dir
    (assets_dir / "leak.txt").symlink_to(outside_secret)

    # Direct resolution checks
    assert resolve_static_asset("/external_link_dir/", assets_dir) is None
    assert resolve_static_asset("/dot_link_dir/", assets_dir) is None
    assert resolve_static_asset("/leak.txt", assets_dir) is None
    assert resolve_static_asset("/good_dir/", assets_dir) == good_file.resolve()
    assert resolve_static_asset("/sym_dir/", assets_dir) == good_file.resolve()

    # Full HTTP server behavior checks
    server = make_server(port=0, assets_dir=assets_dir)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        for path in ("/external_link_dir/", "/dot_link_dir/", "/leak.txt"):
            conn.request("GET", path)
            resp = conn.getresponse()
            assert resp.status == 404
            body = resp.read()
            assert b"CONFIDENTIAL" not in body
            assert b"HIDDEN" not in body

        conn.request("GET", "/good_dir/")
        resp = conn.getresponse()
        assert resp.status == 200
        assert resp.read() == b"PUBLIC_OK"

        conn.request("GET", "/sym_dir/")
        resp = conn.getresponse()
        assert resp.status == 200
        assert resp.read() == b"PUBLIC_OK"

        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def test_whitelisted_get_routes(dummy_upstream):
    """Verify /health and /v1/models are proxied to upstream without CORS headers."""
    upstream_srv, upstream_url = dummy_upstream

    server = make_server(port=0, api_url=upstream_url)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        # GET /health
        conn.request("GET", "/health")
        resp = conn.getresponse()
        assert resp.status == 200
        assert "application/json" in resp.getheader("Content-Type")
        assert resp.getheader("Access-Control-Allow-Origin") is None  # no CORS
        data = json.loads(resp.read().decode("utf-8"))
        assert data.get("status") == "ok"
        assert data.get("model") == "test-flybrain"

        # GET /v1/models
        conn.request("GET", "/v1/models")
        resp = conn.getresponse()
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data.get("object") == "list"
        assert data.get("data")[0]["id"] == "test-flybrain"

        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def test_whitelisted_post_routes_and_auth_passthrough(dummy_upstream):
    """Verify non-streaming POST routes and memory-only Authorization pass-through."""
    upstream_srv, upstream_url = dummy_upstream

    server = make_server(port=0, api_url=upstream_url)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        req_body = json.dumps({"model": "test-flybrain", "messages": [{"role": "user", "content": "ping"}]}).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer secret-token-flybrain-12345",
        }

        conn.request("POST", "/v1/chat/completions", body=req_body, headers=headers)
        resp = conn.getresponse()
        assert resp.status == 200
        assert "application/json" in resp.getheader("Content-Type")
        data = json.loads(resp.read().decode("utf-8"))
        assert data["choices"][0]["message"]["content"] == "mocked response"

        # Upstream received the Authorization header
        assert upstream_srv.received_auth == "Bearer secret-token-flybrain-12345"

        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def test_sse_streaming_before_upstream_completes(dummy_upstream):
    """Verify incremental SSE delivery: client receives first chunk while upstream delays."""
    upstream_srv, upstream_url = dummy_upstream
    upstream_srv.delay_before_second_chunk = 0.4  # upstream delays 400ms before second chunk

    server = make_server(port=0, api_url=upstream_url)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)
        req_body = json.dumps({"stream": True, "prompt": "Hi"}).encode("utf-8")
        conn.request("POST", "/v1/completions", body=req_body, headers={"Content-Type": "application/json"})

        resp = conn.getresponse()
        assert resp.status == 200
        assert "text/event-stream" in resp.getheader("Content-Type")

        t0 = time.time()
        first_chunk = resp.read1(1024)
        elapsed = time.time() - t0

        # Proves chunk 1 arrived immediately without waiting for the 0.4s upstream delay
        assert elapsed < 0.25
        assert b"hello" in first_chunk

        # Now read second chunk after upstream delay
        second_chunk = resp.read1(1024)
        assert b"world" in second_chunk

        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def test_disconnect_propagates_to_upstream_cleanup(dummy_upstream):
    """Verify downstream client disconnect causes app server to close upstream connection.

    Upstream observes BrokenPipeError or ConnectionResetError on its subsequent write/flush,
    ensuring no stale generation proxy resources remain running indefinitely.
    """
    upstream_srv, upstream_url = dummy_upstream
    upstream_srv.hold_second_chunk = True

    server = make_server(port=0, api_url=upstream_url)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)
        req_body = json.dumps({"stream": True, "prompt": "Disconnect test"}).encode("utf-8")
        conn.request("POST", "/v1/completions", body=req_body, headers={"Content-Type": "application/json"})

        resp = conn.getresponse()
        first_chunk = resp.read1(1024)
        assert b"hello" in first_chunk

        # Ensure upstream has emitted first chunk and is held before second chunk write
        assert upstream_srv.first_chunk_event.wait(timeout=2.0)
        assert upstream_srv.second_chunk_held_event.wait(timeout=2.0)

        # Abort downstream client connection (real browser-equivalent TCP disconnect)
        client_sock = getattr(conn, "sock", None)
        if client_sock:
            try:
                client_sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            except Exception:
                pass
            try:
                client_sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
        resp.close()
        conn.close()

        # Prove upstream connection was cleanly torn down by proxy even before releasing the held upstream
        up_sock = upstream_srv.active_client_sock
        assert up_sock is not None
        # Select on upstream socket to verify proxy has closed/reset it
        r, _, _ = select.select([up_sock], [], [], 2.0)
        assert up_sock in r
        try:
            peek = up_sock.recv(1, socket.MSG_PEEK)
            assert peek == b""
        except (ConnectionResetError, BrokenPipeError):
            pass

        # Release held upstream to attempt subsequent write and confirm cancellation
        upstream_srv.resume_second_chunk_event.set()
        assert upstream_srv.completion_event.wait(timeout=2.0)

        # Upstream encountered connection error when attempting next write
        assert upstream_srv.write_error in ("BrokenPipeError", "ConnectionResetError")
    finally:
        server.shutdown()
        server.server_close()


def test_upstream_reset_terminates_downstream_sse_stream(dummy_upstream):
    """Verify an upstream reset mid-stream ends the downstream SSE response promptly.

    The client keeps the chunks already forwarded and sees EOF without `[DONE]`, which the
    browser generation client reports as a truncated (failed) stream.
    """
    upstream_srv, upstream_url = dummy_upstream
    upstream_srv.reset_after_first_chunk = True
    # Hold the reset until the client has the first chunk: on Windows an RST discards
    # received-but-unread bytes, so resetting immediately could drop the first chunk.
    upstream_srv.hold_second_chunk = True

    server = make_server(port=0, api_url=upstream_url)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5.0)
        req_body = json.dumps({"stream": True, "prompt": "Reset test"}).encode("utf-8")
        conn.request("POST", "/v1/completions", body=req_body, headers={"Content-Type": "application/json"})

        resp = conn.getresponse()
        assert resp.status == 200
        assert "text/event-stream" in resp.getheader("Content-Type")

        first_chunk = resp.read1(1024)
        assert b"hello" in first_chunk
        assert upstream_srv.second_chunk_held_event.wait(timeout=2.0)

        # Model process dies: upstream resets the connection instead of sending more chunks
        t0 = time.time()
        upstream_srv.resume_second_chunk_event.set()
        rest = resp.read()
        elapsed = time.time() - t0
        conn.close()

        assert elapsed < 2.0
        assert b"[DONE]" not in first_chunk + rest
    finally:
        server.shutdown()
        server.server_close()


def test_upstream_unavailable_returns_safe_503():
    """Verify structured JSON 503 is returned when upstream model server is down."""
    # Bind an unused loopback port
    probe_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe_sock.bind(("127.0.0.1", 0))
    dead_port = probe_sock.getsockname()[1]
    probe_sock.close()

    server = make_server(port=0, api_url=f"http://127.0.0.1:{dead_port}")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        conn.request("GET", "/health")
        resp = conn.getresponse()
        assert resp.status == 503
        assert "application/json" in resp.getheader("Content-Type")

        data = json.loads(resp.read().decode("utf-8"))
        assert "error" in data
        assert data["error"]["type"] == "service_unavailable"
        # Ensure no traceback or internal path leaked
        assert "Traceback" not in data["error"]["message"]
        assert "/" not in data["error"]["message"]

        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def test_invalid_methods_and_routes():
    """Verify rejected routes and methods return structured JSON errors."""
    server = make_server(port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        # POST /health -> 405 Method Not Allowed
        conn.request("POST", "/health", body=b"{}", headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        assert resp.status == 405
        assert "application/json" in resp.getheader("Content-Type")
        resp.read()

        # GET /v1/completions -> 405 Method Not Allowed
        conn.request("GET", "/v1/completions")
        resp = conn.getresponse()
        assert resp.status == 405
        assert "application/json" in resp.getheader("Content-Type")
        resp.read()

        # POST to unknown route -> 404 Not Found
        conn.request("POST", "/v1/unknown_route", body=b"{}", headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        assert resp.status == 404
        assert "application/json" in resp.getheader("Content-Type")
        resp.read()

        # POST missing Content-Length
        # Using raw socket to send POST without Content-Length
        raw_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        raw_sock.connect(("127.0.0.1", port))
        raw_sock.sendall(b"POST /v1/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        response_bytes = raw_sock.recv(4096)
        raw_sock.close()
        assert b"411 Length Required" in response_bytes or b"411" in response_bytes

        # POST exceeding MAX_REQUEST_BODY_SIZE -> 413
        oversized_len = MAX_REQUEST_BODY_SIZE + 100
        conn.request("POST", "/v1/completions", headers={"Content-Length": str(oversized_len)})
        resp = conn.getresponse()
        assert resp.status == 413
        assert "application/json" in resp.getheader("Content-Type")
        resp.read()

        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def _free_port() -> int:
    """Return an available port on 127.0.0.1."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


_GATED_HEALTH_SERVER = textwrap.dedent("""
    import http.server
    import json
    import os
    import sys
    import time

    port = int(sys.argv[1])
    gate = sys.argv[2]
    deadline = time.monotonic() + 30.0

    while not os.path.exists(gate):
        if time.monotonic() > deadline:
            sys.exit(2)
        time.sleep(0.02)

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def do_GET(self):
            if self.path == "/health":
                body = json.dumps({"status": "ok", "model": "fake", "note": "n"}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_error(404)

    http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
""")


def test_launcher_reports_loading_then_ready_with_checkpoint(tmp_path):
    """Verify proxy reports model_loading 503 until child is ready, then adds checkpoint identity."""
    ckpt = tmp_path / "fake-model.pt"
    payload = b"flybrain-checkpoint" * 4096
    ckpt.write_bytes(payload)
    gate = tmp_path / "gate"
    port = _free_port()
    mp = ModelProcess(
        [sys.executable, "-c", _GATED_HEALTH_SERVER, str(port), str(gate)],
        cwd=tmp_path,
        ckpt_path=ckpt,
    )
    server = make_server(port=0, api_url=f"http://127.0.0.1:{port}", model_process=mp)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    app_port = server.server_address[1]

    try:
        mp.start()
        # Assert GET /health -> 503, JSON error.type == "model_loading"
        conn = http.client.HTTPConnection("127.0.0.1", app_port, timeout=10)
        conn.request("GET", "/health")
        resp = conn.getresponse()
        assert resp.status == 503
        data = json.loads(resp.read().decode("utf-8"))
        assert data["error"]["type"] == "model_loading"
        assert data["error"]["message"] == "The model server is still loading its checkpoint."
        conn.close()

        # Assert POST /v1/completions -> 503 model_loading
        conn = http.client.HTTPConnection("127.0.0.1", app_port, timeout=10)
        conn.request(
            "POST",
            "/v1/completions",
            body=json.dumps({"prompt": "hi", "stream": True}),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        assert resp.status == 503
        data = json.loads(resp.read().decode("utf-8"))
        assert data["error"]["type"] == "model_loading"
        conn.close()

        # Release gate and poll GET /health
        gate.write_text("go")
        deadline = time.monotonic() + 10.0
        resp_data = None
        raw_text = ""
        while time.monotonic() < deadline:
            try:
                poll_conn = http.client.HTTPConnection("127.0.0.1", app_port, timeout=10)
                poll_conn.request("GET", "/health")
                poll_resp = poll_conn.getresponse()
                raw = poll_resp.read().decode("utf-8")
                poll_conn.close()
                if poll_resp.status == 200:
                    parsed = json.loads(raw)
                    if "checkpoint" in parsed:
                        raw_text = raw
                        resp_data = parsed
                        break
            except Exception:
                pass
            time.sleep(0.1)

        assert resp_data is not None, "Timed out waiting for 200 with checkpoint from /health"
        assert resp_data["status"] == "ok"
        assert resp_data["model"] == "fake"
        assert resp_data["checkpoint"] == {
            "name": "fake-model.pt",
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        assert str(tmp_path) not in raw_text
    finally:
        server.shutdown()
        server.server_close()
        mp.stop()


def test_launcher_reports_model_exited(tmp_path):
    """Verify proxy returns model_exited 503 with exit code if child terminates prematurely."""
    ckpt = tmp_path / "model.pt"
    ckpt.write_bytes(b"dummy")
    port = _free_port()
    mp = ModelProcess(
        [sys.executable, "-c", "import sys; sys.exit(3)"],
        cwd=tmp_path,
        ckpt_path=ckpt,
    )
    server = make_server(port=0, api_url=f"http://127.0.0.1:{port}", model_process=mp)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    app_port = server.server_address[1]

    try:
        mp.start()
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            if mp.poll() is not None:
                break
            time.sleep(0.05)
        assert mp.poll() is not None

        conn = http.client.HTTPConnection("127.0.0.1", app_port, timeout=10)
        conn.request("GET", "/health")
        resp = conn.getresponse()
        assert resp.status == 503
        data = json.loads(resp.read().decode("utf-8"))
        conn.close()

        assert data["error"]["type"] == "model_exited"
        message = data["error"]["message"]
        assert "code 3" in message
        assert "/" not in message
        assert "\\" not in message
    finally:
        server.shutdown()
        server.server_close()
        mp.stop()


def test_model_process_stop_terminates_child(tmp_path):
    """Verify ModelProcess.stop() cleanly terminates running process and is idempotent."""
    ckpt = tmp_path / "model.pt"
    raw_bytes = b"model-bytes-for-stop"
    ckpt.write_bytes(raw_bytes)
    mp = ModelProcess(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        cwd=tmp_path,
        ckpt_path=ckpt,
    )
    try:
        mp.start()
        assert mp.poll() is None
        mp.stop(timeout=5.0)
        assert mp.poll() is not None
        mp.stop()

        deadline = time.monotonic() + 5.0
        info = None
        while time.monotonic() < deadline:
            info = mp.checkpoint_info()
            if info is not None:
                break
            time.sleep(0.05)
        assert info == {
            "name": ckpt.name,
            "sha256": hashlib.sha256(raw_bytes).hexdigest(),
        }
    finally:
        mp.stop()
