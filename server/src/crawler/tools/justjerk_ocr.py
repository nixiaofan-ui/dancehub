#!/usr/bin/env python3
"""JustJerk（저스트절크）官网课表图片 → 结构化课程 JSON。

背景
----
justjerk.co.kr 是 Imweb 建站，Hapjeong / Ewha 两个校区的 SCHEDULE 页
**没有任何机器可读的接口**，只挂一张「本月课表」图片，页面文案明确写着
「상세한 공지 및 스케쥴 확인은 아래 인스타그램에서 가능합니다」（详细课表请看 Instagram）。
Instagram 官方 API 拿不到他人账号内容，所以这里走「图片 → 结构化」路线。

技术路线
--------
1. 像素分析检测纵向表格线 → 得到「时间列 + 各星期列」的列边界（表格线纯黑、对比度高，
   比用文字坐标猜更稳）；
2. macOS Vision 框架 OCR（韩英混排），输出文字 + 归一化包围盒；
3. **按文字行聚类**切分表格行——课表内部分隔线太细检测不到，靠文字纵向间距聚类更可靠；
   行分三类：表头 / 日期行（星期列里是 1~2 位数字）/ 课程行；
4. 日期行 → 「周序号」，课程行 → 「第几个时段」，与左侧时间标签列对齐；
5. 用「OCR 出的日号」反推第一周周一（逐候选打分，容错 OCR 误读），再按日历推算全部日期；
6. 图例 LV1~LV5 的星号颜色当色卡，单元格内星号颜色 → 难度等级。

依赖（macOS）：Pillow + numpy + pyobjc-framework-Vision / Quartz
    pip install pyobjc-framework-Vision pyobjc-framework-Quartz pillow numpy

用法
----
    python3 justjerk_ocr.py <课表图片> --branch hapjeong [--today 2026-09-26]
                            [--debug-dir /tmp/jjdebug]

输出（stdout，JSON）：见 README 或直接跑一次看结构。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile

import numpy as np
from PIL import Image

# ---------------------------------------------------------------- 常量

WEEKDAY_HEADERS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
MONTH_LABELS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

# 单元格里出现的「课程类型标签」，这些不是教练名
CLASS_TAGS = {
    "PRO CLASS", "PROCLASS", "AUDITION", "FREESTYLE", "POP-UP", "POPUP",
    "K-POP", "KPOP", "SHOW ME THE MOVE", "SHOWMETHEMOVE", "OPEN CLASS",
    "HEELS", "WAACKING", "HOUSE", "LOCKING", "POPPING", "VOGUE", "KRUMP",
    "HIPHOP", "HIP-HOP", "JAZZ", "CONTEMPO", "CONTEMPORARY", "CHOREO",
    "CHOREOGRAPHY", "BASIC", "BASICS", "SPECIAL", "WORKSHOP", "GUEST",
    "BEGINNER", "INTERMEDIATE", "ADVANCED", "ALL LEVEL", "ALL LEVELS",
    "BATTLE", "SHOWCASE", "TRAINING", "REGULAR CLASS",
}

LEVEL_DIFFICULTY = {1: "BEGINNER", 2: "BEGINNER", 3: "INTERMEDIATE", 4: "ADVANCED", 5: "ADVANCED"}
DEFAULT_DURATION_MIN = 90  # 单元格自带时间（如 Ewha 周日的 3PM）时，用这个时长补结束时间
# JustJerk 常规课固定三档（左侧时间标签识别不到时的兜底）
DEFAULT_SLOTS = ["06:00-07:20", "07:20-08:40", "08:40-10:00"]

LEVEL_COLORS = {
    1: (0.20, 0.45, 0.95),
    2: (0.30, 0.75, 0.35),
    3: (0.95, 0.80, 0.20),
    4: (0.95, 0.55, 0.15),
    5: (0.90, 0.20, 0.25),
}

JUNK_CHARS = ":;'\"`´’‘=.,*_|~^+()<>[]{}!?·•∙※"
TIME_RE = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{2})\s*[-~–—]\s*(\d{1,2})\s*[:：]\s*(\d{2})")
INLINE_TIME_RE = re.compile(r"^(\d{1,2})\s*[:：]?\s*(\d{2})?\s*(PM|AM)$", re.I)
# 允许出现在教练名/课程名里的字符（其余字符视为 OCR 噪声，直接丢弃）
NAME_CHARS = re.compile(r"^[A-Za-z가-힣][A-Za-z0-9가-힣 .\-&'/]*$")


# ---------------------------------------------------------------- OCR

def _vision_ocr(path: str, langs=("ko-KR", "en-US")) -> list[dict]:
    """macOS Vision OCR，返回 [{text, conf, x, y, w, h}]（归一化坐标，原点左上）。"""
    import Quartz
    import Vision
    from Foundation import NSURL

    url = NSURL.fileURLWithPath_(path)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    if src is None:
        raise RuntimeError(f"无法读取图片: {path}")
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)

    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(1)  # accurate
    req.setRecognitionLanguages_(list(langs))
    req.setUsesLanguageCorrection_(False)

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise RuntimeError(f"OCR 失败: {err}")

    out = []
    for obs in req.results() or []:
        cand = obs.topCandidates_(1)
        if not cand:
            continue
        bb = obs.boundingBox()
        out.append({
            "text": str(cand[0].string()),
            "conf": float(cand[0].confidence()),
            "x": float(bb.origin.x),
            "y": 1.0 - float(bb.origin.y) - float(bb.size.height),
            "w": float(bb.size.width),
            "h": float(bb.size.height),
        })
    return out


def ocr_crop(pil_img: Image.Image, scale: int = 3, langs=("ko-KR", "en-US")) -> list[dict]:
    """放大后 OCR 小区域（读小字号日期用）。返回坐标相对该裁剪区域、已归一化。"""
    big = pil_img.resize((pil_img.width * scale, pil_img.height * scale), Image.LANCZOS)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
        tmp = tf.name
    try:
        big.save(tmp)
        return _vision_ocr(tmp, langs)
    finally:
        os.unlink(tmp)


# ---------------------------------------------------------------- 栅格检测

def gray_array(path: str, max_w: int = 2400):
    im = Image.open(path).convert("RGB")
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    arr = np.asarray(im)
    return im, arr, arr.mean(axis=2)


def _group(idx: list[int], gap: int = 3) -> list[int]:
    if not idx:
        return []
    groups, cur = [], [idx[0]]
    for v in idx[1:]:
        if v - cur[-1] <= gap:
            cur.append(v)
        else:
            groups.append(int(round(sum(cur) / len(cur))))
            cur = [v]
    groups.append(int(round(sum(cur) / len(cur))))
    return groups


def detect_vlines(gray: np.ndarray) -> list[int]:
    """检测纵向表格线（只统计上半部，避开右下角的活动宣传图）。"""
    h, w = gray.shape
    dark = gray < 115
    band = dark[int(h * 0.10):int(h * 0.48), :]
    frac = band.mean(axis=0)
    return _group([x for x in range(w) if frac[x] > 0.72], gap=4)


def _dedupe(xs: list[int], tol: float) -> list[int]:
    out: list[int] = []
    for x in sorted(xs):
        if not out or x - out[-1] > tol:
            out.append(x)
    return out


def build_columns(gray: np.ndarray, w: int, weekdays: int, items: list[dict]) -> tuple[list[tuple[int, int]], str]:
    """列边界 = (0, 各列左边界..., w)。

    优先用检测到的表格竖线；Hapjeong 的线很清晰，直接命中。
    Ewha 的竖线偏淡（彩色/低对比）常检测不到，此时用「时间标签 / LV 图例
    token 的最右边缘」估计左侧标签列宽度，剩余宽度按星期数等分。
    返回 (列区间, 用了哪种方式) 便于排查。
    """
    v = [x for x in detect_vlines(gray) if 0.012 * w < x < 0.985 * w]
    v = _dedupe(v, tol=0.012 * w)
    if len(v) == weekdays:
        bounds = [0] + v + [w]
        cols = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
        if all(r - l > 0.02 * w for l, r in cols):
            return cols, "gridline"

    # 兜底：时间标签与图例一定落在最左列，用它们的最右边缘当左列宽度
    left_tokens = [
        it for it in items
        if TIME_RE.search(it["text"]) or re.fullmatch(r"\s*LV\s*[1-5]\D*", it["text"].strip().upper())
    ]
    if left_tokens:
        left = min(0.42 * w, max((it["x"] + it["w"]) * w for it in left_tokens) + 0.02 * w)
    else:
        left = 0.16 * w
    step = (w - left) / weekdays
    bounds = [0, left] + [round(left + step * i) for i in range(1, weekdays + 1)]
    cols = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
    return cols, "even-split"


def columns_from_vlines(vlines: list[int], w: int) -> list[tuple[int, int]]:
    """兼容旧接口：纵线 → 各列 (left, right)。"""
    bounds = sorted(set([0] + vlines + [w]))
    cols = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
    if len(cols) < 4:
        n = 7
        cols = [(round(w * i / n), round(w * (i + 1) / n)) for i in range(n)]
    return cols


# ---------------------------------------------------------------- 颜色 → 等级

def _sat_pixels(arr: np.ndarray, box) -> list[tuple[float, float, float]]:
    """取区域内高饱和且较亮的像素（抓彩色星号，跳过黑字与灰底）。"""
    h, w = arr.shape[:2]
    x0, y0, x1, y1 = (int(v) for v in box)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    if x1 <= x0 or y1 <= y0:
        return []
    sub = arr[y0:y1, x0:x1].reshape(-1, 3).astype(float) / 255.0
    mx, mn = sub.max(axis=1), sub.min(axis=1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    return [tuple(p) for p in sub[(sat > 0.35) & (mx > 0.35)]]


def read_legend_palette(arr: np.ndarray, items: list[dict], w: int, h: int) -> dict[int, tuple]:
    """从图例 LV1~LV5 采样星号颜色作为色卡，缺的用内置色补。"""
    palette: dict[int, tuple] = {}
    for it in items:
        m = re.fullmatch(r"LV\s*([1-5])\D*", it["text"].strip().upper())
        if not m:
            continue
        lv = int(m.group(1))
        yc = (it["y"] + it["h"] / 2) * h
        x0 = (it["x"] + it["w"]) * w
        px = _sat_pixels(arr, (x0 - 2, yc - it["h"] * h * 0.9, x0 + w * 0.04, yc + it["h"] * h * 0.9))
        if px:
            palette[lv] = tuple(np.mean(px, axis=0))
    for lv, c in LEVEL_COLORS.items():
        palette.setdefault(lv, c)
    return palette


def match_level(color: tuple, palette: dict[int, tuple]) -> int | None:
    best, bestd = None, 1e9
    for lv, ref in palette.items():
        d = sum((a - b) ** 2 for a, b in zip(color, ref))
        if d < bestd:
            best, bestd = lv, d
    return best if bestd < 0.15 else None


# ---------------------------------------------------------------- 文本解析

def normalise_separators(s: str) -> str:
    """把分隔符/噪声字符统一成 "/"：OCR 常把星号、逗号、方括号读成各种怪符号，
    而这些恰好都出现在「名字 · 名字」的分界处，统一当分隔符最省事。"""
    return re.sub(r"[^A-Za-z0-9가-힣 .\-&']", "/", s)


def split_parts(text: str) -> list[str]:
    return [p for p in normalise_separators(text).split("/") if p.strip()]


def clean_name(s: str) -> str:
    s = re.sub(r"\s{2,}", " ", s).strip()
    # 贴在名字末尾的孤立数字（OCR 把星号读成 1/4 之类）与句点
    s = re.sub(r"(?<=[A-Za-z가-힣])[0-9]+$", "", s)
    return re.sub(r"[-–—\.]+$", "", s).strip()


def is_tag(name: str) -> bool:
    n = name.upper().replace(" ", "")
    return any(n == t.replace(" ", "") for t in CLASS_TAGS)


def plausible(name: str) -> bool:
    """过滤 OCR 噪声（宣传图上的乱码）：只保留形如人名/课程名的短串。"""
    if not (2 <= len(name) <= 24):
        return False
    if not NAME_CHARS.match(name):  # 首字符必须是字母/韩文，排除 "54AII" 之类
        return False
    letters = sum(c.isalpha() for c in name)
    return letters >= max(2, len(name) * 0.6)


def parse_cell_text(text: str) -> dict:
    """单元格文本 → {courseName, coaches:[str], raw}（供离线校验 / 调试用）。"""
    raw = text.strip()
    names, tags = [], []
    for p in split_parts(raw):
        nm = clean_name(p)
        if not plausible(nm):
            continue
        (tags if is_tag(nm) else names).append(nm)
    return {
        "courseName": " · ".join(tags) if tags else "OPEN CLASS",
        "coaches": names,
        "raw": raw,
    }


def normalise_day(txt: str) -> int | None:
    """抠出「日」数字，兼容 8/31、8.31、8131（斜杠被识别成 1）。"""
    t = re.sub(r"\s+", "", txt)
    if not t:
        return None
    m = re.search(r"(\d{1,2})[/\.\-](\d{1,2})", t)
    if m and 1 <= int(m.group(2)) <= 31:
        return int(m.group(2))
    digits = re.sub(r"\D", "", t)
    if not digits:
        return None
    if len(digits) == 4:
        for cut in (1, 2):
            a, b = digits[:cut], digits[cut:]
            if 1 <= int(a) <= 12 and 1 <= int(b) <= 31:
                return int(b)
        return None
    if len(digits) <= 2:
        v = int(digits)
        return v if 1 <= v <= 31 else None
    return None


def resolve_anchor(day_map: dict[tuple[int, int], int], month: int, today: dt.date) -> dt.date | None:
    """由 OCR 出的日号反推第一周周一：逐候选打分取最吻合（容错个别误读）。"""
    if not day_map:
        return None
    cands, d = [], today - dt.timedelta(days=45)
    end = today + dt.timedelta(days=75)
    while d <= end:
        if d.weekday() == 0 and d.month in {month, (month - 1) or 12}:
            cands.append(d)
        d += dt.timedelta(days=1)

    best, best_hit = None, -1
    for a in cands:
        hit = sum(
            1 for (wk, col), day in day_map.items()
            if (a + dt.timedelta(days=7 * wk + col)).day == day
        )
        if hit > best_hit:
            best, best_hit = a, hit
    return best


# ---------------------------------------------------------------- 行聚类

def cluster_rows(items: list[dict]):
    """按文字纵向间距聚类成「行」。课表内部分隔线太细检测不到，用间距更稳。"""
    if not items:
        return []
    med_h = float(np.median([it["h"] for it in items]))
    ordered = sorted(items, key=lambda it: it["y"] + it["h"] / 2)
    rows, cur = [], [ordered[0]]
    for it in ordered[1:]:
        cur_center = float(np.mean([c["y"] + c["h"] / 2 for c in cur]))
        if (it["y"] + it["h"] / 2) - cur_center > med_h * 0.85:
            rows.append(cur)
            cur = [it]
        else:
            cur.append(it)
    rows.append(cur)
    return rows


def cell_of(x_norm: float, w: int, cols: list[tuple[int, int]]) -> int | None:
    cx = x_norm * w
    for i, (l, r) in enumerate(cols):
        if l <= cx < r:
            return i
    return None


# ---------------------------------------------------------------- 主流程

def parse_schedule(img_path: str, branch: str, today: dt.date,
                   debug_dir: str | None = None, weekdays: int | None = None) -> dict:
    im, arr, gray = gray_array(img_path)
    w, h = im.size

    raw_items = _vision_ocr(img_path)
    med_h = float(np.median([it["h"] for it in raw_items])) if raw_items else 0.01
    # 丢掉超大字号（标题 / 「STRONGER」水印）与超低置信度噪声
    items = [it for it in raw_items if it["h"] <= med_h * 2.2 and it["conf"] >= 0.2]

    # 表头：月份标签 + 星期列（Ewha 的表头是彩色低对比，经常识别不出来 → 靠 weekdays 参数兜底）
    header = [it for it in items if it["y"] + it["h"] / 2 < 0.17]
    header_text = " ".join(it["text"].upper() for it in header)
    month = next((MONTH_LABELS[it["text"].strip().upper()[:3]]
                  for it in header if it["text"].strip().upper()[:3] in MONTH_LABELS), None)
    weekday_cols = [d for d in WEEKDAY_HEADERS if d in header_text]
    n_weekdays = weekdays or len(weekday_cols) or 6

    cols, col_mode = build_columns(gray, w, n_weekdays, items)
    data_col_start = 1  # 第 0 列是月份 / 时间标签列

    palette = read_legend_palette(arr, items, w, h)

    rows = cluster_rows(items)

    def is_day_token(t: dict) -> bool:
        return bool(re.fullmatch(r"[\d/\.\-]{1,4}", re.sub(r"\s+", "", t["text"])))

    # ① 找出「日期行」→ 每周的起始 y、日期数字；顺带收集左侧时间标签的位置
    week_y: list[float] = []
    week_span: list[tuple[float, float]] = []
    day_map: dict[tuple[int, int], int] = {}
    time_marks: list[tuple[str, float]] = []
    debug_rows: list[dict] = []

    for row in rows:
        by_col: dict[int, list[dict]] = {}
        for it in row:
            ci = cell_of(it["x"] + it["w"] / 2, w, cols)
            if ci is not None:
                by_col.setdefault(ci, []).append(it)
        if not by_col:
            continue

        texts = {ci: " ".join(t["text"] for t in sorted(v, key=lambda t: t["x"]))
                 for ci, v in by_col.items()}

        tm = TIME_RE.search(texts.get(0, ""))
        if tm:
            label = f"{int(tm.group(1)):02d}:{tm.group(2)}-{int(tm.group(3)):02d}:{tm.group(4)}"
            time_marks.append((label, float(np.mean([t["y"] + t["h"] / 2 for t in row]))))

        data_cols = [ci for ci in sorted(texts) if ci >= data_col_start]
        if not data_cols:
            continue

        day_tokens = {ci: [t for t in by_col[ci] if is_day_token(t)] for ci in data_cols}
        n_day = sum(len(v) for v in day_tokens.values())
        n_tok = sum(len(by_col[ci]) for ci in data_cols)
        # 日期行判定：超过一个短数字，或整行只有一两个 token 且含数字
        # （OCR 对小字号 1~9 常漏识，所以不能要求认全）
        if not (n_day >= 2 or (n_day >= 1 and n_tok <= 2)):
            continue

        week = len(week_y)
        week_y.append(float(np.mean([t["y"] + t["h"] / 2 for t in row])))
        week_span.append((min(t["y"] for t in row), max(t["y"] + t["h"] for t in row)))
        for ci in data_cols:
            for t in day_tokens[ci]:
                d = normalise_day(t["text"])
                if d:
                    day_map[(week, ci - data_col_start)] = d
        # 漏识的日期：放大该行重认（只在整行没有课程文字时才做，免得把课程名当日期）
        missing = [ci for ci in data_cols if (week, ci - data_col_start) not in day_map]
        if missing and n_tok <= 2:
            pitch = row_pitch(rows)
            y0 = int(max(0, (week_span[week][0] - pitch)) * h)
            y1 = int(min(h, (week_span[week][1] + pitch)) * h)
            fine_by_col: dict[int, list[dict]] = {}
            for it in ocr_crop(im.crop((0, y0, w, y1))):
                ci = cell_of(it["x"] + it["w"] / 2, w, cols)
                if ci is not None:
                    fine_by_col.setdefault(ci, []).append(it)
            for ci in missing:
                for t in fine_by_col.get(ci, []):
                    d = normalise_day(t["text"])
                    if d:
                        day_map[(week, ci - data_col_start)] = d
                        break
        debug_rows.append({"band": "date", "week": week,
                           "days": {k[1]: v for k, v in day_map.items() if k[0] == week},
                           "texts": [texts.get(c, "") for c in data_cols]})

    # ② 时段表：JustJerk 常规课固定三档，用左侧时间标签的 y 位置拟合 y = a + b * slot，
    #    这样即使某周漏掉一条分隔、或某格只有一行课，也能落回正确的时段。
    slots = list(DEFAULT_SLOTS)
    slot_fit = fit_slots(time_marks, row_pitch(rows))
    unknown_slots = sorted({lbl for lbl, _ in time_marks if lbl not in DEFAULT_SLOTS})

    # ③ 按「周 × 列」收纳 token，再按时段带切成条目
    entries: list[dict] = []
    if week_y:
        base_y = week_y[0]

        def slot_of(cy: float, wk: int) -> int | None:
            if not slot_fit:
                return None
            a, b = slot_fit
            return int(round((cy - (week_y[wk] - base_y) - a) / b))

        cells: dict[tuple[int, int], list[dict]] = {}
        for it in items:
            cy = it["y"] + it["h"] / 2
            ci = cell_of(it["x"] + it["w"] / 2, w, cols)
            if ci is None or ci < data_col_start or cy < week_span[0][0]:
                continue
            wk = max((i for i, wy in enumerate(week_y) if wy <= cy), default=None)
            if wk is None:
                continue
            # 日期行自己的数字不是课程内容
            if is_day_token(it) and week_span[wk][0] - 1e-4 <= cy <= week_span[wk][1] + 1e-4:
                continue
            cells.setdefault((wk, ci - data_col_start), []).append(it)

        for (wk, col), cell_items in sorted(cells.items()):
            cell_items = sorted(cell_items, key=lambda t: (t["y"], t["x"]))
            chunks = split_by_inline_time(cell_items)
            if len(chunks) == 1 and chunks[0]["time"] is None:
                # 常规格：一行一个时段，按 y 落到对应时段带
                groups: dict[int, list[dict]] = {}
                for it in cell_items:
                    s = slot_of(it["y"] + it["h"] / 2, wk)
                    if s is not None and 0 <= s < len(slots):
                        groups.setdefault(s, []).append(it)
                for s, toks in sorted(groups.items()):
                    push_entry(entries, arr, palette, w, h, wk, col, s, None, toks)
            else:
                # 格里自带时间（Ewha 周日的 3PM / 430PM）
                for ch in chunks:
                    if not ch["items"]:
                        continue
                    push_entry(entries, arr, palette, w, h, wk, col, 0, ch["time"], ch["items"])

        debug_rows.append({"band": "cells", "count": len(cells), "colMode": col_mode})

    slot_fallback = slot_fit is None

    anchor = resolve_anchor(day_map, month or today.month, today)

    for e in entries:
        inline = e.pop("inlineTime", None)
        if inline:
            e["startTime"] = inline
            e["endTime"] = add_minutes(inline, DEFAULT_DURATION_MIN)
        elif 0 <= e["slot"] < len(slots):
            a, b = slots[e["slot"]].split("-")
            e["startTime"], e["endTime"] = a, b
        e["date"] = (anchor + dt.timedelta(days=7 * e["week"] + e["col"])).isoformat() if anchor else None

    entries = [e for e in entries if e.get("date") and e.get("startTime")]

    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        draw_debug(im, cols, debug_dir, branch, rows, h)
        with open(os.path.join(debug_dir, f"{branch}-rows.json"), "w", encoding="utf-8") as f:
            json.dump({"vlines": detect_vlines(gray), "rows": debug_rows}, f, ensure_ascii=False, indent=1)

    return {
        "branch": branch,
        "image": os.path.basename(img_path),
        "month": month,
        "year": anchor.year if anchor else today.year,
        "anchor": anchor.isoformat() if anchor else None,
        "columns": weekday_cols or WEEKDAY_HEADERS[:n_weekdays],
        "columnMode": col_mode,
        "slots": slots,
        "slotFallback": slot_fallback,
        "unknownSlotLabels": unknown_slots,
        "levelPalette": {str(k): [round(float(x), 3) for x in v] for k, v in palette.items()},
        "dateMap": {f"{k[0]}-{k[1]}": v for k, v in sorted(day_map.items())},
        "entries": entries,
    }


def split_by_inline_time(cell_items: list[dict]) -> list[dict]:
    """单元格内的 3PM / 430PM 之类的自带时间 → 切成若干块（按 y 排序，保证互不重叠）。"""
    marks = sorted(
        (it for it in cell_items if INLINE_TIME_RE.match(re.sub(r"\s+", "", it["text"]))),
        key=lambda t: t["y"],
    )
    if not marks:
        return [{"time": None, "items": cell_items}]
    out = []
    for i, mk in enumerate(marks):
        top = mk["y"] - mk["h"] * 0.4
        bottom = marks[i + 1]["y"] - marks[i + 1]["h"] * 0.4 if i + 1 < len(marks) else 1.1
        if bottom <= top:  # 同一位置的重复标记，跳过
            continue
        group = [it for it in cell_items if top <= it["y"] < bottom and it is not mk]
        t = INLINE_TIME_RE.match(re.sub(r"\s+", "", mk["text"]))
        hh = int(t.group(1))
        mm = int(t.group(2) or 0)
        if t.group(3).upper() == "PM" and hh < 12:
            hh += 12
        out.append({"time": f"{hh:02d}:{mm:02d}", "items": group})
    return out or [{"time": None, "items": cell_items}]


def name_box(token: dict, i: int, n: int, w: int, h: int) -> tuple:
    """token 包围盒横向 n 等分，取第 i 段右侧条带（星号所在位置）作为颜色采样区。"""
    x0, x1 = token["x"], token["x"] + token["w"]
    span = (x1 - x0) / max(1, n)
    seg1 = x0 + span * (i + 1)
    return (
        (seg1 - span * 0.30) * w,
        (token["y"] - token["h"] * 0.2) * h,
        (seg1 + token["w"] * 0.05) * w,
        (token["y"] + token["h"] * 1.2) * h,
    )


def extract_coaches(cell_items: list[dict], arr, palette, w: int, h: int):
    """逐 token 抽教练名 + 课程标签；名字右侧星号的颜色 → 难度等级。"""
    coaches, tags = [], []
    for it in sorted(cell_items, key=lambda t: (t["y"], t["x"])):
        parts = split_parts(it["text"])
        if not parts:
            continue
        n = len(parts)
        for i, p in enumerate(parts):
            nm = clean_name(p)
            if not plausible(nm):
                continue
            if is_tag(nm):
                tags.append(nm)
                continue
            px = _sat_pixels(arr, name_box(it, i, n, w, h))
            lv = match_level(tuple(np.mean(px, axis=0)), palette) if px else None
            coaches.append({"name": nm, "level": lv})
    return coaches, tags


def fit_slots(time_marks: list[tuple[str, float]], pitch_hint: float):
    """由左侧时间标签的 y 位置拟合 y = a + b * slot（归一化坐标）。"""
    pts = sorted((DEFAULT_SLOTS.index(lbl), y) for lbl, y in time_marks if lbl in DEFAULT_SLOTS)
    if not pts:
        return None
    if len(pts) == 1:
        i0, y0 = pts[0]
        return (y0 - pitch_hint * i0, pitch_hint)
    (i0, y0), (i1, y1) = pts[0], pts[-1]
    if i1 == i0:
        return None
    b = (y1 - y0) / (i1 - i0)
    return (y0 - b * i0, b)


def push_entry(entries, arr, palette, w, h, week, col, slot, inline_time, toks) -> None:
    coaches, tags = extract_coaches(toks, arr, palette, w, h)
    if not coaches:
        return
    entries.append({
        "week": week,
        "col": col,
        "slot": slot,
        "inlineTime": inline_time,
        "courseName": " · ".join(tags) if tags else "OPEN CLASS",
        "coaches": coaches,
        "raw": " ".join(t["text"] for t in toks),
    })


def row_pitch(rows: list[list[dict]]) -> float:
    """相邻文字行的典型间距（归一化），用于给日期行 OCR 裁剪留出上下余量。"""
    if len(rows) < 2:
        return 0.02
    centers = sorted(float(np.mean([t["y"] + t["h"] / 2 for t in r])) for r in rows)
    gaps = [b - a for a, b in zip(centers, centers[1:]) if b - a > 0.001]
    return float(np.median(gaps)) * 0.75 if gaps else 0.02


def add_minutes(hhmm: str, minutes: int) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    total = h * 60 + m + minutes
    return f"{(total // 60) % 24:02d}:{total % 60:02d}"


def draw_debug(im: Image.Image, cols, debug_dir: str, branch: str, rows, h: int) -> None:
    from PIL import ImageDraw

    dbg = im.copy()
    dr = ImageDraw.Draw(dbg)
    for (l, r) in cols:
        dr.line([(l, 0), (l, dbg.height)], fill=(255, 0, 0), width=3)
    for row in rows:
        y = int(np.mean([t["y"] + t["h"] / 2 for t in row]) * dbg.height)
        dr.line([(0, y), (dbg.width, y)], fill=(0, 120, 255), width=2)
    dbg.save(os.path.join(debug_dir, f"{branch}-rows.png"))


def main() -> int:
    ap = argparse.ArgumentParser(description="JustJerk 课表图片 → 结构化 JSON")
    ap.add_argument("image", help="课表图片路径")
    ap.add_argument("--branch", default="hapjeong", help="校区标识（hapjeong / ewha）")
    ap.add_argument("--today", default=None, help="基准日期 YYYY-MM-DD（默认今天）")
    ap.add_argument("--debug-dir", default=None, help="输出调试图目录")
    ap.add_argument("--weekdays", type=int, default=None, help="星期列数（表头识别不出时用，Hapjeong=6 / Ewha=7）")
    ap.add_argument("--summary", action="store_true", help="只打印可读摘要")
    args = ap.parse_args()

    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    res = parse_schedule(args.image, args.branch, today, args.debug_dir, args.weekdays)

    if args.summary:
        print(f"[{res['branch']}] {res['year']}-{res['month']:02d} anchor={res['anchor']} "
              f"slots={res['slots']}")
        cur = None
        for e in sorted(res["entries"], key=lambda x: (x["date"], x["startTime"])):
            if e["date"] != cur:
                cur = e["date"]
                print(f"\n{cur}")
            cs = " / ".join(f"{c['name']}{'' if c['level'] is None else '·LV' + str(c['level'])}"
                            for c in e["coaches"])
            print(f"  {e['startTime']}-{e['endTime']}  {e['courseName']:<20} {cs}")
        print(f"\n总计 {len(res['entries'])} 条")
    else:
        json.dump(res, sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
