"""FlyBrain WebGPU Application Server and OpenAI-compatible Model Proxy.

This module provides a no-build, stdlib-only HTTP server combining:
1. Static asset serving for the harness/ directory (WebGPU visualization harness,
   recordings, protocol fixtures), confined to the harness directory without
   exposing repository secrets or permitting path traversal.
   The root path ("/" and "/app") redirects to "/app/".
2. Fixed-target reverse proxy for OpenAI-compatible model servers.
   Whitelisted routes:
     GET  /health
     GET  /v1/models
     POST /v1/completions
     POST /v1/chat/completions
   All other proxy routes or arbitrary URLs are rejected.
3. Incremental SSE (Server-Sent Events) streaming with cancellation propagation:
   When downstream clients (such as browser AbortController) disconnect, the proxy
   detects the disconnection via bounded select polling, breaks the stream, and
   immediately tears down and closes the upstream HTTP connection (resetting the socket
   via SO_LINGER where supported).
   Cancellation propagation semantics:
   Upstream generation termination is next-write best-effort: upstream computation
   completes its in-progress token step and halts upon its next socket write or flush
   when BrokenPipeError/ConnectionResetError is raised, releasing the engine lock and
   generation resources.
4. Optional model-server child launcher (--model-ckpt):
   Launches harness.telemetry.serve as an owned child, deriving stream_url from child
   arguments (default port 8765, explicit --viz-port), distinguishes model loading
   (HTTP 503 model_loading) from child exit (HTTP 503 model_exited), refuses to
   proxy an exited child's endpoint, and enriches GET /health with checkpoint identity
   ({"name": "<basename>", "sha256": "<hex>"}) without exposing full filesystem paths.

Usage:
    # Proxy-only mode with explicit visualization stream
    python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771 --viz-url ws://127.0.0.1:8765/stream

    # Single-launcher owned mode (runs harness.telemetry.serve)
    python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771 --model-ckpt <ckpt> --viz-port 8767
"""

import argparse
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import posixpath
import select
import socket
import ssl
import struct
import subprocess
import sys
import threading
from typing import Any, Dict, List, Optional, Tuple, Union
import urllib.parse

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8772
DEFAULT_VIZ_PORT = 8765
DEFAULT_API_URL = "http://127.0.0.1:8771"
MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024  # 10 MB limit on incoming JSON payloads
STREAM_SELECT_TIMEOUT = 0.25  # Bounded polling interval (seconds) for disconnect detection
REPO_ROOT = Path(__file__).resolve().parents[1]

PROXY_GET_ROUTES = frozenset({"/health", "/v1/models"})
PROXY_POST_ROUTES = frozenset({"/v1/completions", "/v1/chat/completions"})

# Ensure modern web mime types are recognized
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("text/html; charset=utf-8", ".html")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("application/x-ndjson", ".ndjson")
mimetypes.add_type("application/x-ndjson", ".jsonl")


def is_loopback_host(host: str) -> bool:
    """Return True if host is a literal loopback address or localhost."""
    cleaned = host.strip("[]").lower()
    if cleaned in ("localhost", "127.0.0.1", "::1"):
        return True
    try:
        ip = ipaddress.ip_address(cleaned)
        return ip.is_loopback
    except ValueError:
        return False


