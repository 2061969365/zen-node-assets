#!/usr/bin/env python3
"""Summarise the IPv6 isolation experiment (WARP with and without IPv6)."""
import json
import os
import sys

MB = 1048576.0


def load_runs(path="/tmp/mem/ipv6.jsonl"):
    runs = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        runs.append(json.loads(line))
                    except Exception:
                        pass
    except Exception:
        pass
    return runs


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def main():
    runs = load_runs()
    runner_ip = read_text("/tmp/mem/runner_ip.txt")
    node_version = read_text("/tmp/mem/node_version.txt")

    lines = []
    lines.append("## IPv6 isolation: WARP with IPv6 vs forced IPv4")
    lines.append("")
    lines.append(f"runner `{runner_ip or 'n/a'}` · Node `{node_version or 'n/a'}` · "
                 "same job, alternating order · `BOOT_PROBE_TRIES=0` · 4 chat calls per run")
    lines.append("")
    lines.append("| run | template | mode | state | egress IPv4 | egress IPv6 | chat codes |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in runs:
        mode = "forced IPv4" if r.get("force_v4") else "IPv6 allowed"
        lines.append("| `{}` | `{}` | {} | {} | `{}` | `{}` | {} |".format(
            r.get("label", ""), r.get("template", ""), mode, r.get("state", ""),
            r.get("ip", ""), r.get("ip6", "") or "-", ",".join(r.get("codes", []))))

    lines.append("")
    lines.append("### Summary")
    lines.append("")
    lines.append("| template | mode | runs | IPv6 egress present | chat 200 | chat 429 | other |")
    lines.append("|---|---|---:|---:|---:|---:|---:|")
    keys = []
    for r in runs:
        k = (r.get("template", ""), int(r.get("force_v4", 0)))
        if k not in keys:
            keys.append(k)
    for tpl, force in keys:
        group = [r for r in runs if r.get("template", "") == tpl and int(r.get("force_v4", 0)) == force]
        codes = [c for r in group for c in r.get("codes", [])]
        n200 = sum(1 for c in codes if c == "200")
        n429 = sum(1 for c in codes if c == "429")
        other = len(codes) - n200 - n429
        ip6 = sum(1 for r in group if r.get("ip6"))
        lines.append("| `{}` | {} | {} | {}/{} | {} | {} | {} |".format(
            tpl, "forced IPv4" if force else "IPv6 allowed",
            len(group), ip6, len(group), n200, n429, other))

    lines.append("")
    lines.append("Read: with the same WARP IPv4 pool, `IPv6 allowed` should get far more 200s "
                 "than `forced IPv4` if IPv6 egress is what dodges the shared-IPv4 free-usage "
                 "quota. `warp-wireproxy` is the case under test: if its IPv6 row matches "
                 "`warp`'s, the userspace tunnel now carries IPv6 too.")

    text = "\n".join(lines)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
