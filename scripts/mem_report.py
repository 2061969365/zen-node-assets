#!/usr/bin/env python3
"""Measure the resident/PSS footprint of a process and all its descendants.

Linux only. Reads /proc/<pid>/smaps_rollup for every process in the tree and
emits a JSON summary that can be compared between templates.
"""
import argparse
import json
import os
import sys


def read_status(pid):
    out = {}
    try:
        with open(f"/proc/{pid}/status", "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                k, _, v = line.partition(":")
                out[k.strip()] = v.strip()
    except OSError:
        return {}
    return out


def read_rollup(pid):
    out = {}
    try:
        with open(f"/proc/{pid}/smaps_rollup", "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 3 and parts[2].lower() == "kb":
                    out[parts[0].rstrip(":")] = int(parts[1]) * 1024
    except OSError:
        return {}
    if out:
        return out
    # Older kernels without smaps_rollup: sum the per-VMA smaps file.
    sums = {}
    try:
        with open(f"/proc/{pid}/smaps", "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 3 and parts[2].lower() == "kb" and parts[0].rstrip(":") in (
                        "Pss", "Rss", "Private_Dirty", "Private_Clean", "Shared_Clean", "Shared_Dirty", "Anonymous"):
                    key = parts[0].rstrip(":")
                    sums[key] = sums.get(key, 0) + int(parts[1]) * 1024
    except OSError:
        return {}
    return sums


def read_comm(pid):
    try:
        with open(f"/proc/{pid}/comm", "r", encoding="utf-8", errors="replace") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def read_ppid(pid):
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8", errors="replace") as fh:
            data = fh.read()
    except OSError:
        return None
    # comm may contain spaces/parentheses; everything after the last ')' is fixed.
    rest = data[data.rfind(")") + 2:].split()
    try:
        return int(rest[1])
    except (IndexError, ValueError):
        return None


def tree(root):
    children = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        ppid = read_ppid(pid)
        if ppid is None:
            continue
        children.setdefault(ppid, []).append(pid)
    out, stack = [], [root]
    seen = set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        out.append(pid)
        stack.extend(children.get(pid, []))
    return out


def role_for(comm, cmdline, is_root):
    if is_root:
        return "node"
    text = f"{comm} {cmdline}".lower()
    if "zen-direct" in text:
        return "gateway"
    if "sing-box" in text or "wireproxy" in text:
        return "tunnel"
    if "wgcf" in text:
        return "helper"
    return "other"


def cmdline_of(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            raw = fh.read().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
        return raw
    except OSError:
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default="")
    args = ap.parse_args()

    pids = tree(args.root)
    procs = []
    for pid in pids:
        comm = read_comm(pid)
        cmd = cmdline_of(pid)
        st = read_status(pid)
        ru = read_rollup(pid)

        def kb(key):
            v = st.get(key, "")
            try:
                return int(v.split()[0]) * 1024
            except (ValueError, IndexError):
                return 0

        procs.append({
            "pid": pid,
            "comm": comm if comm and comm != "MainThread" else (os.path.basename(cmd.split()[0]) if cmd else comm),
            "role": role_for(comm, cmd, pid == args.root),
            "cmdline": cmd[:200],
            "pss": ru.get("Pss", 0),
            "rss": ru.get("Rss", kb("VmRSS")),
            "private": ru.get("Private_Dirty", 0) + ru.get("Private_Clean", 0),
            "shared": ru.get("Shared_Clean", 0) + ru.get("Shared_Dirty", 0),
            "anonymous": ru.get("Anonymous", 0),
            "hwm": kb("VmHWM"),
            "threads": int(st.get("Threads", "0") or 0),
        })

    def total(key):
        return sum(p[key] for p in procs)

    by_role = {}
    for p in procs:
        r = by_role.setdefault(p["role"], {"pss": 0, "rss": 0, "private": 0, "hwm": 0, "count": 0})
        for k in ("pss", "rss", "private", "hwm"):
            r[k] += p[k]
        r["count"] += 1

    out = {
        "label": args.label,
        "root": args.root,
        "procs": procs,
        "byRole": by_role,
        "totals": {
            "pss": total("pss"),
            "rss": total("rss"),
            "private": total("private"),
            "shared": total("shared"),
            "hwm": max((p["hwm"] for p in procs), default=0),
        },
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
    print(json.dumps(out["totals"], indent=1))
    for p in procs:
        print(f"  {p['role']:8s} {p['comm']:14s} pid={p['pid']:6d} "
              f"pss={p['pss']/1048576:6.1f} rss={p['rss']/1048576:6.1f} "
              f"hwm={p['hwm']/1048576:6.1f} thr={p['threads']}")


if __name__ == "__main__":
    sys.exit(main())
