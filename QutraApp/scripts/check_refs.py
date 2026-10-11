"""Resolve every path:line reference in a Markdown document against a commit and print the lines.

Usage: python check_refs.py <doc.md> <commit>
Full refs (src-tauri/src/x.rs:12-14) set the "current file"; bare refs
(:156-157) resolve against it; short names (tools.rs:603) resolve through
BASENAMES. Prints each ref with its first and last cited line.
"""
import re
import subprocess
import sys

REPO = r"C:\Dev\QutraLabs\QutraApp"
BASENAMES = {
    "commands.rs": "src-tauri/src/assistant/commands.rs",
    "tools.rs": "src-tauri/src/assistant/tools.rs",
    "broker.rs": "src-tauri/src/assistant/broker.rs",
    "ollama.rs": "src-tauri/src/assistant/ollama.rs",
    "consent.rs": "src-tauri/src/consent.rs",
    "lib.rs": "src-tauri/src/lib.rs",
    "en.ts": "src/lib/i18n/en.ts",
    "tr.ts": "src/lib/i18n/tr.ts",
}
FULL = re.compile(r"((?:src-tauri|src|docs|e2e)/[\w./-]+\.(?:rs|ts|tsx|json|md)):(\d+)(?:-(\d+))?")
SHORT = re.compile(r"(?<![\w/])([\w-]+\.(?:rs|ts|tsx)):(\d+)(?:-(\d+))?")
BARE = re.compile(r"(?<=[\s(])(?:and )?:(\d+)(?:-(\d+))?")

cache = {}


def lines_of(commit, path):
    key = (commit, path)
    if key not in cache:
        out = subprocess.run(
            ["git", "-C", REPO, "show", f"{commit}:./{path}"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        cache[key] = None if out.returncode else out.stdout.split("\n")
    return cache[key]


def show(commit, path, a, b, origin):
    lines = lines_of(commit, path)
    if lines is None:
        print(f"!! MISSING FILE {path}  ({origin})")
        return
    b = b or a
    if b > len(lines):
        print(f"!! OUT OF RANGE {path}:{a}-{b} (file has {len(lines)})  ({origin})")
        return
    first = lines[a - 1].strip()[:110]
    print(f"{path}:{a}{'-' + str(b) if b != a else ''}   [{origin}]")
    print(f"    {a}: {first}")
    if b != a:
        print(f"    {b}: {lines[b - 1].strip()[:110]}")


def main():
    doc_path, commit = sys.argv[1], sys.argv[2]
    text = open(doc_path, encoding="utf-8").read()
    current = None
    events = []
    for m in FULL.finditer(text):
        events.append((m.start(), "full", m))
    for m in SHORT.finditer(text):
        if not any(e[0] <= m.start() < e[2].end() for e in events if e[1] == "full"):
            events.append((m.start(), "short", m))
    for m in BARE.finditer(text):
        events.append((m.start(), "bare", m))
    events.sort(key=lambda e: e[0])
    n = 0
    for pos, kind, m in events:
        if kind == "full":
            current = m.group(1)
            show(commit, current, int(m.group(2)), int(m.group(3)) if m.group(3) else None, m.group(0))
        elif kind == "short":
            name = m.group(1)
            path = BASENAMES.get(name)
            if path is None:
                print(f"?? unmapped short ref {m.group(0)}")
                continue
            current = path
            show(commit, path, int(m.group(2)), int(m.group(3)) if m.group(3) else None, m.group(0))
        else:
            if current is None:
                print(f"?? bare ref with no file {m.group(0)}")
                continue
            show(commit, current, int(m.group(1)), int(m.group(2)) if m.group(2) else None, "bare " + m.group(0).strip())
        n += 1
    print(f"\n{n} references checked against {commit}")


if __name__ == "__main__":
    main()
