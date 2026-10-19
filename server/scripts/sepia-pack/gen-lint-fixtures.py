#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 T1 端口一致性语料（ground truth 来自 lint.py 本体，不是手写期望值）

产出：
  server/tests/fixtures/sepia/lint/<id>.md        输入文本
  server/tests/fixtures/sepia/lint/expected.json  { id: {stats, items} }

用法：
  python server/scripts/sepia-pack/gen-lint-fixtures.py
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(os.path.dirname(HERE))
SCRIPTS = os.path.join(SERVER, "src", "services", "sepia", "pack", "source", "scripts")
OUT = os.path.join(SERVER, "tests", "fixtures", "sepia", "lint")

PY = sys.executable or "python"

# ---------------------------------------------------------------- 语料
# 每项都踩在 lint.py 的某个阈值边界上，而不是"随便一段好文"

def para(n, ch="他"):
    """生成 n 字的段落（用句号分隔，控制句长）"""
    unit = f"{ch}把碗端起来，又放下，转身出了门，外头的天已经黑透了。"
    out = ""
    while len(out) < n:
        out += unit
    return out[:n]


# 中性填充：不能让 100 字早退分支吞掉后面所有检查项（n_char < 100 会提前 return）。
# 句子长度故意参差，句号密度落在 5–8 附近，不含引号/冒号/破折号/禁用词。
FILLER = [
    "他把灶膛里的灰掏出来，堆在门口。",
    "锅里的水开了，盖子被顶起来又落下去，冒着白气。",
    "外面的车过了一辆，声音很远。",
    "桌上摊着一张旧报纸，边角卷起来，压着一只搪瓷茶缸。",
    "风把门帘吹起来一角，又落回去。",
    "他数了数抽屉里的钱，一共三张，都发软了。",
    "院子里的水龙头没关紧，一直在滴。",
    "墙根下有一只猫，趴着不动。",
]


def pad(text, target=150):
    out = text
    i = 0
    while len(out) < target:
        out += "\n\n" + FILLER[i % len(FILLER)]
        i += 1
    return out


CASES = {}

# 1) 正文不足 100 字（早退分支，但仍要报 L1-1）
CASES["s01_short_body"] = "他推开门——外头没人。"

# 2) 干净短章：句号密度刚好落在 5–8 区间
CASES["s02_clean"] = pad(
    "天还没亮，巷子口的灯灭了一半。\n\n"
    "老陈把炉子捅开，灰从灶眼里落下来，落在他的鞋面上。他没拍，站着看了一会儿。\n\n"
    "外面有人推车过去，轮子卡在石头上，响了一声就不响了。"
)

# 3) 破折号：「——」算 1 处，不是 2 处；「—」单独也算
CASES["s03_dash"] = pad(
    "他站起来——又坐下。\n\n"
    "门开了，风灌进来，桌上的纸翻过去一页。\n\n"
    "他没抬头—只是把手按在纸上。"
)

# 4) 禁用词：长词覆盖短词（"空气仿佛凝固了" 命中后 "仿佛" 不该单算）
CASES["s04_banned"] = pad(
    "空气仿佛凝固了，他忽然觉得嗓子发紧。\n\n"
    "那是一种难以名状的感觉，仿佛有人在他背后站着。\n\n"
    "他没有回头，只是把领子竖起来，往巷子深处走。"
)

# 5) 引号：直角 + 半角混排（都该判 err）
CASES["s05_quotes"] = pad(
    "「你来了。」他说。\n\n"
    "他点头，\u201c嗯\u201d了一声，把手插回口袋里。\n\n"
    "屋里没开灯，窗帘拉着，缝里透进一条亮。"
)

# 6) 冒号（warn，不清零也要报）
CASES["s06_colon"] = pad(
    "他说了三件事：一是不去，二是没钱，三是没人。\n\n"
    "老陈听完没说话，把烟头摁在桌角上。\n\n"
    "外面下起雨来，屋檐的水一滴一滴砸在水泥地上。"
)

# 7) 句式套子：单次「不是X而是Y」不触发密度红线，三次才触发
CASES["s07_pattern_once"] = pad(
    "这不是害怕，而是冷。\n\n"
    "他把手插进口袋里，指头碰到一枚硬币，边缘磨得发亮。\n\n"
    "院子里那辆自行车倒在地上，辐条断了两根，没人扶。"
)
CASES["s07_pattern_dense"] = pad(
    "这不是害怕，而是冷。\n\n"
    "这不是犹豫，而是等。\n\n"
    "这不是忘了，而是不想说。\n\n"
    "他站在门口，看着院里那辆倒在地上的自行车。"
)

# 8) 句号密度过低（长句、逗号串联）
CASES["s08_low_period"] = (
    "他站在门口，看着院子里那辆倒在地上的旧自行车，车把歪向一边，"
    "辐条断了两根，链条掉在地上，轮胎瘪了，车座上落了一层灰，"
    "风从院墙那边过来，吹得晾衣绳上的衣服一下一下地响，"
    "他没有过去扶，只是站着看，像是要看好久"
)

