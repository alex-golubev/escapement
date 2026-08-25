#!/usr/bin/env python3
"""Assert that a reason is written down once.

This project has four permanent homes for "why": `ARCHITECTURE.md` for the
shape of the product, `CLAUDE.md` for what breaks silently, the commit message
for how something was found out, and a comment for what someone editing that
line has to know. Nothing stops a reason from landing in two of them, and the
one that always wins is the comment — it is where you are typing.

So this checks the half a script can check: prose living both in a code comment
and in one of the two documents. Two copies is one to maintain and one to
forget, and they part company silently — the document gets edited, the comment
does not, and the wrong one is the copy people read while working.

The fix is never to delete the reason. It is to point at it: the section idiom
(`ARCHITECTURE.md §3`, `§2.4`) is already used throughout for exactly that.

Commit messages are deliberately not checked. A comment cannot repeat a commit
that does not exist yet, so that half is a rule and not a gate.

The report at the end gates nothing. A doc comment longer than the item it
describes is a question, not a verdict — sometimes the reason really is that
local, and `COMMANDS_PER_QUANTUM` earns every line it has. It is here so that
"where is the mass" is one command rather than a fresh script each time.

Usage:  tools/check-comment-drift.py [<file> ...]
        with no arguments, every .rs under crates/ and every .py under tools/
"""

import pathlib
import re
import sys

from report import advise

DOCUMENTS = ("ARCHITECTURE.md", "CLAUDE.md")

# Words of overlap before two sentences count as the same sentence. Eight is
# long enough that shared vocabulary does not reach it — "the interface keeps
# its own queue in its own memory" is a quotation, not a coincidence.
RUN = 8

# Prose that is meant to stand in both places. Narrow, one entry per case, and
# each one checked by hand — a wide pattern here silences the next real drift
# as happily as the false alarm it was added for.
DELIBERATE = ()

COMMENT = re.compile(r"^\s*(//[/!]?|#)")
MARKUP = re.compile(r"[`*_>|#]")


def normalize(text):
    return MARKUP.sub("", text).lower().split()


def document_grams(path):
    """Every `RUN`-word run in a document, against the line it starts on."""
    grams = {}
    words = []
    for number, line in enumerate(path.read_text().split("\n"), 1):
        words.extend((word, number) for word in normalize(line))
    for i in range(len(words) - RUN + 1):
        run = " ".join(word for word, _ in words[i : i + RUN])
        grams.setdefault(run, words[i][1])
    return grams


def comments(path):
    """Comment lines, as (line number, text without the marker)."""
    for number, line in enumerate(path.read_text().split("\n"), 1):
        marker = COMMENT.match(line)
        if marker:
            yield number, line[marker.end() :].strip()


def drift(path, documents):
    """Where this file says again what a document already says.

    One entry per run of neighbouring lines, not per line: a repeated paragraph
    is one mistake, and reporting each of its lines buries the next file.
    """
    found = []
    for number, text in comments(path):
        if any(phrase in text for phrase in DELIBERATE):
            continue
        words = normalize(text)
        for i in range(len(words) - RUN + 1):
            run = " ".join(words[i : i + RUN])
            for name, grams in documents.items():
                if run in grams:
                    found.append((number, text, name, grams[run]))
                    break
            else:
                continue
            break

    previous = None
    for entry in found:
        if previous is None or entry[0] > previous + 1:
            yield entry
        previous = entry[0]


STRING = re.compile(r'"(?:[^"\\]|\\.)*"')


def item_length(lines, start):
    """Lines of the item beginning at `start`, attributes skipped."""
    while start < len(lines) and lines[start].strip().startswith("#["):
        start += 1
    depth = 0
    for offset, line in enumerate(lines[start:]):
        code = STRING.sub("", line)
        depth += code.count("{") + code.count("(") - code.count("}") - code.count(")")
        if depth <= 0 and (line.rstrip().endswith((";", "}", ")", ",")) or offset > 0):
            return offset + 1
    return len(lines) - start


def weigh(path):
    """Comment and code lines, counting only what ships.

    Tests are left out because they are mostly prose by nature — a test name is
    a sentence and the reason it exists is another — and mixing them in hides
    the number this is about.
    """
    lines = path.read_text().split("\n")
    for i, line in enumerate(lines):
        if re.match(r"\s*mod tests\s*\{", line):
            lines = lines[: i - 1]
            break
    comment = sum(1 for l in lines if l.strip().startswith("//"))
    code = sum(1 for l in lines if l.strip() and not l.strip().startswith("//"))
    return comment, code


def blocks(path):
    """Doc-comment blocks, as (lines of comment, lines of item, line number)."""
    lines = path.read_text().split("\n")
    run = None
    for i, line in enumerate(lines):
        if line.strip().startswith("///"):
            run = i if run is None else run
        elif run is not None:
            yield i - run, item_length(lines, i), run + 1
            run = None


def main(argv):
    paths = [pathlib.Path(a) for a in argv]
    if not paths:
        paths = sorted(pathlib.Path("crates").rglob("*.rs"))
        paths += sorted(p for p in pathlib.Path("tools").glob("*.py"))

    documents = {name: document_grams(pathlib.Path(name)) for name in DOCUMENTS}

    repeated = 0
    for path in paths:
        for number, text, name, line in drift(path, documents):
            print(f"FAIL {path}:{number}: already said in {name}:{line}")
            print(f"       {text}")
            repeated += 1
    if not repeated:
        print(f"ok   {len(paths)} files: no comment repeats {' or '.join(DOCUMENTS)}")

    rust = [p for p in paths if p.suffix == ".rs"]
    comment = code = 0
    for path in rust:
        c, k = weigh(path)
        comment += c
        code += k
    if comment + code:
        print(f"\n{comment} lines of comment against {code} of code, "
              f"tests aside: {comment / (comment + code):.0%}")

    top = sorted(((c, i, p, n) for p in rust for c, i, n in blocks(p)), reverse=True)[:8]
    if top:
        print("Longest doc comments against what they describe:")
        for lines, item, path, number in top:
            print(f"  {lines:3} on {item:3}  {path}:{number}")

    if repeated:
        advise(
            "A comment repeating a document is a second copy to maintain, and",
            "the two drift apart silently. Point at the section instead — the",
            "`ARCHITECTURE.md §3` idiom is used throughout for this. If a copy",
            "is genuinely wanted, add it to DELIBERATE with the reason.",
        )
    return 1 if repeated else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
