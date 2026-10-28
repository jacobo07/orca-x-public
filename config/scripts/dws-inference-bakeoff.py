#!/usr/bin/env python3
"""Row 27 bake-off: local llama-server vs `claude -p`, one fixed prompt set, one scorer.

Run on the host that serves the model:  python3 dws-inference-bakeoff.py {measure|bakeoff|control} [--out FILE]
"""
import json, re, subprocess, sys, tempfile, time, urllib.request, os

LOCAL = os.environ.get("BAKEOFF_LOCAL_URL", "http://127.0.0.1:8081")
SUFFIX = "\n\nReply with ONE python code block defining exactly the requested function. No prose, no tests."

TASKS = [
    ("rev_words", "Write `rev_words(s)` returning the words of s in reverse order joined by single spaces.",
     "assert rev_words('a b  c')=='c b a'; assert rev_words('')==''; assert rev_words(' x ')=='x'"),
    ("is_pal", "Write `is_pal(s)` true if s is a palindrome ignoring case and non-alphanumerics.",
     "assert is_pal('A man, a plan, a canal: Panama'); assert not is_pal('ab'); assert is_pal('')"),
    ("fib", "Write `fib(n)` returning the n-th Fibonacci number with fib(0)=0, fib(1)=1, iteratively.",
     "assert [fib(i) for i in range(8)]==[0,1,1,2,3,5,8,13]; assert fib(90)==2880067194370816120"),
    ("flatten", "Write `flatten(x)` flattening arbitrarily nested lists into one flat list, preserving order.",
     "assert flatten([1,[2,[3,[4]],5]])==[1,2,3,4,5]; assert flatten([])==[]; assert flatten([[],[[]]])==[]"),
    ("merge_iv", "Write `merge_iv(iv)` merging overlapping closed intervals given as [start,end] lists; return sorted list of lists.",
     "assert merge_iv([[1,3],[2,6],[8,10],[6,7]])==[[1,7],[8,10]]; assert merge_iv([])==[]; assert merge_iv([[1,4],[4,5]])==[[1,5]]"),
    ("roman", "Write `roman(n)` converting an integer 1..3999 to a Roman numeral string.",
     "assert roman(4)=='IV'; assert roman(1994)=='MCMXCIV'; assert roman(3999)=='MMMCMXCIX'"),
    ("anagram_groups", "Write `anagram_groups(words)` returning a list of groups (lists) of anagrams, each group sorted, groups sorted by first element.",
     "assert anagram_groups(['eat','tea','tan','ate','nat','bat'])==[['ate','eat','tea'],['bat'],['nat','tan']]"),
    ("balanced", "Write `balanced(s)` true if the brackets ()[]{} in s are balanced and properly nested; other characters are ignored.",
     "assert balanced('{[()]}x'); assert not balanced('(]'); assert not balanced('(('); assert balanced('')"),
    ("lcs", "Write `lcs(a,b)` returning the length of the longest common subsequence of strings a and b.",
     "assert lcs('abcde','ace')==3; assert lcs('abc','def')==0; assert lcs('','a')==0"),
    ("gcd_list", "Write `gcd_list(xs)` returning the gcd of a non-empty list of positive ints without using math.gcd.",
     "assert gcd_list([12,18,24])==6; assert gcd_list([7])==7; assert gcd_list([5,7])==1"),
    ("rle", "Write `rle(s)` run-length encoding like 'aaabcc' -> 'a3b1c2'; empty string -> ''.",
     "assert rle('aaabcc')=='a3b1c2'; assert rle('')==''; assert rle('z')=='z1'"),
    ("topo", "Write `topo(edges, n)` returning a topological order (list) of nodes 0..n-1 for directed edges [(u,v)], lexicographically smallest, or None if cyclic.",
     "assert topo([(0,1),(1,2)],3)==[0,1,2]; assert topo([(1,0)],2)==[1,0]; assert topo([(0,1),(1,0)],2) is None"),
]


