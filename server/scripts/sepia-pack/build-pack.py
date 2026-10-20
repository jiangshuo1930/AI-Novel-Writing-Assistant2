#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sepia 规则包编译器（build-time only，不进运行时）

输入：server/src/services/sepia/pack/source/      原样 vendor 的规则文件与脚本
输出：server/src/services/sepia/pack/rules.compiled.json
      server/src/services/sepia/pack/manifest.json

设计约束（对应合并方案 §12.2「sepia 是只读依赖」）：
1. 解析逻辑不重写——直接 import vendor 进来的 lint.py，调它的 loader。
   任何"我重写一遍更干净"的念头都会造成词表漂移，而 contentHash 查不出来。
2. 阈值不进 JSON。lint.py 的阈值是内嵌字面量（无模块级常量），
   抽出来必须靠人判断，等于改 sepia。阈值留给 TS 端口逐字转写。
3. data 里只有数据：词表、句式、道具软词。判定逻辑一律不在包里。

用法：
    python server/scripts/sepia-pack/build-pack.py
    python server/scripts/sepia-pack/build-pack.py --verify-against ../../sepia-webnovel/scripts
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(os.path.dirname(HERE))            # server/
PACK = os.path.join(SERVER, "src", "services", "sepia", "pack")
SRC = os.path.join(PACK, "source")

SKIP_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache"}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def walk_sources(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            if name.endswith(".pyc"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out.append({
                "path": rel,
                "bytes": os.path.getsize(full),
                "sha256": sha256_file(full),
            })
    return sorted(out, key=lambda x: x["path"])


def load_lint(scripts_dir):
    """import vendor 的 lint.py（它自己会把 scripts 目录加进 sys.path）"""
    sys.path.insert(0, scripts_dir)
    import lint  # noqa: E402
    return lint


TECH_HEADING = re.compile(r"^### (?:技法|第)(\d+)(?:招)?\[([^\]]+)\](?:：|:)(.+)$")
ROLE_HEADING = re.compile(r"^## 角色(\d+)：(.*)$")
ROLE_KEYS = {
    1: "suspense",
    2: "romance",
    3: "fantasy",
    4: "urban",
    5: "general",
}


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def parse_techniques(path):
    """解析 techniques.md：标题行给编号/标签/名称，紧随的段落给一句话说明。

    只做结构提取，不改写任何措辞——摘要是原文第一句，不是新写的。
    """
    items = []
    part = ""
    current = None
    for raw in read_text(path).splitlines():
        line = raw.rstrip()
        if line.startswith("## ") and not line.startswith("### "):
            # 二级标题：甲/乙/丙部切换，同时结束上一条技法（避免把后面「节奏法则」的正文当摘要）
            if line.startswith("## 甲部"):
                part = "base"
            elif line.startswith("## 乙部"):
                part = "core"
            elif line.startswith("## 丙部"):
                part = "extra"
            if current:
                items.append(current)
                current = None
            continue
        m = TECH_HEADING.match(line)
        if m:
            if current:
                items.append(current)
            num = int(m.group(1))
            tags = [t.strip() for t in m.group(2).split("·")]
            current = {
                "id": f"tech{num}",
                "no": num,
                "name": m.group(3).strip(),
                "tags": tags,
                "part": part,
                "summary": "",
            }
            continue
        if current and not current["summary"] and line.strip() and not line.startswith("#"):
            text = line.strip()
            # `**辩证铁律**：减的是"空"…` —— 加粗小标题后紧跟正文，正文才是摘要。
            # 之前一律跳过 `**` 开头的行，导致第30招（必选）的 summary 是空串。
            bold = re.match(r"^\*\*[^*]+\*\*[：:]\s*(.+)$", text)
            if bold:
                current["summary"] = bold.group(1).strip()
                continue
            if text.startswith(("**", ">", "-", "*", "|")):
                continue
            current["summary"] = text
    if current:
        items.append(current)
    return items


