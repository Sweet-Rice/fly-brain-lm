"""Send a prompt to the running FlyBrainLM server (serve.py) and print the response.

Usage:  python ask.py                                  # prompt "Once upon a time"
        python ask.py "The fly said" --max-tokens 40
        python ask.py --chat "Fix the bug in main.py"  # chat endpoint, like a harness uses
        python ask.py --stream                         # print tokens as they arrive
Needs only the standard library. Start the server first: python serve.py
"""
import argparse
import json
import sys
import urllib.error
import urllib.request


def post(url, body, stream=False):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer x"})
    return urllib.request.urlopen(req, timeout=300)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("prompt", nargs="?", default="Once upon a time")
    p.add_argument("--url", default="http://127.0.0.1:8000/v1")
    p.add_argument("--max-tokens", type=int, default=50)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--chat", action="store_true", help="use /chat/completions instead of /completions")
    p.add_argument("--stream", action="store_true")
    a = p.parse_args()

    if a.chat:
        url, body = a.url + "/chat/completions", {"messages": [{"role": "user", "content": a.prompt}]}
    else:
        url, body = a.url + "/completions", {"prompt": a.prompt}
    body.update(model="flybrain-untrained", max_tokens=a.max_tokens, temperature=a.temperature, stream=a.stream)

    try:
        r = post(url, body)
    except urllib.error.URLError as e:
        sys.exit(f"could not reach {url} ({e}). Is the server running? python serve.py")

    if not a.prompt or a.chat:
        print(f"> {a.prompt}\n")
    else:
        print(a.prompt, end="", flush=True)                     # completion continues the prompt
    if a.stream:
        for line in r:
            line = line.decode().strip()
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            ch = json.loads(line[6:])["choices"]
            if ch:
                print(ch[0].get("delta", {}).get("content") or ch[0].get("text") or "", end="", flush=True)
        print()
    else:
        out = json.loads(r.read())
        c = out["choices"][0]
        print(c["message"]["content"] if a.chat else c["text"])
        u = out["usage"]
        print(f"\n[{c['finish_reason']}, {u['prompt_tokens']} prompt + {u['completion_tokens']} new tokens]")


if __name__ == "__main__":
    main()
