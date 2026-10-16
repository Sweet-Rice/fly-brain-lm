"""Replay a real fixed-prompt stream for harness development, without loading a model.

Default capture: "Once upon a time", block 0, 8 generated tokens, temperature 0,
top_k 50, seed 0, CPU, model/checkpoints/init.pt. See harness/API.md for regeneration.

Usage (from the repo root):
    python -m harness.replay_prompt
    python -m harness.replay_prompt another.ndjson --port 8768 --interval 0.2 --pause 2

Every connection starts at the recording's mapping, then repeats the entire recording.
JSON message text is unchanged; playback timing is synthetic, not inference timing.
"""
import argparse
import asyncio
import json
from pathlib import Path

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

DEFAULT_RECORDING = Path(__file__).with_name("example") / "once_upon_a_time.ndjson"


async def replay(conn, frames, interval, pause):
    if conn.request.path != "/stream":
        await conn.close(1008, "unknown path; use /stream")
        return
    try:
        while True:
            for raw, is_fire in frames:
                if is_fire:
                    await asyncio.sleep(interval)
                await conn.send(raw)
            await asyncio.sleep(pause)
    except ConnectionClosed:
        pass


async def run(args):
    frames = [(line, json.loads(line)["type"] == "fire")
              for line in args.recording.read_text().splitlines() if line.strip()]
    if not frames or json.loads(frames[0][0])["type"] != "mapping":
        raise ValueError("recording must start with a mapping message")

    async def handler(conn):
        await replay(conn, frames, args.interval, args.pause)

    async with serve(handler, "127.0.0.1", args.port) as server:
        port = server.sockets[0].getsockname()[1]
        print(f"replaying {args.recording} ({len(frames)} messages, "
              f"{sum(is_fire for _, is_fire in frames)} fires per loop)", flush=True)
        print(f"visualization stream: ws://127.0.0.1:{port}/stream", flush=True)
        print("Each connection starts from the beginning; Ctrl-C to stop.", flush=True)
        await asyncio.Future()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("recording", nargs="?", type=Path, default=DEFAULT_RECORDING,
                   help="NDJSON recording (default: bundled Once upon a time capture)")
    p.add_argument("--port", type=int, default=8768)
    p.add_argument("--interval", type=float, default=0.2, help="seconds before each fire")
    p.add_argument("--pause", type=float, default=2.0, help="seconds between recording loops")
    a = p.parse_args()
    if a.interval < 0 or a.pause < 0:
        p.error("--interval and --pause must be non-negative")
    try:
        asyncio.run(run(a))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