def parse_roles(path):
    """解析 roles.md：5 类角色的人设一句、信号词、必上技法、专属禁用词。"""
    lines = read_text(path).splitlines()
    roles = []
    current = None
    section = ""
    for idx, raw in enumerate(lines):
        line = raw.rstrip()
        m = ROLE_HEADING.match(line)
        if m:
            if current:
                roles.append(current)
            num = int(m.group(1))
            current = {
                "key": ROLE_KEYS.get(num, f"role{num}"),
                "no": num,
                "name": m.group(2).strip(),
                "persona": "",
                "signals": [],
                "mustUseTechniques": [],
                "bannedWords": [],
            }
            section = ""
            continue
        if current is None:
            continue
        if line.startswith("### "):
            if "信号词" in line:
                section = "signals"
            elif "改写重点" in line:
                section = "techniques"
            elif "专属禁用词" in line:
                section = "banned"
            else:
                section = ""
            continue
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("> **一句话人设**"):
            current["persona"] = stripped.split("**一句话人设**：", 1)[-1].strip()
            continue
        if section == "signals" and not stripped.startswith("#"):
            for token in re.split(r"[、,,]", stripped):
                token = token.strip()
                if token and not token.startswith("###"):
                    current["signals"].append(token)
        elif section == "techniques":
            t = re.match(r"^- 第(\d+)招", stripped)
            if t:
                current["mustUseTechniques"].append(f"tech{int(t.group(1))}")
        elif section == "banned":
            for token in re.split(r"[、,,]", stripped):
                token = token.strip()
                if token and not token.startswith("#") and "无特有项" not in token and "见 `banned-words.md`" not in token:
                    current["bannedWords"].append(token)
    if current:
        roles.append(current)
    return roles


def parse_banned_groups(path):
    """按 banned-words.md 的 `## 一、二、…` 分节切词表。

    原文件有三种排版：代码块（`词|词`）、表格（第一列列词）、列表项。
    这里三种都读，但只取「词」本身，不改写、不补词。
    """
    groups = []
    current = None
    in_code = False

    def push(word):
        if not word:
            return
        word = word.strip().strip("`")
        if not word or word in current["words"]:
            return
        if len(word) > 24 or word.startswith(":"):
            return
        # 子节标题混进表格第一列的情况，不是词
        if word in {"模板句式", "模板道具", "AI词/句式", "AI模板句式"}:
            return
        current["words"].append(word)

    for raw in read_text(path).splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            if current and current["words"]:
                groups.append(current)
            title = line[3:].strip()
            # 末尾「使用说明」是读法说明，不是词表
            current = None if "使用说明" in title else {
                "key": f"group-{len(groups) + 1}",
                "title": title,
                "words": [],
            }
            in_code = False
            continue
        if current is None:
            continue
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            for token in line.split("|"):
                push(token)
            continue
        if line.startswith("|") and not line.startswith("|:"):
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if not cells or cells[0].startswith("AI") or set(cells[0]) <= set("-: "):
                continue
            for token in re.split(r"[、/／]", cells[0]):
                push(token)
            continue
        if line.startswith("- "):
            body = line[2:].strip()
            body = re.split(r"[：:→（(]", body)[0]
            for token in re.split(r"[、/／]", body):
                push(token)
    if current and current["words"]:
        groups.append(current)
    return groups


# ---------------------------------------------------------------- 参考文档 → 结构化数据
#
# 合并前这 6 篇 md 只是随包携带、运行时从不打开。下面把它们编译成项目能消费的结构：
#   discourse-pass.md  → discourse（第2层 篇章，毛病表 + 位置表）
#   rubric.md          → diagnosis（28 项体检表，5 组）
#   selfcheck.md       → selfCheck（L1–L4 分层 + 误伤警告 + 通过标准 + 快速清单）
#   state-schema.md    → stateLedger（第0层 台账，6 节字段）
#   model-fingerprints.md → modelFingerprints（按模型分组的写作惯性）
#
# 纪律：只做结构提取，不改写措辞。


