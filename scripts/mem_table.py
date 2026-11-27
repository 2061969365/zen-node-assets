#!/usr/bin/env python3
"""Render a warp vs warp-wireproxy memory comparison as markdown."""
import glob
import json
import os
import sys

MB = 1048576.0


def load(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def fmt(v):
    return f"{v / MB:.1f}" if isinstance(v, (int, float)) and v else "0.0"


def main():
    mem = {}
    for path in glob.glob("/tmp/mem/*.mem.json"):
        d = load(path)
        if d:
            mem[d.get("label") or os.path.basename(path).split(".")[0]] = d

    status = {}
    for path in glob.glob("/tmp/mem/*.status.json"):
        tpl = os.path.basename(path).split(".")[0]
        status[tpl] = load(path) or {}

    runner_ip = ""
    try:
        with open("/tmp/mem/runner_ip.txt", "r", encoding="utf-8") as fh:
            runner_ip = fh.read().strip()
    except Exception:
        pass

    node_version = ""
    try:
        with open("/tmp/mem/node_version.txt", "r", encoding="utf-8") as fh:
            node_version = fh.read().strip()
    except Exception:
        pass

    order = [t for t in ("warp", "warp-wireproxy") if t in mem] or sorted(mem)
    lines = []
    lines.append("## warp vs warp-wireproxy memory (same runner, same job)")
    lines.append("")
    lines.append(f"runner egress IP: `{runner_ip or 'n/a'}` · Node `{node_version or 'n/a'}` · "
                 "boot probe disabled (`BOOT_PROBE_TRIES=0`) so the sample is stable · 4 chat calls + 45 s idle")
    lines.append("")
    lines.append("| template | Node PSS | gateway PSS | tunnel PSS | total PSS | total RSS | max HWM | Node threads | CodeSpace | egress IPv4 | egress IPv6 | chat | state |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|")

    for tpl in order:
        d = mem[tpl]
        role = d.get("byRole", {})
        st = status.get(tpl, {})
        m = st.get("mem") or {}
        proc = m.get("proc") or {}
        eg = st.get("egress") or {}
        node_threads = max((p.get("threads", 0) for p in d.get("procs", []) if p.get("role") == "node"), default=0)
        try:
            chat = ",".join(open(f"/tmp/mem/{tpl}.chat.txt").read().split())
        except Exception:
            chat = ""
        lines.append("| `{}` | {} | {} | {} | **{}** | {} | {} | {} | {} | `{}` | `{}` | {} | {} |".format(
            tpl,
            fmt((role.get("node") or {}).get("pss")),
            fmt((role.get("gateway") or {}).get("pss")),
            fmt((role.get("tunnel") or {}).get("pss")),
            fmt(d.get("totals", {}).get("pss")),
            fmt(d.get("totals", {}).get("rss")),
            fmt(d.get("totals", {}).get("hwm")),
            node_threads,
            fmt(proc.get("CodeSpace")),
            eg.get("ip", ""),
            eg.get("ip6", ""),
            chat or "-",
            st.get("state", "-"),
        ))

    if len(order) == 2:
        a, b = mem[order[0]], mem[order[1]]
        da = a.get("totals", {}).get("pss", 0)
        db = b.get("totals", {}).get("pss", 0)
        if da and db:
            lines.append("")
            lines.append(f"PSS delta: `{order[1]}` is {fmt(da - db)} MiB lower ({(1 - db / da) * 100:.0f}% less) "
                         f"than `{order[0]}`.")

    lines.append("")
    lines.append("### Per process")
    lines.append("")
    lines.append("| template | role | comm | pid | PSS | RSS | HWM | threads |")
    lines.append("|---|---|---|---:|---:|---:|---:|---:|")
    for tpl in order:
        for p in mem[tpl].get("procs", []):
            lines.append("| `{}` | {} | `{}` | {} | {} | {} | {} | {} |".format(
                tpl, p.get("role"), p.get("comm"), p.get("pid"),
                fmt(p.get("pss")), fmt(p.get("rss")), fmt(p.get("hwm")), p.get("threads")))

    text = "\n".join(lines)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
