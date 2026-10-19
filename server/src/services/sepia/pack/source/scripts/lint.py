#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sepia-webnovel 机械项校验器

用法：
    python scripts/lint.py <正文文件> [--quiet] [--json]

设计原则：
1. 词表不在这里硬编码，全部从 references/ 下的规则文件解析。规则改了，脚本自动跟上。
2. 只查能机械判定的项。语义项（开篇是否镜头式、是否内心总结句）只给候选，不判死。
3. 不伪造朱雀分数。输出的是"机械项风险提示"，不是检测器结果。
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(BASE, "references")

# 情节必需的常用词，收在道具黑名单里时只做"警惕提示"，不当硬伤
# ——"钥匙""手机"是小说必需品，禁掉整篇就没法写。
# 定义在模块级而非 load_banned_words() 内：check() 会直接引用它，
# 放在函数里赋值会形成隐式的调用顺序依赖（导入后直接 check() 即 NameError）。
SOFT_WORDS = {
    "钥匙", "手机", "鞋子", "拖鞋", "餐桌", "晚餐", "闹钟", "计时器",
    "旧相册", "老照片", "旧报纸", "监控摄像头", "楼层按钮", "电梯面板",
    "微缩胶片", "手写纸条", "匿名信", "U盘", "监控截图", "录像回放",
    "百度街景", "地图年份",
}

# ---------------------------------------------------------------- 词表解析


def _read(rel):
    p = os.path.join(REF, rel)
    if not os.path.exists(p):
        return ""
    with open(p, encoding="utf-8") as f:
        return f.read()


def load_banned_words():
    """从 banned-words.md 解析禁用词。

    来源有两处：
    - 一、二节是围栏代码块，竖线分隔
    - 三、四、五节是表格，第一列可能含多个候选（用 / 或 | 分隔）
    """
    text = _read("zh-fiction/banned-words.md")
    words = set()

    # 1) 围栏代码块（一、二节的 |分隔 列表）
    for block in re.findall(r"```\n(.+?)\n```", text, re.S):
        for tok in re.split(r"[|\n]", block):
            tok = tok.strip()
            if tok and len(tok) >= 2:
                words.add(tok)

    # 2) 表格第一列：| 模板 | 说明 |
    for line in text.splitlines():
        if not line.startswith("|") or line.startswith("|:") or "---" in line:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells:
            continue
        first = cells[0]
        # 跳过表头与说明列
        if first in ("AI词/句式", "AI模板句式", "模板句式", "AI词", "反例"):
            continue
        # 拆出带引号或书名号的短词
        for m in re.findall(r"[「\"“]([^」\"”]{2,12})[」\"”]", first):
            words.add(m.strip())
        # 纯 ASCII 词（如 U盘、百度街景）与短中文短语
        for part in re.split(r"\s*/\s*|\s*\|\s*", first):
            part = re.split(r"[（(]", part)[0].strip()
            if 2 <= len(part) <= 10 and re.search(r"[\u4e00-\u9fff]", part) and "……" not in part:
                words.add(part)

    # 过滤掉规则说明性的词条（含"式""用法""模板"做后缀的描述）
    drop_suffix = ("用法", "式堆砌", "式收尾", "模板")
    drop_exact = {"进行", "作为", "关于", "基于", "手机"}   # 规则里是"别滥用"，不是"禁用"
    words = {w for w in words if not w.endswith(drop_suffix) and w not in drop_exact}

    return sorted(words)


def load_sentence_patterns():
    """从 anti-patterns.md 的句式套子表取整句模式（第一列）。"""
    text = _read("zh-fiction/anti-patterns.md")
    pats = []
    for line in text.splitlines():
        if not line.startswith("|") or "---" in line:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        first = cells[0]
        if first in ("反例", "模板道具", "反例", "特征") or first.startswith(":"):
            continue
        # 取不带（）说明的骨架
        if "不是A，而是B" in first:
            pats.append(("不是X，而是Y", r"不是[^。；\n]{1,20}[，,]\s*(?:而是|是)"))
        elif "不禁" in first:
            pats.append(("不禁/不由得/忍不住", r"(?:不禁|不由得|忍不住)"))
        elif "那一刻" in first:
            pats.append(("那一刻…明白/意识到", r"那一刻[^。]{0,15}(?:明白|意识到|懂得)"))
        elif "不知道的是" in first:
            pats.append(("他/她不知道的是", r"不知道的是"))
        elif "深吸一口气" in first:
            pats.append(("深吸一口气", r"深吸一口气"))
        elif "闪过一丝" in first:
            pats.append(("眼中/眼神闪过一丝", r"(?:眼中|眼神|眼底)[^。]{0,6}闪过一丝"))
        elif "说不上来" in first:
            pats.append(("说不上来/难以形容", r"(?:说不上来|难以形容|难以名状)"))
        elif "莫名的" in first:
            pats.append(("一股莫名的/没来由地", r"(?:一股莫名的|没来由地|无缘无故地)"))
        elif "下意识" in first:
            pats.append(("下意识地", r"下意识地"))
    # 去重保序
    seen, out = set(), []
    for n, p in pats:
        if n not in seen:
            seen.add(n)
            out.append((n, p))
    return out


