"""Build the fly wiring from the downloaded MaleCNS tables. Runs offline.

Reads   data/connectome/body-annotations-male-cns-v1.0-minconf-0.5.feather  (who each neuron is)
        data/connectome/connectome-weights-male-cns-v1.0-minconf-0.5.feather (synapses per neuron pair, ~1 GB)
Writes  data/connectome/wiring.npz        mask, theta, counts, kc_class, kc_ids, glom_names
        data/connectome/pn_kc_edges.csv   every PN-like -> KC pair (small cache; re-runs skip the 1 GB file)

Default rules (project notes): right-side olfactory PNs that map to ONE glomerulus; keep a PN->KC
connection if that single PN makes >= 3 synapses onto the KC; sum per glomerulus; right-side KCs only;
drop KCs left with nothing. search_wiring_rules.py tests alternatives to these rules.

Usage:  python build_wiring.py
Later:  from build_wiring import load_wiring; w = load_wiring()   # a model.Wiring
"""
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

D = Path("data/connectome")
ANN = D / "body-annotations-male-cns-v1.0-minconf-0.5.feather"
WTS = D / "connectome-weights-male-cns-v1.0-minconf-0.5.feather"
CACHE = D / "pn_kc_edges.csv"
OUT = D / "wiring.npz"
ANN_COLS = ["bodyId", "type", "hemibrainType", "class", "somaSide", "instance", "rootSide"]
PN_NAME = r"_[A-Za-z0-9]*PN"   # glomerular-PN style names: DA1_lPN, VP1d+VP4_l2PN1, M_vPNml53


@dataclass(frozen=True)
class Rules:
    pn_set: str = "alpn_R"      # which cells are PNs: alpn_R | alpn_any | pnname_R | pnname_any
    name_col: str = "type"      # glomerulus parsed from: type | hemibrainType
    glom: str = "strict"        # strict: skip every '+' name | plus: 'VP3+_vPN' -> VP3 | first: 'VP1d+VP4' -> VP1d
    kc_side: str = "somaSide"   # 'right KC' means: somaSide | instance | rootSide | none (both sides)
    class_col: str = "type"     # KC lobe from: type | type+hemibrain (fallback for the generic 'KC')
    threshold: str = "per_pn"   # per_pn: >=3 from ONE PN (notes) | per_glom: >=3 summed per glomerulus
    min_syn: int = 3


RULES = Rules(pn_set="alpn_any")                 # change this line if search_wiring_rules.py finds an exact match
TARGET = dict(K=1889, G=55, conn=9592, cls=(663, 874, 352))   # from the project notes


def glom_of(t, mode="strict"):
    """'DA1_lPN' -> 'DA1'. None if the name is not one glomerulus (M_..., Z_..., '+' names in strict mode)."""
    if not isinstance(t, str) or "_" not in t:
        return None
    g = t.split("_")[0]
    if not g or g in ("M", "Z"):
        return None
    if "+" in g:
        parts = [p for p in g.split("+") if p]
        if mode == "plus":       # 'VP3+' (one named glomerulus + unspecified extras) -> VP3
            return parts[0] if len(parts) == 1 else None
        if mode == "first":      # 'VP1d+VP4' -> VP1d
            return parts[0]
        return None
    return g


def kc_class(t):
    """0 = gamma, 1 = alpha/beta, 2 = alpha'/beta', -1 = can't tell."""
    if not isinstance(t, str):
        return -1
    if t.startswith("KCa'b'"):
        return 2
    if t.startswith("KCab"):
        return 1
    if t.startswith("KCg"):
        return 0
    return -1


def load_ann():
    return pd.read_feather(ANN, columns=ANN_COLS).set_index("bodyId")


def get_edges(ann):
    """Every PN-like -> KC pair, either side, any weight. A superset on purpose, so trying other
    rules never needs the 1 GB file again."""
    if CACHE.exists():
        return pd.read_csv(CACHE)
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.feather as pf

    names = ann["type"].fillna("") + " " + ann["hemibrainType"].fillna("")
    is_pn = (ann["class"] == "ALPN") | names.str.contains(PN_NAME)
    is_kc = ann["type"].fillna("").str.startswith("KC") | ann["hemibrainType"].fillna("").str.startswith("KC")
    pre = pa.array(ann.index[is_pn].to_numpy(), type=pa.int64())
    post = pa.array(ann.index[is_kc].to_numpy(), type=pa.int64())
    t = pf.read_table(WTS, columns=["body_pre", "body_post", "weight"])
    t = t.filter(pc.and_(pc.is_in(t["body_pre"], value_set=pre), pc.is_in(t["body_post"], value_set=post)))
    e = t.to_pandas().groupby(["body_pre", "body_post"], as_index=False)["weight"].sum()
    e.to_csv(CACHE, index=False)
    return e


def right_kcs(ann, how):
    is_kc = ann["type"].fillna("").str.startswith("KC")
    if how == "somaSide":
        side = ann["somaSide"] == "R"
    elif how == "instance":
        side = ann["instance"].fillna("").str.endswith("_R")
    elif how == "rootSide":
        side = ann["rootSide"] == "R"
    else:
        side = pd.Series(True, index=ann.index)
    return ann.index[is_kc & side]


