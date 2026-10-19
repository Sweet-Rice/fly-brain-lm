#!/usr/bin/env python3
"""Write a pytest JUnit XML report as a GitHub Actions step summary.

Usage: python .github/scripts/test_summary.py JUNIT_XML [--title TITLE]

Appends Markdown to $GITHUB_STEP_SUMMARY when set; otherwise prints it to stdout.
Exit status: 0 when the report was read and summarized, whatever the test outcomes
(the pytest step decides pass/fail); 1 when the report is missing or unreadable.
Standard library only.
"""

import argparse
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass

MAX_DETAIL_CHARS = 8000
LABELS = {"passed": "PASSED", "failed": "FAILED", "error": "ERROR", "skipped": "SKIPPED"}


@dataclass
class Case:
    name: str
    seconds: float
    outcome: str
    message: str
    detail: str


def _longest_backtick_run(text: str) -> int:
    return max((len(run) for run in re.findall(r"`+", text)), default=0)


def md_code(text: str, in_table: bool = True) -> str:
    """Inline code span; pipes are escaped for table cells."""
    text = text.replace("\r", " ").replace("\n", " ")
    if in_table:
        text = text.replace("|", "\\|")
    fence = "`" * (_longest_backtick_run(text) + 1)
    return f"{fence} {text} {fence}"


def md_block(text: str) -> str:
    """Fenced block whose fence cannot be closed by the content."""
    text = text.strip("\n")
    if len(text) > MAX_DETAIL_CHARS:
        dropped = len(text) - MAX_DETAIL_CHARS
        text = text[:MAX_DETAIL_CHARS] + f"\n... {dropped} more characters; see the JUnit artifact"
    fence = "`" * max(3, _longest_backtick_run(text) + 1)
    return f"{fence}text\n{text}\n{fence}\n"


def load_cases(root: ET.Element) -> list[Case]:
    cases = []
    for tc in root.iter("testcase"):
        classname = tc.get("classname", "")
        name = tc.get("name", "")
        full = f"{classname}::{name}" if classname else name
        outcome, message, detail = "passed", "", ""
        for tag, label in (("failure", "failed"), ("error", "error"), ("skipped", "skipped")):
            child = tc.find(tag)
            if child is not None:
                outcome = label
                message = child.get("message", "")
                detail = child.text or ""
                break
        cases.append(Case(full, float(tc.get("time", "0") or 0), outcome, message, detail))
    return cases


def render(title: str, cases: list[Case]) -> str:
    counts = Counter(c.outcome for c in cases)
    if not cases:
        status = "NO TESTS RECORDED"
    else:
        status = "FAILED" if counts["failed"] + counts["error"] else "PASSED"
    total_seconds = sum(c.seconds for c in cases)
    lines = [
        f"## {title}: {status}",
        "",
        f"Total: {len(cases)}; passed: {counts['passed']}; failed: {counts['failed']}; "
        f"errors: {counts['error']}; skipped: {counts['skipped']}; time: {total_seconds:.1f} s",
        "",
    ]
    if not cases:
        lines += ["No test cases were recorded in the report.", ""]
    else:
        lines += ["| Result | Test | Time (s) |", "| --- | --- | ---: |"]
        lines += [f"| {LABELS[c.outcome]} | {md_code(c.name)} | {c.seconds:.2f} |" for c in cases]
        lines.append("")
    failures = [c for c in cases if c.outcome in ("failed", "error")]
    if failures:
        lines += ["### Failure details", ""]
        for c in failures:
            lines += [f"#### {md_code(c.name, in_table=False)} ({c.outcome})", ""]
            if c.message:
                lines.append(md_block(c.message))
            if c.detail.strip() and c.detail.strip() != c.message.strip():
                lines.append(md_block(c.detail))
    return "\n".join(lines) + "\n"


def emit(text: str) -> None:
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("junit_xml")
    parser.add_argument("--title", default="pytest")
    args = parser.parse_args(argv)
    try:
        root = ET.parse(args.junit_xml).getroot()
    except (OSError, ET.ParseError) as exc:
        emit(
            f"## {args.title}: NO RESULTS\n\n"
            f"Could not read JUnit report {md_code(args.junit_xml)}. "
            "The pytest step log has the details.\n\n"
            + md_block(str(exc))
        )
        print(f"test_summary: cannot read {args.junit_xml}: {exc}", file=sys.stderr)
        return 1
    emit(render(args.title, load_cases(root)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