def validate_loopback_url(url: str) -> urllib.parse.SplitResult:
    """Validate that the configured API URL uses http/https and targets loopback."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Upstream API URL scheme must be http or https, got {parsed.scheme!r}")
    host = parsed.hostname or ""
    if not is_loopback_host(host):
        raise ValueError(f"Upstream API host must be literal loopback, got {host!r}")
    return parsed


def validate_loopback_ws_url(url: str) -> urllib.parse.SplitResult:
    """Validate that the configured visualization URL uses ws/wss and targets loopback."""
    if not isinstance(url, str) or not url.strip():
        raise ValueError(f"Visualization URL must be a non-empty string, got {url!r}")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("ws", "wss"):
        raise ValueError(f"Visualization URL scheme must be ws or wss, got {parsed.scheme!r}")
    host = parsed.hostname or ""
    if not is_loopback_host(host):
        raise ValueError(f"Visualization host must be literal loopback, got {host!r}")
    if parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
        raise ValueError("Visualization URLs cannot contain credentials, queries, or fragments")
    if parsed.port == 0:
        raise ValueError("Visualization port must be between 1 and 65535")
    return parsed


def check_viz_urls_agree(explicit_url: str, derived_url: str) -> None:
    """Ensure explicit visualization URL agrees with the derived child stream URL."""
    parsed_exp = validate_loopback_ws_url(explicit_url)
    parsed_der = urllib.parse.urlsplit(derived_url)
    exp_port = parsed_exp.port or (443 if parsed_exp.scheme == "wss" else 80)
    der_port = parsed_der.port or (443 if parsed_der.scheme == "wss" else 80)
    exp_host = "127.0.0.1" if parsed_exp.hostname == "localhost" else parsed_exp.hostname
    if (parsed_exp.scheme != parsed_der.scheme or exp_host != parsed_der.hostname
            or exp_port != der_port or parsed_exp.path != parsed_der.path):
        raise ValueError(
            f"Explicit --viz-url ({explicit_url}) contradicts owned model visualization stream ({derived_url})"
        )


def parse_viz_port(value: Any) -> int:
    """Parse and validate a loopback visualization port number."""
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid --viz-port: {value!r} is not an integer")
    if not (1 <= port <= 65535):
        raise ValueError(f"Invalid --viz-port: {port} is out of range 1-65535")
    return port




def resolve_owned_binding(
    ckpt_path: Path,
    api_url: str,
    viz_url: Optional[str] = None,
    viz_port: Optional[int] = None,
    model_id: Optional[str] = None,
    record: Optional[str] = None,
    model_args: Optional[List[str]] = None,
) -> Tuple["ModelProcess", str]:
    """Resolve child process arguments and visualization stream URL for owned launch.

    Runs harness.telemetry.serve as child process, deriving manifest stream_url
    from child arguments and validating consistency.
    """
    ckpt_path = Path(ckpt_path).expanduser().resolve()
    if not ckpt_path.is_file():
        raise ValueError(f"checkpoint not found: {ckpt_path.name}")

    parsed_api = validate_loopback_url(api_url)
    if (parsed_api.scheme != "http" or parsed_api.path not in ("", "/")
            or parsed_api.username is not None or parsed_api.password is not None
            or parsed_api.query or parsed_api.fragment):
        raise ValueError("Owned model API URL must be a plain HTTP loopback origin")
    api_host = parsed_api.hostname or "127.0.0.1"
    api_port = parsed_api.port or 80

    model_args = model_args or []
    owned_flags = {"--ckpt", "--host", "--port", "--viz-port", "--model-id", "--record", "--no-viz"}
    for arg in model_args:
        if arg.partition("=")[0] in owned_flags:
            raise ValueError(f"App-owned model option cannot be overridden with --model-arg: {arg.partition('=')[0]}")
    resolved_viz_port = parse_viz_port(viz_port if viz_port is not None else DEFAULT_VIZ_PORT)

    derived_viz_url = f"ws://127.0.0.1:{resolved_viz_port}/stream"

    # Check for contradictory independent --viz-url
    if viz_url is not None:
        check_viz_urls_agree(viz_url, derived_viz_url)

    child_argv = [
        sys.executable,
        "-m",
        "harness.telemetry.serve",
        "--ckpt",
        str(ckpt_path),
        "--host",
        api_host,
        "--port",
        str(api_port),
        "--viz-port",
        str(resolved_viz_port),
    ]
    if model_id is not None:
        child_argv.extend(["--model-id", model_id])
    if record is not None:
        child_argv.extend(["--record", record])
    child_argv.extend(model_args)

    model_proc = ModelProcess(
        child_argv,
        cwd=REPO_ROOT,
        ckpt_path=ckpt_path,
        viz_url=derived_viz_url,
    )
    return model_proc, derived_viz_url


def resolve_static_asset(requested_path: str, assets_dir: Path) -> Optional[Path]:
    """Safely resolve a requested URL path within assets_dir.

    Enforces confinement:
    - Never serves files outside assets_dir (traversal prevention).
    - Never serves hidden files/directories (starting with '.') or __pycache__.
    - Maps directory paths to index.html if present.
    Returns resolved Path if a regular file exists and is allowed, else None.
    """
    parsed_path = urllib.parse.urlsplit(requested_path).path
    unquoted = urllib.parse.unquote(parsed_path)
    rel_path = unquoted.lstrip("/")

    # Normalize POSIX path to eliminate redundant slashes and dots
    norm = posixpath.normpath(rel_path)
    if norm.startswith("..") or "/../" in norm:
        return None

    parts = norm.split("/")
    if any(part.startswith(".") or part == "__pycache__" for part in parts if part):
        return None

    try:
        target = (assets_dir / norm).resolve()
    except (ValueError, OSError):
        return None

    # Verify confinement within assets_dir
    try:
        rel_to_base = target.relative_to(assets_dir)
    except ValueError:
        return None

    if any(part.startswith(".") or part == "__pycache__" for part in rel_to_base.parts):
        return None

    if target.is_dir():
        index_file = target / "index.html"
        try:
            resolved_index = index_file.resolve()
        except (ValueError, OSError):
            return None
        try:
            rel_index = resolved_index.relative_to(assets_dir)
        except ValueError:
            return None
        if any(part.startswith(".") or part == "__pycache__" for part in rel_index.parts):
            return None
        if resolved_index.is_file():
            return resolved_index
        return None
    if target.is_file():
        return target

    return None


def _with_checkpoint(body: bytes, checkpoint: Dict[str, str]) -> bytes:
    """Return a /health JSON object body with launcher checkpoint identity added.

    Non-JSON or non-object bodies are returned unchanged.
    """
    try:
        data = json.loads(body)
    except ValueError:
        return body
    if not isinstance(data, dict):
        return body
    data["checkpoint"] = checkpoint
    return json.dumps(data).encode("utf-8")


class ModelProcess:
    """Optional model-server child process launched by --model-ckpt.

    Allows the proxy to distinguish between model loading and premature exit,
    and reports checkpoint identity (name and sha256) via GET /health.
    """

    def __init__(
        self,
        argv: List[str],
        cwd: Path,
        ckpt_path: Path,
        viz_url: Optional[str] = None,
    ) -> None:
        self.argv = list(argv)
        self.cwd = Path(cwd)
        self.ckpt_path = Path(ckpt_path)
        self.viz_url = viz_url
        self._proc: Optional[subprocess.Popen] = None
        self._checkpoint: Optional[Dict[str, str]] = None
    def start(self) -> None:
        self._proc = subprocess.Popen(self.argv, cwd=str(self.cwd))
        thread = threading.Thread(target=self._hash_checkpoint, name="checkpoint-sha256", daemon=True)
        thread.start()

    def _hash_checkpoint(self) -> None:
        digest = hashlib.sha256()
        try:
            with open(self.ckpt_path, "rb") as f:
                while chunk := f.read(1024 * 1024):
                    digest.update(chunk)
        except OSError:
            return
        self._checkpoint = {"name": self.ckpt_path.name, "sha256": digest.hexdigest()}

    def poll(self) -> Optional[int]:
        if self._proc is None:
            return None
        return self._proc.poll()

    @property
    def pid(self) -> Optional[int]:
        if self._proc is None:
            return None
        return self._proc.pid

    def checkpoint_info(self) -> Optional[Dict[str, str]]:
        if self._checkpoint is None:
            return None
        return dict(self._checkpoint)

    def stop(self, timeout: float = 10.0) -> None:
        if self._proc is None or self.poll() is not None:
            return
        try:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()
        except OSError:
            pass


class AppHTTPServer(ThreadingHTTPServer):
    """Threading HTTP server carrying configured upstream API URL, assets directory, and optional model launcher."""

    daemon_threads = True

    def __init__(
        self,
        server_address: Tuple[str, int],
        RequestHandlerClass: type,
        api_url: str,
        assets_dir: Path,
        model_process: Optional[ModelProcess] = None,
        viz_url: Optional[str] = None,
    ):
        super().__init__(server_address, RequestHandlerClass)
        self.api_url = api_url
        self.parsed_api_url = validate_loopback_url(api_url)
        self.assets_dir = assets_dir.resolve()
        self.model_process = model_process
        if viz_url is not None:
            validate_loopback_ws_url(viz_url)
        self.viz_url = viz_url

class AppRequestHandler(BaseHTTPRequestHandler):
    """HTTP request handler for static harness assets and proxied model API routes."""

    server_version = "FlyBrainAppServer/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        """Concise server logging without logging sensitive headers or payload bodies."""
        sys.stderr.write(f"[app_server] {self.address_string()} {fmt % args}\n")

    def _send_json(self, code: int, obj: dict, headers: Optional[Dict[str, str]] = None) -> None:
        """Send a structured JSON response."""
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _send_json_error(self, code: int, msg: str, error_type: str = "invalid_request_error") -> None:
        """Send a standard JSON error response conforming to OpenAI error conventions."""
        self._send_json(code, {"error": {"message": msg, "type": error_type}})

    def send_error(self, code: int, message: Optional[str] = None, explain: Optional[str] = None) -> None:
        """Override default HTML error handler to guarantee safe JSON responses."""
        self._send_json_error(code, message or "Error", "invalid_request_error")

    def do_HEAD(self) -> None:
        """Handle HEAD requests for static assets."""
        self._handle_static_or_redirect(send_body=False)

    def do_GET(self) -> None:
        """Route GET requests: whitelisted model proxy routes or static assets."""
        url_split = urllib.parse.urlsplit(self.path)
        norm_path = posixpath.normpath(url_split.path.rstrip("/"))

        if norm_path == "/stream":
            self._proxy_stream()
            return

        if norm_path in PROXY_GET_ROUTES:
            self._proxy_request(norm_path, url_split.query)
            return

        if norm_path in PROXY_POST_ROUTES:
            self._send_json_error(405, f"Method GET not allowed for {norm_path}", "invalid_request_error")
            return

        self._handle_static_or_redirect(send_body=True)

    def do_POST(self) -> None:
        """Route POST requests: whitelisted model proxy routes only."""
        url_split = urllib.parse.urlsplit(self.path)
        norm_path = posixpath.normpath(url_split.path.rstrip("/"))

        if norm_path in PROXY_POST_ROUTES:
            self._proxy_request(norm_path, url_split.query)
            return

        if norm_path in PROXY_GET_ROUTES:
            self._send_json_error(405, f"Method POST not allowed for {norm_path}", "invalid_request_error")
            return

        self._send_json_error(404, f"No route {self.path}", "invalid_request_error")

    def _handle_static_or_redirect(self, send_body: bool = True) -> None:
        """Serve static assets or redirect root to /app/."""
        url_split = urllib.parse.urlsplit(self.path)
        raw_path = url_split.path

        # Root and /app redirect to /app/
        if raw_path in ("/", "/app"):
            self.send_response(307)
            self.send_header("Location", "/app/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        asset = resolve_static_asset(raw_path, self.server.assets_dir)
        if asset is None:
            self._send_json_error(404, "Asset not found", "not_found")
            return

        # Ensure directory URLs without trailing slash redirect to trailing slash
        check_path = self.server.assets_dir / raw_path.lstrip("/")
        if check_path.is_dir() and not raw_path.endswith("/"):
            self.send_response(307)
            self.send_header("Location", raw_path + "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        content_type, _ = mimetypes.guess_type(str(asset))
        content_type = content_type or "application/octet-stream"

        try:
            size = asset.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.end_headers()
            if send_body:
                with open(asset, "rb") as f:
                    while chunk := f.read(65536):
                        self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _proxy_stream(self) -> None:
        """Tunnel the fixed loopback graph stream through the app's origin."""
        self.close_connection = True
        model_process = self.server.model_process
        if model_process is not None and (code := model_process.poll()) is not None:
            self._send_json_error(503, f"The model server process exited with code {code}.", "model_exited")
            return
        if self.server.viz_url is None:
            self._send_json_error(503, "No model stream is configured.", "stream_unavailable")
            return
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self._send_json_error(400, "A WebSocket upgrade is required.")
            return

        target = urllib.parse.urlsplit(self.server.viz_url)
        connection_class = http.client.HTTPSConnection if target.scheme == "wss" else http.client.HTTPConnection
        conn = connection_class(target.hostname, target.port or (443 if target.scheme == "wss" else 80), timeout=10)
        response_started = False
        try:
            headers = {"Connection": "Upgrade", "Upgrade": "websocket"}
            for name in ("Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version",
                         "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions"):
                if value := self.headers.get(name):
                    headers[name] = value
            conn.request("GET", target.path or "/", headers=headers)
            upstream = conn.sock
            self.connection.settimeout(10)
            sockets = (self.connection, upstream)
            # Relay the handshake and frames together: an HTTP response parser
            # could buffer and strand the mapping sent immediately after 101.
            while True:
                readable = [sock for sock in sockets if isinstance(sock, ssl.SSLSocket) and sock.pending()]
                if not readable:
                    readable = select.select(sockets, [], [])[0]
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    if source is upstream:
                        response_started = True
                        self.connection.sendall(data)
                    else:
                        upstream.sendall(data)
        except (OSError, http.client.HTTPException):
            if not response_started:
                self._send_json_error(503, "The model stream is unavailable.", "stream_unavailable")
        finally:
            conn.close()

    def _proxy_request(self, norm_path: str, query: str) -> None:
        """Proxy a whitelisted request to the fixed upstream loopback API."""
        model_process = self.server.model_process
        if model_process is not None and (code := model_process.poll()) is not None:
            self._send_json_error(503, f"The model server process exited with code {code}.", "model_exited")
            return
        body_bytes = None
        if self.command == "POST":
            content_len_hdr = self.headers.get("Content-Length")
            if content_len_hdr is None:
                self._send_json_error(411, "Length Required: Content-Length header missing")
                return
            try:
                content_len = int(content_len_hdr)
            except ValueError:
                self._send_json_error(400, "Invalid Content-Length header")
                return
            if content_len < 0:
                self._send_json_error(400, "Invalid Content-Length header")
                return
            if content_len > MAX_REQUEST_BODY_SIZE:
                self._send_json_error(413, f"Request body exceeds {MAX_REQUEST_BODY_SIZE} bytes")
                return
            try:
                body_bytes = self.rfile.read(content_len)
            except OSError:
                self._send_json_error(400, "Failed to read request body")
                return
            if len(body_bytes) != content_len:
                self._send_json_error(400, "Truncated request body")
                return

        parsed_api = self.server.parsed_api_url
        upstream_host = parsed_api.hostname or "127.0.0.1"
        upstream_port = parsed_api.port or (443 if parsed_api.scheme == "https" else 80)
        is_ssl = (parsed_api.scheme == "https")

        api_base = parsed_api.path.rstrip("/")
        upstream_path = f"{api_base}{norm_path}"
        if query:
            upstream_path += f"?{query}"

        # Selective headers forwarding: memory-only authorization, content-type, accept
        upstream_headers: Dict[str, str] = {}
        if ctype := self.headers.get("Content-Type"):
            upstream_headers["Content-Type"] = ctype
        if auth := self.headers.get("Authorization"):
            # Pass-through in memory only; never logged or persisted to disk
            upstream_headers["Authorization"] = auth
        if accept := self.headers.get("Accept"):
            upstream_headers["Accept"] = accept

        conn = None
        try:
            if is_ssl:
                conn = http.client.HTTPSConnection(upstream_host, upstream_port, timeout=60.0)
            else:
                conn = http.client.HTTPConnection(upstream_host, upstream_port, timeout=60.0)

            conn.request(self.command, upstream_path, body=body_bytes, headers=upstream_headers)
            upstream_sock = getattr(conn, "sock", None)
            resp = conn.getresponse()
        except (ConnectionRefusedError, socket.gaierror):
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass
            model_process = self.server.model_process
            if model_process is not None:
                code = model_process.poll()
                if code is None:
                    self._send_json_error(503, "The model server is still loading its checkpoint.", "model_loading")
                else:
                    self._send_json_error(503, f"The model server process exited with code {code}.", "model_exited")
                return
            self._send_json_error(503, "Upstream model server unavailable", "service_unavailable")
            return
        except (socket.timeout, TimeoutError):
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass
            self._send_json_error(504, "Upstream model server timed out", "timeout_error")
            return
        except (http.client.HTTPException, OSError):
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass
            self._send_json_error(503, "Upstream model server communication failed", "service_unavailable")
            return

        resp_status = resp.status
        resp_content_type = resp.getheader("Content-Type", "")

        if "text/event-stream" in resp_content_type:
            self._forward_sse_stream(conn, resp, upstream_sock, resp_status)
        else:
            checkpoint = None
            if norm_path == "/health" and self.server.model_process is not None:
                checkpoint = self.server.model_process.checkpoint_info()
            self._forward_nonstream_response(
                conn, resp, resp_status, resp_content_type, checkpoint=checkpoint
            )

    def _forward_nonstream_response(
        self,
        conn: http.client.HTTPConnection,
        resp: http.client.HTTPResponse,
        status: int,
        content_type: str,
        checkpoint: Optional[Dict[str, str]] = None,
    ) -> None:
        """Forward non-streaming response body and headers."""
        try:
            body = resp.read()
        except OSError:
            try:
                conn.close()
            except Exception:
                pass
            self._send_json_error(503, "Failed to read upstream response", "service_unavailable")
            return
        finally:
            try:
                resp.close()
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
        # Protect against leaking upstream HTML tracebacks or local filesystem paths
        if status >= 500 and "application/json" not in content_type:
            self._send_json_error(status, "Upstream model server error", "upstream_error")
            return

        if checkpoint is not None and status == 200:
            body = _with_checkpoint(body, checkpoint)

        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # No CORS headers are emitted (same-origin application)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _forward_sse_stream(
        self,
        conn: http.client.HTTPConnection,
        resp: http.client.HTTPResponse,
        upstream_sock: Optional[socket.socket],
        status: int,
    ) -> None:
        """Forward Server-Sent Events incrementally with browser disconnect detection.
        Cancellation propagation semantics:
        When the downstream client disconnects or aborts (e.g. AbortController), this
        handler detects downstream EOF/reset via bounded select, terminates the streaming
        loop, and immediately closes the upstream HTTP connection and socket (issuing an
        immediate RST via SO_LINGER where supported).
        Upstream generation termination is next-write best-effort: upstream computation
        completes its in-progress token step and halts upon its next socket write or flush
        when BrokenPipeError/ConnectionResetError is raised, releasing the engine generation
        lock and resources.
        Upstream failure semantics: if the upstream socket is reset or otherwise fails while
        streaming, the loop ends and the downstream response is closed without `[DONE]`, so
        the browser client reports a truncated stream instead of waiting indefinitely.
        """
        self.send_response(status)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        # No CORS headers
        self.end_headers()

        client_sock = self.connection

        if upstream_sock:
            try:
                upstream_sock.setblocking(False)
            except Exception:
                pass

        try:
            while not resp.isclosed():
                # Read buffered bytes from Python's BufferedReader first if available without blocking
                buffered = False
                if hasattr(resp, "fp") and resp.fp and not getattr(resp.fp, "closed", False):
                    try:
                        peek = resp.fp.peek(1)
                        if peek:
                            buffered = True
                    except (BlockingIOError, OSError):
                        pass

                if buffered:
                    try:
                        chunk = resp.read1(4096)
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        break
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        break
                    continue

                try:
                    r, _, _ = select.select([client_sock, upstream_sock or resp], [], [], STREAM_SELECT_TIMEOUT)
                except (ValueError, OSError):
                    break

                # Check if downstream client disconnected
                if client_sock in r:
                    client_disconnected = False
                    try:
                        peek = client_sock.recv(1, socket.MSG_PEEK)
                        if not peek:
                            client_disconnected = True
                    except (ConnectionResetError, BrokenPipeError, OSError):
                        client_disconnected = True

                    if client_disconnected:
                        break

                # Check if upstream produced data
                up_target = upstream_sock or resp
                if up_target in r:
                    try:
                        chunk = resp.read1(4096)
                    except BlockingIOError:
                        chunk = None
                    except OSError:
                        break

                    if chunk is not None:
                        if not chunk:
                            # Upstream EOF reached cleanly
                            break
                        try:
                            self.wfile.write(chunk)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError, OSError):
                            break
        finally:
            # Propagate client disconnect to upstream: reset socket and close connection
            if upstream_sock:
                try:
                    upstream_sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                except Exception:
                    pass
                try:
                    upstream_sock.shutdown(socket.SHUT_RDWR)
                except Exception:
                    pass
            try:
                resp.close()
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
            if upstream_sock:
                try:
                    upstream_sock.close()
                except Exception:
                    pass