def build(ann, edges, r=RULES):
    """Returns (wiring arrays, diagnostics)."""
    name = ann[r.name_col].fillna("")
    is_pn = (ann["class"] == "ALPN") if r.pn_set.startswith("alpn") else name.str.contains(PN_NAME)
    if r.pn_set.endswith("_R"):
        is_pn &= ann["somaSide"] == "R"
    pn_names = name[is_pn]
    pn_glom = pn_names.map(lambda t: glom_of(t, r.glom)).dropna()

    e = edges[edges["body_pre"].isin(pn_glom.index) & edges["body_post"].isin(right_kcs(ann, r.kc_side))]
    if r.threshold == "per_pn":
        e = e[e["weight"] >= r.min_syn]
    e = e.assign(glom=e["body_pre"].map(pn_glom))
    cnt = e.groupby(["body_post", "glom"])["weight"].sum().unstack(fill_value=0)   # rows KCs, cols glomeruli
    if r.threshold == "per_glom":
        cnt = cnt.where(cnt >= r.min_syn, 0)
        cnt = cnt.loc[(cnt > 0).any(axis=1)]

    cls = ann["type"].reindex(cnt.index).map(kc_class)
    if r.class_col == "type+hemibrain":
        cls = cls.where(cls >= 0, ann["hemibrainType"].reindex(cnt.index).map(kc_class))
    cls = cls.astype(int)
    unclassified = ann["type"].reindex(cnt.index)[cls < 0]
    cnt, cls = cnt[cls >= 0], cls[cls >= 0]
    cnt = cnt.loc[:, (cnt > 0).any()]                     # drop glomeruli left with no wires

    order = pd.DataFrame({"cls": cls.to_numpy(), "id": cls.index.to_numpy()}).sort_values(["cls", "id"])
    cnt = cnt.loc[order["id"].to_numpy()]
    cnt = cnt.reindex(sorted(cnt.columns), axis=1)

    counts = cnt.to_numpy(dtype=np.float32)               # (K, G) synapse counts
    mask = counts > 0                                     # (K, G) bool
    theta = counts / counts[mask].mean() if mask.any() else counts   # (K, G) mean 1 on wires
    w = dict(counts=counts, mask=mask, theta=theta,
             kc_class=order["cls"].to_numpy(np.int64), kc_ids=order["id"].to_numpy(np.int64),
             glom_names=np.array(cnt.columns, dtype=str))
    info = dict(pn_glom=pn_glom, skipped=pn_names[~pn_names.index.isin(pn_glom.index)],
                unclassified=unclassified)
    return w, info


def stats(w):
    K, G = w["mask"].shape
    return dict(K=K, G=G, conn=int(w["mask"].sum()),
                cls=tuple(int((w["kc_class"] == i).sum()) for i in range(3)))


def main():
    ann = load_ann()
    edges = get_edges(ann)
    w, info = build(ann, edges, RULES)
    print("rules:", RULES)

    sk = edges[edges["body_pre"].isin(info["skipped"].index) & (edges["weight"] >= RULES.min_syn)
               & edges["body_post"].isin(w["kc_ids"])]
    print("\nskipped PN types with >=3-synapse connections onto kept KCs:\n",
          sk.assign(type=sk["body_pre"].map(ann["type"])).groupby("type").size()
            .sort_values(ascending=False).head(20).to_string())
    if len(info["unclassified"]):
        print("\nKCs dropped for having no class:", info["unclassified"].value_counts().to_dict())
    lost = sorted(set(info["pn_glom"]) - set(w["glom_names"]))
    print(f"\nglomeruli with PNs but no qualifying wire (dropped): {lost}")
    print(f"glomeruli kept ({len(w['glom_names'])}): {w['glom_names'].tolist()}")

    np.savez(OUT, **w)
    s, t = stats(w), TARGET
    print("\n==== SUMMARY (targets from the project notes) ====")
    print(f"KCs: {s['K']} ({t['K']})   glomeruli: {s['G']} ({t['G']})   connections: {s['conn']} ({t['conn']})   "
          f"per KC: {s['conn'] / max(s['K'], 1):.2f} (~5)")
    print(f"per class gamma / a-b / a'-b': {list(s['cls'])} ({' / '.join(map(str, t['cls']))})")
    print("kept KCs by type:", ann["type"].reindex(w["kc_ids"]).value_counts().to_dict())
    print("kept KCs by somaSide:", ann["somaSide"].reindex(w["kc_ids"]).value_counts(dropna=False).to_dict())
    print(f"\nwrote {OUT}.  Model config: Config(n_glom={s['G']}, n_kc={s['K']})")


def load_wiring(path=OUT):
    import torch
    from model import Wiring
    z = np.load(path)
    return Wiring(mask=torch.from_numpy(z["mask"]), theta=torch.from_numpy(z["theta"]).float(),
                  kc_class=torch.from_numpy(z["kc_class"]).long(),
                  kc_ids=z["kc_ids"].tolist(), glom_names=z["glom_names"].tolist())


if __name__ == "__main__":
    main()
