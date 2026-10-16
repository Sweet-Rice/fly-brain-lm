"""Print the model's visualization stream in readable form (a debugging viewer, not the harness).

Shows exactly what the harness builds its map from. For the `mapping`: every neuron type (group), the
connection count between each pair of types, then every node with its type and its connections
(<- the nodes it receives from, -> the nodes it sends to). For each `fire`: how many connections fired,
broken down by type pair.

Usage (from the repo root):
        python -m harness.watch_stream                  # live: connect to ws://127.0.0.1:8765/stream
        python -m harness.watch_stream story.ndjson     # read a recording file instead
        python -m harness.watch_stream --brief          # skip the per-node list
"""
import argparse
import json
import sys
import time
from collections import Counter, defaultdict


class Viewer:
    def __init__(self, brief=False):
        self.brief = brief
        self.group = {}                                   # group id -> neuron type name
        self.node_group = {}                              # node id -> group id

    def show(self, m):
        if m.get("type") == "mapping":
            self.mapping(m)
        elif m.get("type") == "fire":
            self.fire(m)

    def by_type(self, pairs):
        counts = Counter((self.node_group[s], self.node_group[d]) for s, d in pairs)
        return [(self.group[a], self.group[b], n) for (a, b), n in sorted(counts.items())]

    def mapping(self, m):
        self.group = {g["id"]: g["name"] for g in m["groups"]}
        self.node_group = {n["id"]: n["group"] for n in m["nodes"]}
        print(f"MAPPING v{m['version']}  {len(self.group)} neuron types, {len(m['nodes'])} nodes, "
              f"{len(m['edges'])} connections")
        sizes = Counter(self.node_group.values())
        print("NEURON TYPES  (group id, name, nodes)")
        for gid, name in self.group.items():
            print(f"  {gid:>3}  {name:<26} {sizes[gid]:>5}")
        print("CONNECTIONS BY TYPE")
        for a, b, n in self.by_type(m["edges"]):
            print(f"  {a:<24} -> {b:<24} {n:>6}")
        if self.brief:
            return
        ins, outs = defaultdict(list), defaultdict(list)
        for s, d in m["edges"]:
            outs[s].append(d)
            ins[d].append(s)
        print("NODES  (id, type, <- inputs, -> outputs)")
        for n in m["nodes"]:
            i = n["id"]
            line = f"  {i:>5}  {self.group[n['group']]:<24}"
            if ins[i]:
                line += f"  <- {len(ins[i])}: {' '.join(map(str, ins[i]))}"
            if outs[i]:
                line += f"  -> {len(outs[i])}: {' '.join(map(str, outs[i]))}"
            print(line)

    def fire(self, m):
        pairs = m["pairs"]
        detail = ", ".join(f"{a}->{b} {n}" for a, b, n in self.by_type(pairs)) if self.node_group else ""
        print(f"FIRE  t={m['t']:<4} {len(pairs):>5} connections fired  {detail}")


def live(url, viewer):
    from websockets.exceptions import ConnectionClosed
    from websockets.sync.client import connect
    for _ in range(600):                                  # retry for up to 60 s until the model is up
        try:
            ws = connect(url, max_size=None)
            break
        except OSError:
            time.sleep(0.1)
    else:
        sys.exit(f"nothing listening at {url}; start the model first")
    print(f"connected to {url}")
    try:
        for raw in ws:
            viewer.show(json.loads(raw))
    except ConnectionClosed:
        pass
    print("stream closed")


def main():
    p = argparse.ArgumentParser(description="Print the visualization stream (live or a recording).")
    p.add_argument("source", nargs="?", default="ws://127.0.0.1:8765/stream", help="ws:// URL or .ndjson recording")
    p.add_argument("--brief", action="store_true", help="neuron types and connection counts only, no per-node list")
    a = p.parse_args()
    viewer = Viewer(a.brief)
    if a.source.startswith("ws://"):
        live(a.source, viewer)
    else:
        with open(a.source) as f:
            for line in f:
                viewer.show(json.loads(line))


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):           # output piped into head, or Ctrl-C
        sys.exit(0)
