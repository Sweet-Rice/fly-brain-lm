"""TinyStories -> GPT-2 BPE -> data/train.bin, data/val.bin. Run from the repo root: python -m data.prepare_data"""
import os
from datasets import load_dataset
from data.data import write_bin


os.makedirs("data", exist_ok=True)
ds = load_dataset("roneneldan/TinyStories")
for split, name in [("train", "train"), ("validation", "val")]:
    batches = (b["text"] for b in ds[split].iter(batch_size=10_000))
    n = write_bin(f"data/{name}.bin", batches)
    print(f"{split}: {len(ds[split])} stories, {n} tokens")

