"""Try every combination of plausible extraction rules and score each against the project notes'
numbers (1889 KCs, 55 glomeruli, 9592 connections, 663 / 874 / 352 per class).

Reads only the small cache (run build_wiring.py once first). Takes about a minute.

How to read the result: 5 independent numbers matching EXACTLY at once is strong evidence for a rule.
A near miss is weak evidence: with ~380 combinations, something always lands close by chance.
"""
import itertools
from collections import defaultdict

import pandas as pd

from build_wiring import RULES, TARGET, Rules, build, get_edges, load_ann, stats

GRID = dict(
    pn_set=["alpn_R", "alpn_any", "pnname_R", "pnname_any"],
    name_col=["type", "hemibrainType"],
    glom=["strict", "plus", "first"],
    kc_side=["somaSide", "instance", "rootSide", "none"],
    class_col=["type", "type+hemibrain"],
    threshold=["per_pn", "per_glom"],
)


def errors(s):
    t = TARGET
    got = [s["K"], s["G"], s["conn"], *s["cls"]]
    want = [t["K"], t["G"], t["conn"], *t["cls"]]
    return [g - w for g, w in zip(got, want)]


def main():
    ann = load_ann()
    edges = get_edges(ann)
    ann = ann[ann.index.isin(pd.concat([edges["body_pre"], edges["body_post"]]))]   # only cells that matter

    results = defaultdict(list)              # distinct outcome -> rule sets that produce it
    wirings = {}
    for combo in itertools.product(*GRID.values()):
        r = Rules(**dict(zip(GRID, combo)))
        w, _ = build(ann, edges, r)
        s = stats(w)
        key = (s["K"], s["G"], s["conn"], s["cls"])
        results[key].append(r)
        wirings.setdefault(key, w)

    rows = []
    for key, rules in results.items():
        s = dict(K=key[0], G=key[1], conn=key[2], cls=key[3])
        err = errors(s)
        rows.append((sum(e != 0 for e in err), sum(abs(e) for e in err), key, err, rules))
    rows.sort(key=lambda x: (x[0], x[1]))

    print(f"{sum(len(v) for v in results.values())} rule sets -> {len(results)} distinct outcomes")
    print(f"target: K {TARGET['K']}  G {TARGET['G']}  conn {TARGET['conn']}  classes {TARGET['cls']}\n")
    print(f"{'wrong':>5} {'|err|':>6}   {'K':>5} {'G':>3} {'conn':>6}  classes           #rules  example rule set")
    for n_wrong, tot, key, err, rules in rows[:20]:
        print(f"{n_wrong:>5} {tot:>6}   {key[0]:>5} {key[1]:>3} {key[2]:>6}  {str(key[3]):<17} {len(rules):>6}  {rules[0]}")

    base = stats(build(ann, edges, RULES)[0])
    base_key = (base["K"], base["G"], base["conn"], base["cls"])
    best = rows[0]
    print(f"\ndefault rules (notes):  {base_key}   errors {errors(base)}")
    print(f"best outcome:           {best[2]}   errors {best[3]}")
    gb, gd = set(wirings[best[2]]["glom_names"].tolist()), set(wirings[base_key]["glom_names"].tolist())
    print(f"glomeruli in best but not default: {sorted(gb - gd)}   in default but not best: {sorted(gd - gb)}")

    if best[0] == 0:
        print("\nEXACT MATCH on all numbers. Rule sets that produce it:")
        for r in best[4]:
            print("  ", r)
        print("Set RULES = <one of these> in build_wiring.py and re-run it.")
    else:
        print("\nNo exact match. Keep the default rules unless a row above matches every number.")


if __name__ == "__main__":
    main()