def make_server(
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    api_url: str = DEFAULT_API_URL,
    assets_dir: Optional[Union[str, Path]] = None,
    model_process: Optional[ModelProcess] = None,
    viz_url: Optional[str] = None,
) -> AppHTTPServer:
    """Create and bind an AppHTTPServer instance.

    Parameters:
        host: Loopback host by default; "0.0.0.0" opts into network access.
        port: Port to bind (default: 8772). Passing port=0 binds an OS-assigned free port.
        api_url: Upstream model API URL (default: "http://127.0.0.1:8771"). Must be loopback.
        assets_dir: Directory containing harness assets (default: harness/ directory).
        model_process: Optional ModelProcess child instance managing upstream model server.
        viz_url: Optional loopback WebSocket URL for the visualization stream.

    Returns:
        AppHTTPServer instance ready for serve_forever().
    """
    if not (is_loopback_host(host) or host == "0.0.0.0"):
        raise ValueError(f"App server host must be literal loopback or 0.0.0.0, got {host!r}")

    validate_loopback_url(api_url)

    if viz_url is not None:
        validate_loopback_ws_url(viz_url)
    elif model_process is not None and getattr(model_process, "viz_url", None) is not None:
        viz_url = model_process.viz_url
        validate_loopback_ws_url(viz_url)

    if viz_url is not None and model_process is not None and getattr(model_process, "viz_url", None) is not None:
        check_viz_urls_agree(viz_url, model_process.viz_url)

    if assets_dir is None:
        resolved_assets = Path(__file__).resolve().parent
    else:
        resolved_assets = Path(assets_dir).resolve()

    if not resolved_assets.is_dir():
        raise ValueError(f"Assets directory does not exist: {resolved_assets}")

    return AppHTTPServer(
        (host, port),
        AppRequestHandler,
        api_url=api_url,
        assets_dir=resolved_assets,
        model_process=model_process,
        viz_url=viz_url,
    )


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(description="FlyBrain WebGPU Harness & OpenAI Model Proxy Server")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Host to bind; 0.0.0.0 exposes the app to the network (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port to bind (default: {DEFAULT_PORT})")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help=f"Upstream model API URL (default: {DEFAULT_API_URL})")
    parser.add_argument("--assets-dir", default=None, help="Directory to serve harness assets from (default: harness/)")
    parser.add_argument("--viz-url", default=None, help="Explicit visualization WebSocket URL (e.g. ws://127.0.0.1:8765/stream)")
    parser.add_argument("--model-ckpt", default=None, help="Optional checkpoint: launch python -m harness.telemetry.serve on the --api-url port and report its loading/exit state")
    parser.add_argument("--viz-port", type=int, default=None, help="Port for owned model server visualization stream (default: 8765)")
    parser.add_argument("--model-id", default=None, help="Model ID for owned model server")
    parser.add_argument("--record", default=None, help="NDJSON path to record visualization stream")
    parser.add_argument("--model-arg", action="append", default=[], metavar="ARG", help="Extra non-binding model option (repeatable, e.g. --model-arg=--device --model-arg=cpu); use app flags for checkpoint, endpoints, model ID, and recording")

    args = parser.parse_args(argv)

    model_process = None
    viz_url = args.viz_url
    try:
        if args.model_ckpt:
            model_process, viz_url = resolve_owned_binding(
                ckpt_path=Path(args.model_ckpt),
                api_url=args.api_url,
                viz_url=args.viz_url,
                viz_port=args.viz_port,
                model_id=args.model_id,
                record=args.record,
                model_args=args.model_arg,
            )
        else:
            if args.viz_port is not None:
                raise ValueError("--viz-port requires --model-ckpt")
            if args.model_id is not None:
                raise ValueError("--model-id requires --model-ckpt")
            if args.record is not None:
                raise ValueError("--record requires --model-ckpt")
            if args.model_arg:
                raise ValueError("--model-arg requires --model-ckpt")
            if viz_url is not None:
                validate_loopback_ws_url(viz_url)

        server = make_server(
            host=args.host,
            port=args.port,
            api_url=args.api_url,
            assets_dir=args.assets_dir,
            model_process=model_process,
            viz_url=viz_url,
        )
    except ValueError as e:
        sys.stderr.write(f"Error starting app server: {e}\n")
        sys.exit(1)

    bound_host, bound_port = server.server_address[:2]
    ready_url = f"http://{bound_host}:{bound_port}/app/"
    print(f"FlyBrain app server listening at {ready_url} (proxying {args.api_url})", flush=True)

    try:
        if model_process is not None:
            model_process.start()
            print(f"Launched model server for checkpoint {model_process.ckpt_path.name} (pid {model_process.pid}); /health reports model_loading until it answers", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if model_process is not None:
            model_process.stop()


if __name__ == "__main__":
    main()