def _split_row(line):
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _is_divider(cells):
    return bool(cells) and set("".join(cells)) <= set("-: ")


def collect_sections(text, level=2):
    """按 `## ` 切节，节内收表格（带表头）、列表项、段落与 `###` 子标题。"""
    prefix = "#" * level + " "
    sections = []
    current = None
    header = None
    table = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith(prefix) and not line.startswith(prefix + "#"):
            current = {"title": line[len(prefix):].strip(), "tables": [], "bullets": [], "paragraphs": [], "subheads": []}
            sections.append(current)
            header = None
            table = None
            continue
        if current is None:
            continue
        if line.startswith("#" * (level + 1) + " "):
            current["subheads"].append(line[level + 1:].strip())
            header = None
            table = None
            continue
        if line.startswith("|"):
            cells = _split_row(line)
            if _is_divider(cells):
                continue
            if header is None:
                header = cells
                table = {"header": cells, "rows": []}
                current["tables"].append(table)
                continue
            if table is not None:
                table["rows"].append(cells)
            continue
        header = None
        table = None
        stripped = line.strip()
        if stripped.startswith("- "):
            current["bullets"].append(stripped[2:].strip())
        elif re.match(r"^\d+\.\s+", stripped):
            current["bullets"].append(re.sub(r"^\d+\.\s+", "", stripped))
        elif stripped and stripped != "```" and not stripped.startswith("---"):
            current["paragraphs"].append(stripped)
    return sections


def parse_discourse(path):
    """第 2 层 篇章：毛病表（毛病/症状/怎么改）+ 位置表（位置/机器习惯/人怎么写）。"""
    out = []
    for index, section in enumerate(collect_sections(read_text(path)), 1):
        tables = []
        for table in section["tables"]:
            head = table["header"]
            if head[:3] == ["毛病", "症状", "怎么改"]:
                rows = [{"flaw": r[0], "symptom": r[1], "fix": r[2] if len(r) > 2 else ""} for r in table["rows"]]
                kind = "flaws"
            elif head[:3] == ["位置", "机器习惯", "人怎么写"]:
                rows = [{"position": r[0], "machine": r[1], "human": r[2] if len(r) > 2 else ""} for r in table["rows"]]
                kind = "positions"
            else:
                rows = [dict(zip(head, r)) for r in table["rows"]]
                kind = "other"
            tables.append({"kind": kind, "header": head, "rows": rows})
        out.append({
            "key": f"discourse-{index}",
            "title": section["title"],
            "tables": tables,
            "bullets": section["bullets"],
        })
    return out


def parse_rubric(path):
    """网文 28 项体检表：五组，每组一张表（项/怎么看出/怎么写算好/怎么改）。"""
    usage, groups = [], []
    for section in collect_sections(read_text(path)):
        title = section["title"]
        if re.match(r"^第[一二三四五六]组", title):
            items = []
            for table in section["tables"]:
                for row in table["rows"]:
                    items.append({
                        "item": row[0],
                        "detect": row[1] if len(row) > 1 else "",
                        "good": row[2] if len(row) > 2 else "",
                        "fix": row[3] if len(row) > 3 else "",
                    })
            groups.append({"key": f"group-{len(groups) + 1}", "title": title, "items": items})
        elif "用法" in title:
            usage = section["bullets"]
    return {"usage": usage, "groups": groups}


