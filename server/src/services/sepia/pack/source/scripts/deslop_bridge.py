#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""deslop 检测器编排层

把 oh-story-claudecode 的 story-deslop 三套 Node 检测器接入 sepia-webnovel：

    check-ai-patterns.js    句式/密度检测（7 blocking + 16 advisory，带 review 分流）
    check-degeneration.js   退化检测（复读/截断/占位符/工程词泄漏）
    normalize-punctuation.js 标点归一（独立子命令，默认不改写）

设计原则：
1. **JS 脚本原样迁移，零改写**。规则库、阈值、护栏、引号遮罩全部在 JS 里，
   Python 只负责调用 + 汇总 + 映射等级，绝不重新实现正则——重写必然丢护栏细节。
2. 两套等级并存：
     story-deslop  blocking → sepia err（必须清零）
     story-deslop  advisory → sepia warn（带 review 字段，mechanical=就地改 / semantic=读上下文）
3. 只报告不改写。标点归一默认 --check，要真改必须显式 --fix。
4. Node 不可用时静默降级（返回 unavailable），不阻塞 lint.py 主流程。

用法：
    from deslop_bridge import scan
    findings, status = scan("正文.md")       # status: ok / unavailable
"""

import json
import os
import re
import shutil
import subprocess

BASE = os.path.dirname(os.path.abspath(__file__))
DESLOP = os.path.join(BASE, "deslop")

# 文件名 → 该检测器产出的 type 前缀语义（在 SKILL.md 里按此分派修复动作）
DETECTORS = (
    ("句式与密度", "check-ai-patterns.js"),
    ("退化", "check-degeneration.js"),
)

# sepia 等级 ← story-deslop severity
LEVEL = {"blocking": "err", "advisory": "warn"}

# 中文标签：type → 可读名。用于 lint 输出与 SKILL.md 的分流表。
TYPE_CN = {
    "not-is-comparison": "不是A而是B",
    "voice-contrast": "音量反差腔",
    "negation-parade": "否定排比",
    "reverse-not-is": "反序对比",
    "trailer-ending": "预告式收尾",
    "trailer-summary": "章尾总结体",
    "em-dash": "破折号",
    "long-paragraph": "长段落",
    "period-stutter": "碎句号",
    "micro-action-tic": "微动作复读",
    "negation-pair-tic": "否定对偶",
    "cliche-density-tic": "套词密度",
    "stock-reaction-tic": "套式反应细节",
    "action-list-tic": "动作清单",
    "abstract-summary-tic": "抽象总结复读",
    "metaphor-density-tic": "比喻密度",
    "reasoning-chain-tic": "解释链密度",
    "system-notice-formality-tic": "系统公告公文腔",
    "overcompressed-prose-tic": "过度精炼短段",
    "low-connective-density-tic": "低连接密度",
    "quote-emphasis-tic": "引号强调滥用",
    "formulaic-parallelism": "工整并列",
    # 以下 key 必须与 check-degeneration.js 里的 type 字面量逐字一致。
    # 曾经写成 repeat / adjacent-repeat / truncation / placeholder，与 JS 产出的
    # verbatim-repeat / truncated / placeholder-leak 对不上，退化类告警全部掉回英文 type。
    "verbatim-repeat": "复读打转",
    "truncated": "截断",
    "placeholder-leak": "占位符泄漏",
    "meta-leak": "工程词泄漏",
}

# 同一 type 有两条触发路径时按 message 前缀细分，保持中文名可读。
# 依据 check-degeneration.js findRepetition()：紧邻整行重复 / 全篇长句复读。
SUBTYPE_CN = {
    "verbatim-repeat": (
        ("逐行复读", "紧邻整行重复"),
        ("长句复读", "长句复读"),
    ),
}

# JS 侧的 type 都是单引号字面量，用它做漂移自检（见 type_drift）。
_TYPE_LITERAL = re.compile(r"\btype:\s*'([a-z][a-z0-9-]*)'")


def _label(typ, message=""):
    """type → 中文名。未登记的 type 原样透出，便于第一时间发现漂移。"""
    for probe, name in SUBTYPE_CN.get(typ, ()):
        if probe in message:
            return name
    return TYPE_CN.get(typ, typ)


def type_drift():
    """比对 JS 源码实际产出的 type 与 TYPE_CN 的覆盖情况。

    返回 (missing, stale, seen)：
      missing  JS 会产出、但 TYPE_CN 没登记 —— 输出里会显示英文 type
      stale    TYPE_CN 登记了、但 JS 已不产出 —— 死键，通常是规则改名后的残留
      seen     两个检测器里扫到的全部 type
    """
    seen = set()
    for _, script in DETECTORS:
        sp = os.path.join(DESLOP, script)
        if not os.path.isfile(sp):
            continue
        try:
            with open(sp, encoding="utf-8") as f:
                seen.update(_TYPE_LITERAL.findall(f.read()))
        except OSError:
            continue
    return sorted(seen - set(TYPE_CN)), sorted(set(TYPE_CN) - seen), sorted(seen)


def _node():
    """定位 node：优先 PATH，其次 WorkBuddy 托管运行时。"""
    exe = shutil.which("node")
    if exe:
        return exe
    for root in (os.environ.get("USERPROFILE", ""), "C:/Users/Jani"):
        base = os.path.join(root, ".workbuddy", "binaries", "node", "versions")
        if not os.path.isdir(base):
            continue
        for ver in sorted(os.listdir(base), reverse=True):
            for cand in ("node.exe", "node"):
                p = os.path.join(base, ver, cand)
                if os.path.isfile(p):
                    return p
    return None


def scan(path):
    """对单个文件跑全部检测器。

    返回 (findings, status)：
      findings = [{item, level, review, line, col, detail, detector}]
      status   = "ok" | "unavailable"（node 缺失或脚本缺失）
    """
    node = _node()
    if not node or not os.path.isdir(DESLOP):
        return [], "unavailable"

    out = []
    for label, script in DETECTORS:
        sp = os.path.join(DESLOP, script)
        if not os.path.isfile(sp):
            continue
        try:
            r = subprocess.run(
                [node, sp, "--json", path],
                capture_output=True, text=True, encoding="utf-8",
                timeout=60,
            )
        except (subprocess.TimeoutExpired, OSError):
            continue
        if r.returncode == 2:
            continue
        try:
            data = json.loads(r.stdout or "{}")
        except json.JSONDecodeError:
            continue

        for f in data.get("findings", []):
            sev = f.get("severity", "advisory")
            typ = f.get("type", "unknown")
            msg = f.get("message", "")
            out.append({
                "item": f"{label}·{_label(typ, msg)}",
                "level": LEVEL.get(sev, "warn"),
                "review": f.get("review", "semantic"),
                "line": f.get("line"),
                "col": f.get("column"),
                "detail": f"{msg}（{typ}）",
                "excerpt": f.get("excerpt", ""),
                "detector": label,
            })
    return out, "ok"


def review_classes():
    """返回 story-deslop 的完整 review 分类表，用于 SKILL.md 生成与自检。"""
    node = _node()
    sp = os.path.join(DESLOP, "check-ai-patterns.js")
    if not node or not os.path.isfile(sp):
        return {}
    try:
        r = subprocess.run([node, sp, "--list-review-classes"],
                           capture_output=True, text=True, encoding="utf-8", timeout=30)
        return json.loads(r.stdout or "{}")
    except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError):
        return {}


def punct(path, quote_mode="keep", fix=False):
    """标点归一。默认只报告（fix=False）；fix=True 时才写回文件。

    返回 (findings, changed)。findings 为人类可读文本行列表。
    """
    node = _node()
    sp = os.path.join(DESLOP, "normalize-punctuation.js")
    if not node or not os.path.isfile(sp):
        return [], False
    cmd = [node, sp, "--quote-mode", quote_mode]
    if not fix:
        cmd.append("--check")
    cmd.append(path)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=60)
    except (subprocess.TimeoutExpired, OSError):
        return [], False
    lines = [l for l in (r.stdout or "").splitlines() if l.strip()]
    changed = fix and r.returncode in (0, 1)
    return lines, changed


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)
    if sys.argv[1] == "--types":
        # 自检：JS 产出的 type 与 TYPE_CN 是否一一对应
        missing, stale, seen = type_drift()
        print(json.dumps({"seen": seen, "missing": missing, "stale": stale},
                         ensure_ascii=False, indent=2))
        sys.exit(0 if not missing and not stale else 1)
    f, st = scan(sys.argv[1])
    if st == "unavailable":
        print("deslop 检测器不可用（未找到 node 或脚本）")
        sys.exit(2)
    print(json.dumps(f, ensure_ascii=False, indent=2))