# 9) 段落长度雷同（连续 4 段差值 ≤ max(4, min*0.15)）
CASES["s09_uniform_paras"] = "\n\n".join(
    ["他把碗端起来，又放下。" for _ in range(10)]
)

# 10) 相邻同长句：6 句长度几乎一样
CASES["s10_same_length"] = (
    "他走进院子看见地上有水。\n\n"
    "他弯腰摸了一下水面很凉。\n\n"
    "他直起身子看了看四周无人。\n\n"
    "他转身回屋把门轻轻带上。\n\n"
    "他坐在床沿听外面的风声。\n\n"
    "他躺下去盯着天花板发愣。\n\n"
    "他翻了个身把被子拉到肩上。\n\n"
    "他伸手去摸床头那盒火柴。\n\n"
    "他划着一根又吹灭了它。\n\n"
    "他起来把窗户推开一条缝。"
)

# 11) 超长句：3 句 >55 字
CASES["s11_long_sentences"] = "\n\n".join([para(120)] * 3)

# 12) 对话占比：有场景（≥3 个左引号）但占比 <30% / 占比 >50%
CASES["s12_dialogue_low"] = (
    "\u201c来了。\u201d他说。\n\n"
    + para(300)
    + "\n\n\u201c嗯。\u201d"
)
CASES["s12_dialogue_high"] = (
    "\u201c你来了，路上没遇见人吧。\u201d\n\n\u201c没有，巷子里一盏灯都没有。\u201d\n\n"
    "\u201c坐吧，水刚烧开，还烫着。\u201d\n\n\u201c不坐了，我说两句就走。\u201d\n\n"
    "\u201c那你站着说，我听着。\u201d\n\n\u201c站就站，反正也没什么事。\u201d\n\n"
    "\u201c炉子是你捅开的？\u201d\n\n\u201c我捅的，灰还没扫。\u201d\n\n"
    "\u201c灰放着吧，明天一起扫。\u201d\n\n\u201c明天我不一定来。\u201d"
)

# 13) 开篇比喻 + 镜头式开场
CASES["s13_opening"] = pad(
    "夜色像一块湿布蒙在屋顶上。\n\n"
    "他抬头望向巷口，把领子竖起来，深吸了一口气。\n\n"
    "巷子很长，两头都没有灯。"
)

# 14) 内心总结句
CASES["s14_inner"] = pad(
    "他知道那是假的。\n\n"
    "她看出他是在拖延。\n\n"
    "他明白了一件事：这屋里没有别人。"
)

# 15) 替代词过载（≥4 次）
CASES["s15_replacement"] = pad(
    "他冷不丁回头，冷不丁又转回去，冷不丁笑了一下，冷不丁咳了一声。\n\n"
    "院子里没有人，只有一只猫从墙头跳下去。"
)

# 16) markdown 结构（标题/表格/代码块/引用都不该进正文）
CASES["s16_markdown"] = (
    "# 第三章\n\n"
    "| 项 | 值 |\n|---|---|\n| 时间 | 九八年 |\n\n"
    "> 引用不算正文\n\n"
    "```\n代码块也不算\n```\n\n"
    + para(200)
)

# 17) 「## 四、正文」分节：只取正文节
CASES["s17_section"] = (
    "## 一、架构表\n\n想要什么：留住她一天。阻碍：馆长。\n\n"
    "## 四、正文\n\n" + para(240) + "\n\n## 五、备注\n\n这段不该被扫进来，仿佛。"
)

# 18) 真实章节（books/清溪 第一章）
CHAPTER = os.path.join(
    os.path.dirname(os.path.dirname(SERVER)), "books", "清溪", "ch001-三号柜.md"
)


def run_lint(path):
    r = subprocess.run(
        [PY, os.path.join(SCRIPTS, "lint.py"), path, "--json", "--no-deslop"],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if r.returncode not in (0, 1):
        raise SystemExit(f"lint.py 失败 {path}\n{r.stderr[:500]}")
    return json.loads(r.stdout)


def main():
    os.makedirs(OUT, exist_ok=True)
    expected = {}
    ids = list(CASES.keys())
    if os.path.exists(CHAPTER):
        ids.append("s18_real_chapter")

    for cid in ids:
        if cid == "s18_real_chapter":
            with open(CHAPTER, encoding="utf-8") as f:
                text = f.read()
        else:
            text = CASES[cid]
        p = os.path.join(OUT, f"{cid}.md")
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        data = run_lint(p)
        expected[cid] = {"stats": data["stats"], "items": data["items"]}

    with open(os.path.join(OUT, "expected.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(expected, f, ensure_ascii=False, indent=1)
        f.write("\n")

    print(f"fixtures {len(expected)} 个 → {OUT}")
    for cid, v in expected.items():
        lv = {}
        for it in v["items"]:
            lv[it["level"]] = lv.get(it["level"], 0) + 1
        print(f"  {cid:<20} chars={v['stats']['chars']:<5} "
              f"err={lv.get('err',0)} warn={lv.get('warn',0)} info={lv.get('info',0)}")


if __name__ == "__main__":
    main()
