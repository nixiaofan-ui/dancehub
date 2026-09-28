#!/usr/bin/env python3
"""一次性脚本：给库里的城市生成拼音（全拼 + 首字母），落盘成 JSON，
供 /api/cities 返回前端做「按首字母分组 + 拼音搜索」。

    node server/scripts/dump-cities.cjs     # 先导出 /tmp/dh-cities.json
    python3 server/scripts/gen-city-pinyin.py

产出：server/src/data/city-pinyin.json  —— {"北京": {"p":"beijing","i":"BJ"}, ...}
运行时零依赖：真正跑服务的小程序后端只读这张表，不再需要 pypinyin。
"""
import json
import re
import pathlib

from pypinyin import lazy_pinyin, Style

SRC = pathlib.Path("/tmp/dh-cities.json")
DST = pathlib.Path(__file__).resolve().parent.parent / "src" / "data" / "city-pinyin.json"

HAN = re.compile(r"[\u4e00-\u9fa5]")


def main():
    if not SRC.exists():
        raise SystemExit("缺少 " + str(SRC) + "，先跑 dump-cities.cjs")
    cities = json.loads(SRC.read_text(encoding="utf8"))

    out = {}
    for c in cities:
        name = c["name"]
        if not HAN.search(name):
            # 海外/英文名：全拼就是自身小写，首字母取第一个字符
            out[name] = {"p": name.lower(), "i": name[0].upper()}
            continue
        full = "".join(lazy_pinyin(name))
        # 首字母只取汉字部分，避免「市」之类后缀污染；多音字用常见读音即可
        initials = "".join(lazy_pinyin(name, style=Style.FIRST_LETTER))
        out[name] = {"p": full, "i": initials.upper()}

    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf8")
    print("写入", DST, "共", len(out), "个城市")
    for demo in ("北京", "上海", "西安", "厦门", "重庆"):
        if demo in out:
            print("  ", demo, out[demo])


if __name__ == "__main__":
    main()