def parse_selfcheck(path):
    """L1–L4 自检清单 + 误伤警告 + 通过标准 + 快速检查清单。

    L1 的细则已由 lint 端口执行，这里只留标题，供 UI 对照；
    L2–L4 是判断层，条目原文照抄。
    """
    levels, warnings, pass_criteria, quick_check, double_tests = [], [], [], [], []
    for section in collect_sections(read_text(path)):
        title = section["title"]
        compact = title.replace(" ", "")
        if re.match(r"^L[1-4]", compact):
            items = [h for h in section["subheads"]]
            items.extend(b for b in section["bullets"] if b)
            levels.append({
                "key": compact[:2],
                "title": title,
                "items": items,
            })
        elif "误伤警告" in title:
            for table in section["tables"]:
                for row in table["rows"]:
                    warnings.append({
                        "feature": row[0],
                        "threshold": row[1] if len(row) > 1 else "",
                        "note": row[2] if len(row) > 2 else "",
                    })
        elif "通过标准" in title:
            pass_criteria = [b for b in section["bullets"] if b]
        elif "快速检查清单" in title:
            quick_check = [re.sub(r"^\[\s*\]\s*", "", b) for b in section["bullets"] if b]
        elif "双测试" in title:
            double_tests = [b for b in section["bullets"] if b]
    return {
        "levels": levels,
        "falsePositiveWarnings": warnings,
        "passCriteria": pass_criteria,
        "doubleTests": double_tests,
        "quickCheck": quick_check,
    }


def parse_state_ledger(path):
    """第 0 层 台账：6 节字段模板（节标题 + 表头 + 行）。

    只取 `一、…`～`六、…` 这 6 节；`放在哪` / `模板` / `用法` / `一条硬规矩`
    是读法说明，不是台账字段。
    """
    sections = []
    for section in collect_sections(read_text(path)):
        title = section["title"]
        if not re.match(r"^[一二三四五六七八九十]+、", title):
            continue
        tables = [{"header": t["header"], "rows": t["rows"], "rowCount": len(t["rows"])} for t in section["tables"]]
        sections.append({
            "key": f"state-{len(sections) + 1}",
            "title": title,
            "tables": tables,
            "bullets": section["bullets"],
        })
    return sections


FINGERPRINT_KEY = {
    "deepseek": "deepseek",
    "kimi": "kimi",
    "claude": "claude",
    "gpt": "gpt",
    "qwen": "qwen",
    "gemini": "gemini",
    "glm": "glm",
}


def parse_fingerprints(path):
    """各模型写作惯性：summary + traits + fixes；末尾「人写的东西长什么样」单列。"""
    models, human = [], []
    current = None
    mode = None
    for raw in read_text(path).splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            title = line[3:].strip()
            if title.startswith("人写的东西"):
                current = {"key": "human", "title": title, "summary": "", "traits": [], "fixes": []}
                models.append(current)
                mode = "human"
                continue
            base = title.split("（")[0].strip()
            key = FINGERPRINT_KEY.get(base.lower(), base.lower())
            current = {"key": key, "title": title, "summary": "", "traits": [], "fixes": []}
            models.append(current)
            mode = None
            continue
        if current is None:
            continue
        stripped = line.strip()
        if stripped.startswith("**"):
            if "怎么改" in stripped:
                mode = "fix"
                inline = re.match(r"^\*\*怎么改\*\*[：:]\s*(.+)$", stripped)
                if inline:
                    current["fixes"].append(inline.group(1).strip())
                continue
            if "其余" in stripped or "几条" in stripped:
                mode = "trait"
                continue
            m = re.match(r"^\*\*(.+?)\*\*$", stripped)
            if m and not current["summary"]:
                current["summary"] = m.group(1).strip()
                mode = "trait"
                continue
            continue
        if stripped.startswith("|") and mode in ("trait", "human", None):
            cells = _split_row(stripped)
            if _is_divider(cells) or cells[0] in ("惯性", "特征"):
                continue
            if mode == "human":
                human.append({"feature": cells[0], "how": cells[1] if len(cells) > 1 else ""})
            else:
                current["traits"].append(cells[0])
                current["fixes"].append(cells[1] if len(cells) > 1 else "")
            continue
        if stripped.startswith("- "):
            body = stripped[2:].strip()
            if mode == "fix":
                current["fixes"].append(body)
            else:
                current["traits"].append(body)
            continue
        if stripped and mode is None and not current["summary"] and stripped != "---" and not stripped.startswith(">"):
            current["summary"] = stripped
    models = [m for m in models if m["key"] != "human"]
    return {"models": models, "humanSignals": human}


