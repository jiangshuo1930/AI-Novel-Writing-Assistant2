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
    return {
        "bannedWords": lint.load_banned_words(),
        "sentencePatterns": patterns,
        "softWords": sorted(lint.SOFT_WORDS),
        "techniques": techniques,
        "roles": roles,
        "bannedWordGroups": banned_groups,
        "antiAiRuleSeeds": build_anti_ai_seeds(banned_groups, patterns),
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
            },
            "notes": [
                "阈值不在本文件内：lint.py 的阈值是内嵌字面量，由 TS 端口逐字转写。",
                "deslop 的 22 类规则不在本文件内：vendor 目录下 JS 字节不变，运行时以子进程调用。",
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
    print(f"contentHash   {content_hash}")
    print(f"sourceHash    {source_hash}")


if __name__ == "__main__":
    main()