# ---------------------------------------------------------------- 正文切分


def strip_meta(text):
    """去掉标题行、引用行、表格、代码块，只留正文。"""
    lines = text.splitlines()
    out, in_code = [], False
    for ln in lines:
        s = ln.strip()
        if s.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        if s.startswith("#") or s.startswith(">") or s.startswith("|"):
            continue
        if s in ("---", "***"):
            continue
        out.append(ln)
    return "\n".join(out)


def split_body(text):
    """若文件含"## 四、正文"这类分节，只取正文节。"""
    m = re.search(r"^##\s*(?:四、)?正文\s*$", text, re.M)
    if m:
        rest = text[m.end():]
        nxt = re.search(r"^##\s+(?!正文)", rest, re.M)
        return rest[: nxt.start()] if nxt else rest
    return text


def paragraphs(body):
    return [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]


def sentences(text):
    return [s for s in re.split(r"(?<=[。！？!?])", text) if s.strip()]


# ---------------------------------------------------------------- 检查项


def check(text):
    body = strip_meta(split_body(text))
    n_char = len(re.sub(r"\s", "", body))
    paras = paragraphs(body)
    sents = sentences(body)
    res = []

    def add(name, level, detail):
        res.append({"item": name, "level": level, "detail": detail})

    if n_char < 100:
        # 即便正文过短也要先跑完破折号项：merge_deslop() 靠"L1-1 破折号已存在"
        # 来做去重，提前 return 会让 em-dash 只被 deslop 侧单方面报出。
        n_dash = sum(1 for _ in re.finditer(r"—+", body))
        add("正文", "err", f"只识别到 {n_char} 字正文，检查文件格式（正文需用空行分段）")
        add("L1-1 破折号", "err" if n_dash else "ok", f"{n_dash} 处（要求 0）")
        return res, {"chars": n_char, "paras": len(paras), "sents": len(sents)}

    # L1-1 破折号
    # 一处破折号在文件里是「—」或「——」（1 或 2 个横杠字符），必须数**连续串**
    # 而不是字符数，否则「——」会被算成 2 处。
    n = sum(1 for _ in re.finditer(r"—+", body))
    add("L1-1 破折号", "err" if n else "ok", f"{n} 处（要求 0）")
    if n:
        for ln_no, ln in lineno_hits(body, "—"):
            add("  ↳ 位置", "info", f"「{ln[:40]}」")

    # L1-2 禁用词
    # 台词豁免：引号内（弯引号“”）是人物说的话，允许用套词——真人吵架也会说
    # "深吸一口气""眼里闪过一丝"。与 story-deslop 的引号遮罩口径保持一致，
    # 否则同一段台词两套结论，且会逼作者改掉正常的角色口语。
    scan = re.sub(r"“[^”]*”", "", body)
    words = load_banned_words()
    hits, soft_hits = {}, {}
    for w in words:
        c = scan.count(w)
        if c:
            (soft_hits if w in SOFT_WORDS else hits)[w] = c
    # 子串已被长词覆盖的，去掉重复计数（如"空气仿佛凝固了"命中后，"仿佛"不再单算）
    for long_w in list(hits) + list(soft_hits):
        for short_w in list(hits):
            if short_w != long_w and short_w in long_w and long_w in scan:
                hits.pop(short_w, None)
    add("L1-2 禁用词", "err" if hits else "ok",
        f"命中 {sum(hits.values())} 处 / 扫描 {len(words)} 条" if hits else f"0 处（扫描 {len(words)} 条）")
    if hits:
        for w, c in sorted(hits.items(), key=lambda x: -x[1]):
            add("  ↳ 命中", "info", f"{w} × {c}")
    if soft_hits:
        add("道具警惕项（不算硬伤）", "warn",
            "；".join(f"{w}×{c}" for w, c in sorted(soft_hits.items(), key=lambda x: -x[1]))
            + " · 出现两个以上要换掉一半，一个可留")

    # L1-5 引号：要求全角弯引号“”成对；直角「」与半角" 均为 0
    lq = body.count("\u201c")
    rq = body.count("\u201d")
    ascii_q = body.count('"')
    straight = body.count("「") + body.count("」")
    lvl = "err" if (ascii_q or straight or lq != rq) else "ok"
    add("L1-5 引号", lvl,
        f"左\u201c {lq} / 右\u201d {rq} · 直角「」 {straight} · 半角\" {ascii_q}"
        f"（要求：弯引号成对，其余 0）")

    # L1-6 冒号
    n = body.count("：") + body.count(":")
    add("L1-6 冒号", "warn" if n else "ok", f"{n} 处（尽量 0）")

    # L1-9 句式套子（同 L1-2：扫剥掉台词的叙述层，台词内的套词不算）
    pats = load_sentence_patterns()
    pat_hits = []
    for name, pat in pats:
        c = len(re.findall(pat, scan))
        if c:
            pat_hits.append((name, c))
    add("L1-9 句式套子", "err" if pat_hits else "ok",
        "；".join(f"{n} × {c}" for n, c in pat_hits) if pat_hits else "0 处")
    # 不是X而是Y 密度红线：800 字内 3 次
    nx = len(re.findall(r"不是[^。；\n]{1,20}[，,]\s*(?:而是|是)", scan))
    if nx >= 3:
        add("L1-9 不是X而是Y密度", "err", f"{nx} 次（800 字内 ≥3 即硬伤）")
    # L1-12 句号密度
    periods = body.count("。")
    dens = periods / n_char * 100
    lvl = "ok" if 5 <= dens <= 8 else "warn"
    add("L1-12 句号密度", lvl, f"{dens:.1f}/百字（参考 5–8）")

    # 段落节奏
    lens = [len(p) for p in paras]
    avg_s = len(sents) / len(paras) if paras else 0
    uniform = 0
    for i in range(len(lens) - 3):
        seg = lens[i:i + 4]
        if max(seg) - min(seg) <= max(4, min(seg) * 0.15):
            uniform += 1
    add("段落参差", "warn" if uniform >= 3 else "ok",
        f"{len(paras)} 段 · 均 {avg_s:.1f} 句 · 段长 {min(lens)}–{max(lens)}"
        + (f" · 连续 4 段长度雷同 {uniform} 处" if uniform else ""))

    # 相邻同长句
    slens = [len(re.sub(r"\s", "", s)) for s in sents]
    runs, cur = 0, 1
    for i in range(1, len(slens)):
        if abs(slens[i] - slens[i - 1]) <= 3:
            cur += 1
            runs = max(runs, cur)
        else:
            cur = 1
    add("相邻同长句", "warn" if runs >= 3 else "ok", f"最长连续 {runs} 句长度接近（≥3 需打断）")

    # 超长句
    longs = [s for s in sents if len(s) > 55]
    add("超长句", "warn" if len(longs) >= 3 else "ok", f"{len(longs)} 句 >55 字")
    for s in longs[:3]:
        add("  ↳ 长句", "info", f"「{s[:36]}…」")

    # 对话占比
    dialogue = sum(len(re.sub(r"\s", "", m)) for m in re.findall(r"\u201c[^\u201d]*\u201d", body))
    ratio = dialogue / n_char * 100 if n_char else 0
    has_scene = body.count("\u201c") >= 3
    if has_scene and ratio < 30:
        lvl, hint = "warn", "（有角色在场场景要求 ≥30%）"
    elif ratio > 50:
        lvl, hint = "warn", "（>50% 读着像剧本，配比叙述）"
    else:
        lvl, hint = "ok", ""
    add("对话占比", lvl, f"{ratio:.0f}%{hint}")

    # L1-8 / L1-7 候选：开篇两句
    first = [s for s in sentences("".join(paras[:1]))][:2]
    if first:
        head = first[0]
        susp = re.search(r"(风|雨|雪|天|夜|雾|阳光|月光|云)", head) and re.search(r"(像|仿佛|犹如|好似|似的)", head)
        add("L1-7 开篇比喻（候选）", "warn" if susp else "ok", f"首句「{head[:30]}」")
        camera = re.search(r"(竖起|拍了拍|深吸|抬头|望向|眯起|眯眼|揉了揉|伸了个懒腰)", head)
        add("L1-8 镜头式开场（候选）", "warn" if camera else "ok", f"首句「{head[:30]}」")

    # L1-10 内心总结句（候选）
    inner = re.findall(r"[他她][们]?(?:知道|看出|意识到|明白|懂得)[^。；]{0,12}(?:是|了)", body)
    add("L1-10 内心总结句（候选）", "warn" if inner else "ok",
        f"{len(inner)} 处，需人工复核" if inner else "0 处")
    for s in inner[:3]:
        add("  ↳ 候选", "info", f"{s}")

    # 替代词自查（改完复查有没有把禁用词换成新的高频替代词）
    repl = ["冷不丁", "莫名", "没来由", "八成", "活像个", "摆明"]
    over = [(w, body.count(w)) for w in repl if body.count(w) >= 4]
    add("替代词过载", "warn" if over else "ok",
        "；".join(f"{w}×{c}" for w, c in over) if over else "无")

    stats = {"chars": n_char, "paras": len(paras), "sents": len(sents)}
    return res, stats