def extract(text):
    m = re.findall(r"```(?:python|py)?\s*\n(.*?)```", text, re.S)
    return m[0] if m else text


def score(code, tests):
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(code + "\n\n" + tests.replace("; ", "\n") + "\n")
    try:
        r = subprocess.run([sys.executable, "-I", f.name], capture_output=True, timeout=20)
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        return False
    finally:
        os.unlink(f.name)


def ask_local(prompt):
    body = json.dumps({"model": "qwen3-coder-30b", "messages": [{"role": "user", "content": prompt}],
                       "temperature": 0, "max_tokens": 700, "stream": False}).encode()
    t0 = time.time()
    req = urllib.request.Request(LOCAL + "/v1/chat/completions", body, {"Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=300))
    dt = time.time() - t0
    return d["choices"][0]["message"]["content"], dt, d.get("usage", {}).get("completion_tokens", 0)


def ask_claude(prompt):
    t0 = time.time()
    r = subprocess.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
    return r.stdout, time.time() - t0, 0


def stream_probe():
    # first-token latency and decode throughput from the streamed response
    body = json.dumps({"model": "qwen3-coder-30b", "messages": [{"role": "user", "content": "Write a python function that adds two numbers."}],
                       "temperature": 0, "max_tokens": 200, "stream": True}).encode()
    req = urllib.request.Request(LOCAL + "/v1/chat/completions", body, {"Content-Type": "application/json"})
    t0 = time.time(); first = None; n = 0
    for line in urllib.request.urlopen(req, timeout=300):
        if line.startswith(b"data: ") and b"[DONE]" not in line:
            try:
                delta = json.loads(line[6:])["choices"][0]["delta"].get("content")
            except (KeyError, IndexError, ValueError):
                continue
            if delta:
                n += 1
                if first is None:
                    first = time.time() - t0
    total = time.time() - t0
    return {"first_token_s": round(first, 3), "chunks": n, "tokens_per_s": round(n / (total - first), 2) if total > first else 0}


def measure(n=5):
    models = json.load(urllib.request.urlopen(LOCAL + "/v1/models", timeout=20))
    runs = [stream_probe() for _ in range(n)]
    return {"model_ids": [m["id"] for m in models["data"]], "n_ctx": models["data"][0].get("meta", {}).get("n_ctx"),
            "runs": runs, "n": n,
            "first_token_s_median": sorted(r["first_token_s"] for r in runs)[n // 2],
            "tokens_per_s_median": sorted(r["tokens_per_s"] for r in runs)[n // 2]}


def run_side(ask):
    rows = []
    for tid, prompt, tests in TASKS:
        try:
            text, dt, toks = ask(prompt + SUFFIX)
            ok = score(extract(text), tests)
        except Exception as e:  # a failed call counts as a failed answer, recorded
            text, dt, toks, ok = f"ERROR {e}", 0.0, 0, False
        rows.append({"task": tid, "pass": ok, "latency_s": round(dt, 2), "completion_tokens": toks})
    p = sum(r["pass"] for r in rows)
    return {"pass": p, "total": len(rows), "pass_rate": round(p / len(rows), 3),
            "latency_s_median": sorted(r["latency_s"] for r in rows)[len(rows) // 2], "rows": rows}


def control():
    # the scorer must fail a wrong answer and pass a right one on every task
    out = {}
    for tid, _, tests in TASKS:
        fn = tid if f"{tid}(" in tests else re.search(r"(\w+)\(", tests.split("assert")[1]).group(1)
        out[tid] = score(f"def {fn}(*a, **k):\n    return None\n", tests)
    return {"wrong_answers_passed": [k for k, v in out.items() if v], "tasks": len(TASKS)}


if __name__ == "__main__":
    mode = sys.argv[1]
    res = {"measure": measure, "control": control}.get(mode, lambda: {
        "local": run_side(ask_local), "claude": run_side(ask_claude)})()
    res["at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    text = json.dumps(res, indent=2)
    if "--out" in sys.argv:
        open(sys.argv[sys.argv.index("--out") + 1], "w").write(text)
    print(text)
