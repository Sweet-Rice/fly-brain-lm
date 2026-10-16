import numpy as np
import torch
import tiktoken


ENC = tiktoken.get_encoding("gpt2")
EOT = ENC.eot_token


def encode_stories(stories: list[str]) -> np.ndarray:
    """Flat uint array of all stories, EOT after each"""
    all_ids = []
    for story in stories:
        ids = ENC.encode_ordinary(story)
        ids.append(EOT)
        all_ids.extend(ids)
    assert not all_ids or max(all_ids) < 2**16
    return np.array(all_ids, dtype=np.uint16)



def write_bin(path: str, story_batches) -> int:
    """story_batches: iterable of lists of strings. Streams to disk and returns total tokens"""
    n_tokens = 0
    with open(path, "wb") as f:
        for batch in story_batches:
            arr = encode_stories(batch)
            f.write(arr.tobytes())
            n_tokens += len(arr)
    return n_tokens

def load_bin(path: str) -> np.ndarray:
    return np.memmap(path, dtype=np.uint16, mode="r")
    

def sample_batch(data, B: int, T: int, gen: torch.Generator | None = None, device: str = "cpu"):
    """Returns x, y: each (B, T) int64. y is x shifted one position left"""
    N = len(data)

    starts = torch.randint(0, N - T, (B,), generator=gen)
    win = np.stack([data[i:i + T + 1].astype(np.int64) for i in starts.tolist()])
    win = torch.from_numpy(win)
    x = win[:, :-1].contiguous()
    y = win[:, 1:].contiguous()
    return x.to(device), y.to(device)