def _safe_read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return ""


def merge_deslop(path, res):
    """把 story-deslop 检测器的结果并入 res。

    blocking → err（与 sepia 硬伤同级，必须清零）
    advisory  → warn（带 review：mechanical 就地改 / semantic 读上下文）
    """
    try:
        import deslop_bridge
    except ImportError:
        return "unavailable"

    # deslop 的 JS 侧直接读原文件，不做 strip_meta，会把 markdown 表格、
    # 标题、代码块当正文扫（表格行还会因缺句末标点被判 truncated 假阳性）。
    # 这里统一口径：先把非正文结构剥掉再交给 deslop。
    body_only = strip_meta(split_body(_safe_read(path)))
    if body_only.strip() != _safe_read(path).strip():
        import tempfile
        fd, tmp = tempfile.mkstemp(suffix=".md", prefix="_deslop_")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body_only)
        try:
            findings, status = deslop_bridge.scan(tmp)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    else:
        findings, status = deslop_bridge.scan(path)
    if status == "unavailable":
        return "unavailable"

    # 破折号 sepia 自己已查（L1-1），避免重复报
    seen_dash = any(r["item"] == "L1-1 破折号" for r in res)

    for f in findings:
        if f["item"].endswith("·破折号") and seen_dash:
            continue
        loc = f"第{f['line']}行" if f["line"] else ""
        detail = f"{loc}·{f['detail']}"
        if f.get("excerpt"):
            detail += f"｜「{f['excerpt'][:24]}」"
        res.append({
            "item": f["item"],
            "level": f["level"],
            "review": f["review"],
            "detail": detail,
        })

    n_err = sum(1 for f in findings if f["level"] == "err")
    n_warn = sum(1 for f in findings if f["level"] == "warn")
    res.append({
        "item": "去味检测器（story-deslop）",
        "level": "err" if n_err else "ok",
        "detail": f"句式/退化：硬伤 {n_err} · 提示 {n_warn}"
                  + ("（mechanical 可直接改，semantic 需读上下文）" if n_warn else ""),
    })
    return "ok"