GROUP_INSTRUCTIONS = {
    1: "少用书面连接词与 AI 腔副词，改成「可/但/就/所以」或直接断句。",
    2: "删掉议论性插入语与空话套话，直接说事。",
    3: "抽象词换成具体动作或物件。",
    4: "模板句式发现即拆解重写，不要换词套壳。",
    5: "情绪与叙事句式按具体动作重写，禁止套模板。",
    6: "模板道具换成只有这个场景才有的物件。",
}


def build_anti_ai_seeds(groups, patterns):
    """把 6 组词表 + 9 条句式聚合成 AntiAiRule 种子（对应方案 §6.2：153 个词不变成 153 条规则）。"""
    import re as _re

    seeds = []
    for index, group in enumerate(groups, 1):
        samples = [_re.escape(word) for word in group["words"][:6]]
        seeds.append({
            "key": f"sepia.lexicon.group-{index}",
            "name": group["title"],
            "type": "forbidden",
            "severity": "high" if index <= 2 else "medium",
            "description": f"sepia 禁用词表第 {index} 组，共 {len(group['words'])} 个词。全量词表在机械门 lint 阶段使用，此处只放 6 个高价值样本给语义层。",
            "detectPatterns": samples,
            "promptInstruction": GROUP_INSTRUCTIONS.get(index, "命中即换。"),
            "autoRewrite": False,
            "enabled": True,
            "globalBaselineEnabled": False,
        })
    for index, pattern in enumerate(patterns, 1):
        seeds.append({
            "key": f"sepia.pattern.sentence-{index}",
            "name": f"模板句式：{pattern['name']}",
            "type": "forbidden",
            "severity": "medium",
            "description": f"sepia AI 模板句式第 {index} 条；正则由机械门执行，这里只给语义提示。",
            "detectPatterns": [pattern["regex"]],
            "promptInstruction": "出现即拆解重写：换成具体动作与具体物件，不要换词套壳。",
            "autoRewrite": False,
            "enabled": True,
            "globalBaselineEnabled": False,
        })
    return seeds


def build_data(lint):
    patterns = [{"name": n, "regex": p} for n, p in lint.load_sentence_patterns()]
    refs = os.path.join(SRC, "references")
    zh = os.path.join(refs, "zh-fiction")
    techniques = parse_techniques(os.path.join(zh, "techniques.md"))
    roles = parse_roles(os.path.join(zh, "roles.md"))
    banned_groups = parse_banned_groups(os.path.join(zh, "banned-words.md"))
    diagnosis = parse_rubric(os.path.join(refs, "rubric.md"))
    return {
        "bannedWords": lint.load_banned_words(),
        "sentencePatterns": patterns,
        "softWords": sorted(lint.SOFT_WORDS),
        "techniques": techniques,
        "roles": roles,
        "bannedWordGroups": banned_groups,
        "antiAiRuleSeeds": build_anti_ai_seeds(banned_groups, patterns),
        "discourse": parse_discourse(os.path.join(refs, "discourse-pass.md")),
        "diagnosis": diagnosis,
        "selfCheck": parse_selfcheck(os.path.join(zh, "selfcheck.md")),
        "stateLedger": parse_state_ledger(os.path.join(refs, "state-schema.md")),
        "modelFingerprints": parse_fingerprints(os.path.join(refs, "model-fingerprints.md")),
    }


