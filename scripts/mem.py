#!/usr/bin/env python3
"""Sample RSS/PSS for a process tree (Linux /proc)."""

import json
import os
import sys


def read_status(pid: int) -> dict:
    out = {}
    try:
        with open(f"/proc/{pid}/status", "r", encoding="utf-8") as f:
            for line in f:
                if ":" in line:
                    k, v = line.split(":", 1)
                    out[k.strip()] = v.strip()
    except OSError:
        pass
    return out


def read_smaps(pid: int) -> tuple[int, int]:
    rss = 0
    pss = 0
    try:
        with open(f"/proc/{pid}/smaps_rollup", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("Rss:"):
                    rss = int(line.split()[1])
                elif line.startswith("Pss:"):
                    pss = int(line.split()[1])
    except OSError:
        pass
    return rss, pss


def main() -> int:
    root = int(sys.argv[1])
    label = sys.argv[2] if len(sys.argv) > 2 else "sample"

    procs: dict[int, tuple[int, str]] = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as f:
                parts = f.read().split()
            procs[pid] = (int(parts[3]), parts[1].strip("()"))
        except (OSError, IndexError, ValueError):
            pass

    pids = {root}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _) in list(procs.items()):
            if ppid in pids and pid not in pids:
                pids.add(pid)
                changed = True

    rows = []
    for pid in sorted(pids):
        if pid not in procs:
            continue
        ppid, comm = procs[pid]
        st = read_status(pid)

        def kb(key: str) -> int:
            raw = st.get(key, "0 kB").split()[0]
            try:
                return int(raw)
            except ValueError:
                return 0

        rss_kb = kb("VmRSS")
        hwm_kb = kb("VmHWM")
        _, pss_kb = read_smaps(pid)

        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmdline = f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
        except OSError:
            cmdline = ""

        rows.append(
            {
                "pid": pid,
                "ppid": ppid,
                "comm": comm,
                "rss_mb": round(rss_kb / 1024, 1),
                "pss_mb": round(pss_kb / 1024, 1),
                "hwm_mb": round(hwm_kb / 1024, 1),
                "cmdline": cmdline[:200],
            }
        )

    print(
        json.dumps(
            {
                "label": label,
                "root": root,
                "rows": rows,
                "total_rss_mb": round(sum(r["rss_mb"] for r in rows), 1),
                "total_pss_mb": round(sum(r["pss_mb"] for r in rows), 1),
                "total_hwm_mb": round(sum(r["hwm_mb"] for r in rows), 1),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
