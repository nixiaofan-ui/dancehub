#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 rawgraphy.com（로우그래피，韩国本土舞室预约平台）的批量抓取配置。

为什么用 RSC 而不是 HTML：
  站点是 Next.js App Router，课表数据不在 HTML 里，只在 RSC 飞行载荷中。
  请求头带 `RSC: 1` 拿到的载荷约 39KB，而完整 HTML 有 230KB，探测时差 6 倍体积。

用法：
  python3 capture/generate_rawgraphy_configs.py                # 扫描 id 1~120
  python3 capture/generate_rawgraphy_configs.py --range 1 200   # 自定义区间
  python3 capture/generate_rawgraphy_configs.py --all-cities    # 非首尔场馆也启用

输出：server/src/crawler/studios.rawgraphy.json
（需在 configs.js 的 AUTO_CONFIG_FILES 里登记才会生效）
"""

import argparse
import concurrent.futures
import json
import os
import re
import sys
import urllib.request

BASE = "https://rawgraphy.com"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

TITLE_RE = re.compile(r'"title","0",\{"children":"([^"]{2,80})"\}')
ADDRESS_RE = re.compile(r'"address":"([^"]+)"')
TIMETABLE_RE = re.compile(r'"timeTable"')
# 404 / 软 404 页面的 title 是 "Error"，据此过滤掉不存在的 id
PLACEHOLDER_TITLES = {"Error", "Not Found", "404"}

# 韩国地址前缀 → 中文城市名
CITY_PREFIX = [
    ("서울", "首尔"),
    ("부산", "釜山"),
    ("인천", "仁川"),
    ("대구", "大邱"),
    ("대전", "大田"),
    ("광주", "光州"),
    ("울산", "蔚山"),
    ("세종", "世宗"),
    ("경기도", "京畿道"),
    ("강원", "江原道"),
    ("충북", "忠清北道"),
    ("충남", "忠清南道"),
    ("전북", "全罗北道"),
    ("전남", "全罗南道"),
    ("경북", "庆尚北道"),
    ("경남", "庆尚南道"),
    ("제주", "济州"),
]


def city_from_address(address: str) -> str:
    a = (address or "").strip()
    for prefix, city in CITY_PREFIX:
        if a.startswith(prefix):
            return city
    return "韩国"


def fetch_studio(sid: int):
    """返回 (sid, name, address, has_timetable)；不存在的 id 返回 name=None"""
    url = f"{BASE}/studios/{sid}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "RSC": "1"})
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read().decode("utf-8", "replace")
    except Exception:
        return (sid, None, "", False)

    m = TITLE_RE.search(body)
    if not m:
        return (sid, None, "", False)
    name = m.group(1).strip()
    if name in PLACEHOLDER_TITLES:
        return (sid, None, "", False)

    addr = ADDRESS_RE.search(body)
    return (sid, name, addr.group(1) if addr else "", bool(TIMETABLE_RE.search(body)))


def scan(id_from: int, id_to: int, workers: int = 14):
    ids = list(range(id_from, id_to + 1))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        rows = list(ex.map(fetch_studio, ids))
    return [r for r in rows if r[1]]


def build(sid: int, name: str, address: str, has_tt: bool, all_cities: bool):
    city = city_from_address(address)
    # 没有课表的场馆一律停用；默认只启用首尔，--all-cities 时全部启用
    enabled = has_tt and (all_cities or city == "首尔")
    return {
        "id": f"rawgraphy-{sid}",
        "enabled": enabled,
        "label": name,
        "auto": True,
        "studio": {
            "name": name,
            "city": city,
            "region": "OVERSEAS",
        },
        "mode": "rawgraphy",
        "rawgraphy": {
            "studioId": sid,
            "baseUrl": BASE,
        },
        # timeTable 只给出「本周（周一~周日）」一整周，给 14 天窗口留余量
        "dateMode": "nextDays",
        "days": 14,
        "dates": [],
        "refreshHours": 24,
        "cron": None,
        "timeFormat": "HH:mm-HH:mm",
        "address": address,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--range", nargs=2, type=int, default=[1, 120], metavar=("FROM", "TO"))
    ap.add_argument("--workers", type=int, default=14)
    ap.add_argument("--all-cities", action="store_true", help="非首尔场馆也一并启用")
    args = ap.parse_args()

    out_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "server/src/crawler/studios.rawgraphy.json",
    )

    lo, hi = args.range
    print(f"扫描 rawgraphy studio id {lo}~{hi} ...")
    rows = scan(lo, hi, args.workers)
    print(f"命中 {len(rows)} 家（含课表 {sum(1 for r in rows if r[3])} 家）\n")

    configs = [build(sid, name, addr, tt, args.all_cities) for sid, name, addr, tt in rows]

    configs.sort(key=lambda c: (c["studio"]["city"] != "首尔", c["rawgraphy"]["studioId"]))

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(configs, f, ensure_ascii=False, indent=1)

    print(f"生成配置 {len(configs)} 条 → {out_path}\n")
    for c in configs:
        flag = "启用" if c["enabled"] else "停用"
        print(f"  [{flag}] id={c['rawgraphy']['studioId']:<4} {c['studio']['city']:<5} {c['label']}")

    from collections import Counter
    print("\n按城市分布：")
    for k, v in Counter(c["studio"]["city"] for c in configs).most_common():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
