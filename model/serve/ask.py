"""Talk to the TEMPORARY untrained model while its brain activity streams to the visualization
harness (Fly Brain Visualization Stream Spec v1).

The stream stays up for the whole session, so the harness can connect at any time at
ws://127.0.0.1:8765/stream. Its first message is the mapping (every node and connection); then each
token of each message the model reads or writes is one `fire` listing the connections that fired.
t keeps counting across messages.

Usage (from the repo root):
        python -m model.serve.ask                              # type messages; Ctrl-D or Ctrl-C to quit
        python -m model.serve.ask "The fly said" --max-tokens 40   # first message from the command line, then keep typing
        python -m model.serve.ask --wait 30                    # wait up to 30 s for a harness before the first message
        python -m model.serve.ask --record story.ndjson        # also save the stream as a recording file
        echo "Once upon a time" | python -m model.serve.ask    # one message per input line; quits at end of input
"""
import argparse
import sys

import tiktoken
import torch

from harness.viz_stream import stream_model
from model.model import load_checkpoint

ENC = tiktoken.get_encoding("gpt2")
EOT = ENC.eot_token


def messages(first):
    """The command-line message, then one message per input line until end of input."""
    if first:
        yield first
    prompt = "> " if sys.stdin.isatty() else ""
    while True:
        try:
            line = input(prompt)
        except EOFError:
            return
        if line.strip():
            yield line


def reply(model, text, a, gen):
    """Print the model's continuation of `text`. Returns (prompt tokens, generated tokens)."""
    ids = ENC.encode_ordinary(text) or [EOT]
    print(text, end="", flush=True)
    out, shown = [], 0
    for tok in model.stream(ids, a.max_tokens, a.temperature, a.top_k, stop_ids=(EOT,), gen=gen):
        if tok == EOT:
            break
        out.append(tok)
        decoded = ENC.decode(out)
        if not decoded.endswith("�"):                  # wait for the rest of a multi-byte character
            print(decoded[shown:], end="", flush=True)
            shown = len(decoded)
    print()
    return len(ids), len(out)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("prompt", nargs="?", default=None, help="first message (default: read messages from input)")
    p.add_argument("--ckpt", default="model/checkpoints/init.pt")
    p.add_argument("--device", default="cpu")
    p.add_argument("--max-tokens", type=int, default=50)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--top-k", type=int, default=50)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--path", default="/stream")
    p.add_argument("--block", type=int, default=0, help="which of the 12 blocks to visualize")
    p.add_argument("--wait", type=float, default=0, help="seconds to wait for a harness before the first message")
    p.add_argument("--record", default=None, help="also write the stream to this .ndjson file")
    a = p.parse_args()

    model, wiring, _ = load_checkpoint(a.ckpt, a.device)
    stream, graph = stream_model(model, wiring, a.block, host=a.host, port=a.port, path=a.path, record=a.record)
    print(f"visualization stream: {stream.url}  (block {a.block}: {len(graph.mapping['nodes'])} nodes, "
          f"{len(graph.mapping['edges'])} edges)")
    if a.wait:
        print(f"waiting up to {a.wait:.0f} s for a harness...")
        print("harness connected" if stream.wait_for_harness(a.wait) else "no harness; continuing")
    if sys.stdin.isatty():
        print("type a message and press Enter; Ctrl-D to quit")

    gen = torch.Generator().manual_seed(a.seed)
    n = 0
    try:
        for text in messages(a.prompt):
            t0 = stream.t
            n_in, n_out = reply(model, text, a, gen)
            n += 1
            print(f"[{n_in} prompt + {n_out} generated tokens; steps t={t0}..{stream.t - 1}]\n")
    except KeyboardInterrupt:
        print()
    finally:
        stream.close()
    print(f"[{n} message(s); {stream.t} steps streamed; {stream.harnesses_seen} harness connection(s); "
          f"{stream.dropped} fire messages dropped" + (f"; recording: {a.record}" if a.record else "") + "]")


if __name__ == "__main__":
    main()