def canon(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-against", metavar="SCRIPTS_DIR",
                    help="另一个 sepia scripts 目录，用来验证 vendor 后数据没漂移")
    args = ap.parse_args()

    scripts = os.path.join(SRC, "scripts")
    if not os.path.isdir(scripts):
        sys.exit(f"缺少 vendor 源码：{scripts}")

    lint = load_lint(scripts)
    data = build_data(lint)

    if args.verify_against:
        ref_lint = load_lint(os.path.abspath(args.verify_against))
        ref = build_data(ref_lint)
        same = canon(ref) == canon(data)
        print(f"漂移校验 vs {args.verify_against}: {'一致' if same else '不一致'}")
        if not same:
            for k in ("bannedWords", "sentencePatterns", "softWords"):
                a, b = set(map(str, ref[k])), set(map(str, data[k]))
                if a != b:
                    print(f"  {k}: 仅原版 {sorted(a - b)[:6]} / 仅包内 {sorted(b - a)[:6]}")
            sys.exit(1)

    version = ""
    vp = os.path.join(SRC, "VERSION")
    if os.path.exists(vp):
        with open(vp, encoding="utf-8") as f:
            version = f.read().strip()

    files = walk_sources(SRC)
    source_hash = hashlib.sha256(canon(files).encode("utf-8")).hexdigest()
    content_hash = hashlib.sha256(canon(data).encode("utf-8")).hexdigest()

    pack = {
        "meta": {
            "packName": "sepia-webnovel",
            "packVersion": version,
            "builtAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "contentHash": content_hash,
            "sourceHash": source_hash,
            "quoteConvention": "curly",
            "sourceFileCount": len(files),
            "counts": {
                "bannedWords": len(data["bannedWords"]),
                "sentencePatterns": len(data["sentencePatterns"]),
                "softWords": len(data["softWords"]),
                "techniques": len(data["techniques"]),
                "roles": len(data["roles"]),
                "discourseSections": len(data["discourse"]),
                "diagnosisItems": sum(len(g["items"]) for g in data["diagnosis"]["groups"]),
                "selfCheckItems": sum(len(level["items"]) for level in data["selfCheck"]["levels"]),
                "stateSections": len(data["stateLedger"]),
                "modelFingerprints": len(data["modelFingerprints"]["models"]),
            },
            "notes": [
                "阈值不在本文件内：lint.py 的阈值是内嵌字面量，由 TS 端口逐字转写。",
                "deslop 的 22 类规则不在本文件内：vendor 目录下 JS 字节不变，运行时以子进程调用。",
                "discourse/diagnosis/selfCheck/stateLedger/modelFingerprints 是参考文档的结构化转写，措辞未改。",
            ],
        },
        "data": data,
    }

    manifest = {
        "packVersion": version,
        "contentHash": content_hash,
        "sourceHash": source_hash,
        "builtAt": pack["meta"]["builtAt"],
        "files": files,
    }

    with open(os.path.join(PACK, "rules.compiled.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(pack, f, ensure_ascii=False, indent=2, sort_keys=False)
        f.write("\n")
    with open(os.path.join(PACK, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"packVersion   {version}")
    print(f"sourceFiles   {len(files)}")
    print(f"bannedWords   {len(data['bannedWords'])}")
    print(f"sentencePat   {len(data['sentencePatterns'])}")
    print(f"softWords     {len(data['softWords'])}")
    print(f"techniques    {len(data['techniques'])}")
    print(f"roles         {len(data['roles'])}")
    print(f"discourse     {len(data['discourse'])} 节 / "
          f"{sum(len(t['rows']) for s in data['discourse'] for t in s['tables'])} 条")
    print(f"diagnosis     {len(data['diagnosis']['groups'])} 组 / "
          f"{sum(len(g['items']) for g in data['diagnosis']['groups'])} 项")
    print(f"selfCheck     {len(data['selfCheck']['levels'])} 层 / "
          f"{len(data['selfCheck']['quickCheck'])} 条快检")
    print(f"stateLedger   {len(data['stateLedger'])} 节")
    print(f"fingerprints  {len(data['modelFingerprints']['models'])} 个模型")
    print(f"contentHash   {content_hash}")
    print(f"sourceHash    {source_hash}")


if __name__ == "__main__":
    main()
