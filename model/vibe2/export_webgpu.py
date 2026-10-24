"""Export a trained vibe2 checkpoint and CPU parity vectors for the WebGPU runtime."""
import argparse
import base64
import hashlib
import json
from pathlib import Path

import tiktoken
import torch
import torch.nn.functional as F

from model.model import load_checkpoint

TOKENIZER_CASES = [
    "Once upon a time", "Hello, world!", "  two  spaces\nnew line\t tab",
    "they're we've I'll it's", "numbers 12345 and 3.14", "naïve café 日本語 🧠🪰", "",
]


def _sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


@torch.no_grad()
def export(model, wiring, ck, out_dir, model_id, ckpt_path):
    if ck.get("impl") != "vibe2":
        raise ValueError("impl must be vibe2")
    cfg = model.cfg
    if cfg.n_kc > 2048:
        raise ValueError("n_kc must be <= 2048")
    lobes, offset = [], 0
    for lobe in range(3):
        count = int((wiring.kc_class == lobe).sum())
        expected = torch.arange(offset, offset + count)
        for b, block in enumerate(model.blocks):
            if not torch.equal(getattr(block.mixer, f"lobe{lobe}").cpu(), expected):
                raise ValueError(f"blocks.{b}.mixer.lobe{lobe} must be contiguous in lobe order")
        lobes.append(dict(offset=offset, count=count))
        offset += count
    if offset != cfg.n_kc:
        raise ValueError("lobes must partition n_kc")
    for b, block in enumerate(model.blocks):
        if not block.mixer.addr.mask.any(-1).all():
            raise ValueError(f"blocks.{b}.mixer.addr.mask has a KC row without wires")

    tensors = [("embed.weight", model.embed.weight), ("norm_f.weight", model.norm_f.weight)]
    for b, block in enumerate(model.blocks):
        m, prefix = block.mixer, f"blocks.{b}."
        a = m.addr
        w = a.mask * F.softplus(a.theta)
        w = w / w.norm(dim=-1, keepdim=True)
        tensors.extend((prefix + name, value) for name, value in [
            ("norm.weight", block.norm.weight),
            ("mixer.W_v.weight", m.W_v.weight), ("mixer.W_z.weight", m.W_z.weight),
            ("mixer.conv.weight", m.conv.weight.squeeze(1)), ("mixer.conv.bias", m.conv.bias),
            ("mixer.addr.receptors.weight", a.receptors.weight),
            ("mixer.addr.receptors.bias", a.receptors.bias),
            ("mixer.addr.glom_scale", torch.stack([F.softplus(a.sigma_raw), F.softplus(a.m_raw)])),
            ("mixer.addr.wiring", w),
            ("mixer.dopamine.linear.weight", m.dopamine.linear.weight),
            ("mixer.dopamine.linear.bias", m.dopamine.linear.bias),
            ("mixer.cap", m.cap), ("mixer.recovery", m.recovery()), ("mixer.D", m.D),
            ("mixer.out_norm.weight", m.out_norm.weight), ("mixer.out_proj.weight", m.out_proj.weight),
        ])
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    entries = []
    with (out / "weights.bin").open("wb") as f:
        for name, tensor in tensors:
            f.write(bytes((-f.tell()) % 256))
            entries.append(dict(name=name, offset=f.tell(), shape=list(tensor.shape)))
            f.write(tensor.detach().float().cpu().contiguous().numpy().astype("<f4").tobytes())
    note = "Checkpoint metadata not reported"
    if "source_step" in ck and "source_best_val_loss" in ck:
        note = f"Trained checkpoint, step {ck['source_step']}, validation loss {ck['source_best_val_loss']:.4f}"
    config = {key: getattr(cfg, key) for key in (
        "vocab_size", "d_model", "n_layer", "n_glom", "n_kc", "top_k", "heads_per_lobe", "d_head", "conv_k")}
    config.update(ctx=256, eot=50256)
    manifest = dict(
        format="flybrain-vibe2-webgpu", version=1, model_id=model_id, impl="vibe2", note=note,
        checkpoint=dict(name=Path(ckpt_path).name, sha256=_sha(ckpt_path)), config=config, lobes=lobes,
        weights=dict(file="weights.bin", bytes=(out / "weights.bin").stat().st_size,
                     sha256=_sha(out / "weights.bin")), tensors=entries,
        mapping_mask=[row.nonzero().flatten().tolist() for row in model.blocks[0].mixer.addr.mask.cpu()],
    )
    enc = tiktoken.get_encoding("gpt2")
    tokenizer = dict(format="gpt2-bpe", version=1, eot=50256,
                     tokens=[base64.b64encode(enc.decode_single_token_bytes(i)).decode("ascii") for i in range(50256)])
    prompt = "Once upon a time"
    prompt_ids = enc.encode_ordinary(prompt)
    steps, captured = [], {}

    def hook(a, inputs, output):
        r = F.softplus(a.receptors(inputs[0]))
        glom = r / (F.softplus(a.sigma_raw) + F.softplus(a.m_raw) * r.mean(-1, keepdim=True))
        glom = glom - glom.mean(-1, keepdim=True)
        w = a.mask * F.softplus(a.theta)
        w = w / w.norm(dim=-1, keepdim=True)
        drive = F.relu(glom @ w.mT).flatten().sort(descending=True).values
        captured.update(active_kcs=(output.flatten() > 0).nonzero().flatten().tolist(),
                        kc_margin=float(drive[cfg.top_k - 1] - drive[cfg.top_k]))

    model.eval()
    handle = model.kc_code_module(0).register_forward_hook(hook)
    try:
        state = model.init_state(1, model.embed.weight.device)
        greedy = []
        inputs = list(prompt_ids)
        for i in range(len(prompt_ids) + 31):
            tok = inputs[i] if i < len(prompt_ids) else greedy[-1]
            logits, state = model.step(torch.tensor([tok], device=model.embed.weight.device), state)
            values, ids = logits[0].topk(10)
            steps.append(dict(token_id=tok, **captured,
                              top_logits=[[int(idx), float(v)] for idx, v in zip(ids, values)],
                              argmax=int(logits[0].argmax())))
            if i >= len(prompt_ids) - 1:
                greedy.append(int(logits[0].argmax()))
    finally:
        handle.remove()
    golden = dict(format="flybrain-vibe2-golden", version=1,
                  tokenizer_cases=[dict(text=text, ids=enc.encode_ordinary(text)) for text in TOKENIZER_CASES],
                  prompt=prompt, prompt_ids=prompt_ids, greedy_ids=greedy, steps=steps)
    for name, value in [("manifest.json", manifest), ("tokenizer.json", tokenizer), ("golden.json", golden)]:
        (out / name).write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ckpt", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--model-id", default="vibe2-tinystories")
    args = parser.parse_args()
    model, wiring, ck = load_checkpoint(args.ckpt)
    manifest = export(model, wiring, ck, args.out, args.model_id, args.ckpt)
    for name in ("weights.bin", "manifest.json", "tokenizer.json", "golden.json"):
        print(f"{name}: {(args.out / name).stat().st_size:,} bytes")
    print(f"weights.sha256: {manifest['weights']['sha256']}")


if __name__ == "__main__":
    main()
