import numpy as np, torch
from data import encode_stories, write_bin, load_bin, sample_batch, EOT

STORY = [7454, 2402, 257, 640]



def test_encode_known():
    arr = encode_stories(["Once upon a time", "Once upon a time"])
    assert arr.dtype == np.uint16
    assert arr.tolist() == (STORY + [EOT]) * 2

def test_literal_eot_text_is_not_eot():
    arr = encode_stories(["<|endoftext|>"])
    assert (arr == EOT).sum() == 1

def test_bin_roundtrip(tmp_path):
    p = tmp_path / "t.bin"
    n = write_bin(str(p), [["Once upon a time"], ["Once upon a time"]])
    assert n == 10
    assert p.stat().st_size == 20
    raw = p.read_bytes()
    assert raw[0:2] == b"\x1e\x1d"          # 7454, little-endian
    assert raw[8:10] == b"\x50\xc4"         # 50256, little-endian
    assert load_bin(str(p)).tolist() == (STORY + [EOT]) * 2

def test_sample_batch():
    data = np.array([10, 11, 12, 13, 14, 15, 16], dtype=np.uint16)
    g = torch.Generator().manual_seed(0)
    x, y = sample_batch(data, B=1000, T=3, gen=g)
    assert x.shape == (1000, 3) and y.shape == (1000, 3)
    assert x.dtype == torch.int64 and y.dtype == torch.int64
    assert torch.equal(y, x + 1)                         # consecutive data -> shift = +1
    assert set(x[:, 0].tolist()) == {10, 11, 12, 13}     # every legal start, nothing else
