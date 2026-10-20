"""Export one checkpoint's model topology as a v1 mapping-only NDJSON recording."""
import argparse
import json
from pathlib import Path

from harness.viz_stream import FlyGraph
from model.model import load_checkpoint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ckpt", required=True, help="checkpoint to load on CPU")
    parser.add_argument("--block", type=int, default=0, help="model block to visualize")
    parser.add_argument("--out", type=Path, required=True, help="output file; overwrites an existing file")
    args = parser.parse_args()

    model, _, _ = load_checkpoint(args.ckpt)
    graph = FlyGraph(model, args.block)
    args.out.write_text(json.dumps(graph.mapping, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {args.out}: {len(graph.mapping['nodes'])} nodes, "
          f"{len(graph.mapping['edges'])} edges (block {args.block})")


if __name__ == "__main__":
    main()