def lineno_hits(body, pattern):
    for i, ln in enumerate(body.splitlines(), 1):
        if re.search(pattern, ln):
            yield i, ln.strip()


# ---------------------------------------------------------------- 输出

ICON = {"ok": "OK ", "warn": "WARN", "err": "FAIL", "info": "    "}


def main():
    ap = argparse.ArgumentParser(description="sepia-webnovel 机械项校验")
    ap.add_argument("file")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--quiet", action="store_true", help="只显示非 OK 项")
    ap.add_argument("--no-deslop", action="store_true", help="跳过 story-deslop 去味检测器")
    a = ap.parse_args()

    if not os.path.exists(a.file):
        print(f"找不到文件：{a.file}")
        return 2
    with open(a.file, encoding="utf-8") as f:
        text = f.read()

    res, stats = check(text)
    deslop_status = "skipped" if a.no_deslop else merge_deslop(a.file, res)
    errs = sum(1 for r in res if r["level"] == "err")
    warns = sum(1 for r in res if r["level"] == "warn")

    if a.json:
        print(json.dumps({"stats": stats, "items": res, "deslop": deslop_status,
                          "summary": {"err": errs, "warn": warns}}, ensure_ascii=False, indent=2))
        return 1 if errs else 0

    print(f"sepia-webnovel 机械校验 · {os.path.basename(a.file)}")
    print(f"正文 {stats['chars']} 字 · {stats['paras']} 段 · {stats['sents']} 句")
    print("-" * 52)
    for r in res:
        if a.quiet and r["level"] in ("ok", "info"):
            continue
        tag = ""
        if r.get("review") == "mechanical":
            tag = " [可直改]"
        elif r.get("review") == "semantic":
            tag = " [读上下文]"
        print(f"[{ICON[r['level']]}] {r['item']:<22}{tag} {r['detail']}")
    print("-" * 52)
    print(f"硬伤 {errs} · 待看 {warns}")
    if deslop_status == "unavailable":
        print("提示：story-deslop 检测器不可用（未找到 node），本次只跑了 sepia 自有规则。")
    print("说明：本脚本只查机械项，不代表过检结果。语义项请看 anti-patterns.md 与 rubric.md。")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
