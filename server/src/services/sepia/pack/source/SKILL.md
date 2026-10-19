---
name: sepia-webnovel
description: 中文网文小说写作与去 AI 味（写新章 / 修稿 / 润色 / 重写）。四操作 write/review/refactor/recreate，五类角色子路由（悬疑/言情/玄幻/都市/通用），三层＋卷级＋跨章台账，交付前跑机械校验脚本。目标过朱雀（创意小说阈值约 0.5）。
version: 0.5.0
---

# sepia-webnovel

只做一件事：**写中文网文小说，写得不像是 AI 写的。**

不碰英文，不碰公文、公众号、学术、新闻。这套规则全部为网文设计——句子短、对话多、章节末必须挂人、读者三秒决定要不要划走。

所有规则用中文写成，不引外部研究。判断标准只有一个：**读者会不会继续往下看。**

---

## 六层结构

```
第 0 层  写作前    ← state.md（跨章台账）
第 1 层  架构      ← narrative-pass.md   人物要什么、事件怎么连
第 2 层  篇章      ← discourse-pass.md   段落怎么走、读者在哪滑
第 3 层  句子      ← style-surface.md    + zh-fiction/
第 4 层  卷级      ← arc-pass.md         连着几章会不会腻
交付前   机械校验  ← scripts/lint.py
                （内含 story-deslop 去味检测器）
```

**顺序不能颠倒。** 结构没定就抠字，等于在错的地方精雕。

---

## 四操作

### write —— 写新章

1. **读台账**（`state.md`，没有就跳过）。知道人物现在在哪、身上有什么、上一章留了什么。
2. **定类型**，从 `zh-fiction/roles.md` 选一个角色（悬疑/言情/玄幻/都市/通用）。命中多个取信号最多的，混合类型以主线为准。
3. **填架构表**（`narrative-pass.md` 第一节：想要什么 / 阻碍 / 做了什么 / 结果 / 本章实质变化 / 章末悬着的事）。
4. **选 3–5 招**（`zh-fiction/techniques.md`），配合"减空洞 + 加颗粒"。
5. **排篇章**：峰值放哪（`discourse-pass.md`），章末钩子选哪种（`arc-pass.md` 的六种标签，别和上一章重复）。
6. **写初稿**。
7. **跑校验**：`python scripts/lint.py <文件>`，把 FAIL 项清零。
   输出带 `[可直改]` / `[读上下文]` 标记——前者就地改，后者读上下文再判。
8. **查结构**（`rubric.md` 五组扫描 + `anti-patterns.md` 对照）。
9. **更新台账**（`state-schema.md`）。

### review —— 只诊断，不动笔

1. `rubric.md` 五组扫描（一次只看一组），每条必须引原句。
2. `zh-fiction/diagnosis.md` 四维＋朱雀特征扫描。
3. 多章时加 `arc-pass.md` 卷级检查。
4. 输出：**层级（架构/篇章/句子）+ 位置（哪句）+ 建议招式**。停。

### refactor —— 精修

**两阶段，不可省。**

① 先出完整缺陷清单，按"架构 > 篇章 > 句子"排。
② 逐条改，深的先改。每改完一段跑**双测试**（删除测试 / 还原测试，见 `style-surface.md` 第三节）。
③ `lint.py` 复跑，FAIL 清零。

### recreate —— 重写

抽事实清单（剧情 / 人设 / 时间线，**不许臆造**）→ 按架构表 + 角色重写 → 跑校验 → 更新台账。

---

## 五类角色（`zh-fiction/roles.md`）

| 角色 | 信号词 | 主要技法 |
|---|---|---|
| 悬疑探案 | 案件/线索/凶手/推理/监控/电梯/诡异 | 22 主角犯错 · 19 干扰项 · 18 恐惧锚定 · 17 灰度 · 24 碎玻璃 · 25 数字体感 · 26 无用道具 |
| 言情 | 心动/表白/暗恋/误会/cp | 16 行为化 · 21 感官偏见 · 17 灰度 · 15 私人细节 · 6 不完美 |
| 玄幻修仙 | 灵气/修炼/境界/宗门/系统/金手指 | 23 规则私人化 · 17 灰度 · 11 层层剥开 · 8 具体不解释 · 24 碎玻璃 · 14 嗓音 |
| 都市现实 | 上班/房租/地铁/同事/相亲/厨房 | 15 私人细节 · 26 无用道具 · 2 走神 · 7 脏细节 · 17 灰度 · 27 电影化 |
| 通用（兜底） | 都不匹配时 | 16 行为化 · 15 私人细节 · 14 嗓音 · 5 长短混排 · 10 断裂 · 17 灰度 |

选定后全章语气统一，不串角色。

---

## 校准（压过所有技法标签）

- **单篇最多 3–5 招。** 宁少勿堆。普通句、留白也留着。
- 减空洞和加颗粒必须同时做。只减会干巴，只加会臃肿。
- 不把观察变成"AI 概率"。诊断只给缺陷位置，不给分数。
- 改得过头也是错。极端值（干净到没有一句活的、碎到读不懂）标"过度修正"，单独修。

---

## 硬指标

1. **`lint.py` 硬伤清零。** 这是可执行的底线，别靠眼睛。
2. 交付前念一遍。念着不像人话的地方，重写。
3. 过不了就往回改：先看架构，再看篇章，最后才是词。

---

## 去味检测器（story-deslop）

`lint.py` 内部挂了一套来自 `oh-story-claudecode` 的 Node 检测器（MIT 许可，脚本原样迁入、零改写），
补上 sepia 自己缺的机械项——退化检测（复读/截断/占位符/工程词泄漏）与 5 类 blocking 句式。

### 等级映射

| story-deslop | lint.py | 处置 |
|---|---|---|
| `blocking` | **FAIL（必须清零）** | 就地改写，规则全部带护栏，不需要判断 |
| `advisory` | WARN `[可直改]` | `mechanical`：形态即问题，就地改 |
| `advisory` | WARN `[读上下文]` | `semantic`：可能承担叙事功能，读上下文再定 |

### 7 类 blocking（机械判定，必须清零）

| 类型 | 形态 |
|---|---|
| `not-is-comparison` | “不是 A，而是 B” |
| `voice-contrast` | “声音不大…却”（实战漏网 A） |
| `negation-parade` | “没有 X，没有 Y…”连排 / “没 X…只是 Y” |
| `reverse-not-is` | “是 A，不是 B”（实战漏网 C） |
| `trailer-ending` | 章尾预告：「没人知道」「才刚刚开始」 |
| `trailer-summary` | 章尾盖章过去：「这一切都结束了」「命运齿轮」 |
| `em-dash` | 破折号（也由 sepia L1-1 覆盖，编排层去重） |

### 豁免机制

- **书级白名单**：作品根目录建 `.deslop-whitelist`，一行一条作者刻意保留的原句，检测时整句遮罩。
  找不到文件即无白名单；只认本书，不跨书继承。
- **章内跳过标记**：标题下写 `<!-- 去味:跳过 -->`。
  注意这是**流程标记不是豁免**——脚本照常检测；本次去味照常处理，
  blocking 清零后删掉该行；仍有阻塞就保留并在报告里说明这章仍按跳过处理。

### 其他能力

- `python scripts/lint.py <文件> --no-deslop` —— 只跑 sepia 自有规则（Node 缺失时自动降级并提示）。
- `scripts/deslop_bridge.py` —— 编排层，`review_classes()` 返回完整分流表，`punct()` 调标点归一。
- `python scripts/test_deslop.py` —— 18 条护栏行为测试（9 正样本 + 8 负样本 + 1 边界）。
- `python scripts/verify_deslop_parity.py` —— 对 demo 长篇做原稿 vs 编排层一致性比对。

### 口径约定（sepia 与 deslop 必须一致）

- **引号**：正文统一用全角弯引号 `“”`，成对出现；直角 `「」` 与半角 `"` 都是硬伤。
- **台词豁免**：`“”` 内的套词（深吸一口气 / 闪过一丝 / 那一刻明白…）**不计**——
  人物说话本来就会用这些。L1-2 禁用词与 L1-9 句式套子都只扫剥掉台词的叙述层。
  这条与 story-deslop 的引号遮罩对齐，否则同一段台词两套结论。
- **道具词**：`SOFT_WORDS`（钥匙 / 手机 / U盘 / 旧相册…）只做警惕提示，不当硬伤。
- **markdown 结构**：标题、表格、代码块、引用行都不是正文，sepia 与 deslop 都不扫。
  所以架构表写在章节文件顶部时，表里的说明文字不会被误判。

### 一条纪律

**脚本只报告，永不自动改写。** 安全改法永远是上下文判断：通常删掉否定铺垫直接写肯定项，
或用动作/细节呈现。标点归一默认 `--check`，要真改必须显式 `--fix`。

---

## 文件树

```
sepia-webnovel/                   技能包（只放规则与脚本，不放稿子）
  SKILL.md                        本文件
  VERSION / CHANGELOG.md          版本与变更
  scripts/
    lint.py                       机械项校验（词表从规则文件解析，不硬编码）
    deslop_bridge.py              去味检测器编排层（调 Node，映射等级 + review 分流）
    test_deslop.py                去味检测器护栏行为测试（18 条）
    verify_deslop_parity.py       编排层与原稿一致性回归
    deslop/                       story-deslop 检测器（MIT，原样迁入勿改）
      check-ai-patterns.js          句式与密度（7 blocking + 16 advisory）
      check-degeneration.js         退化检测（复读/截断/占位符/工程词泄漏）
      normalize-punctuation.js      标点归一（独立子命令）
      style-whitelist.js            书级白名单遮罩
  references/
    narrative-pass.md             第1层 架构：人物要什么、事件怎么连
    discourse-pass.md             第2层 篇章：段落、位置、开头、起名
    style-surface.md              第3层 句子：七类毛病、句式模板、双测试
    arc-pass.md                   第4层 卷级：钩子/峰值/波形/骨架重复
    state-schema.md               第0层 台账：跨章状态怎么记
    rubric.md                     诊断：28 项体检（五组）
    model-fingerprints.md         各模型的惯性（DeepSeek/Kimi/Claude/GPT/Qwen）
    zh-fiction/
      techniques.md               30 招（只放合规示例）
      anti-patterns.md            反例库（只看，别照抄）
      banned-words.md             禁用词 / 模板句式 / 模板道具
      roles.md                    五类角色
      diagnosis.md                四维＋朱雀六特征＋信号分级
      selfcheck.md                L1–L4 自检 + 双测试
```

稿子不放在技能包里，放在工作目录：

```
D:/Work/case_novel/sepia-webnovel-books/
  雾隐长安/
    state.md                     跨章台账（按 state-schema.md 建）
    ch001-雾夜抄书.md
```

`python <技能包>/scripts/lint.py <任意章节文件>`，脚本与稿子位置无关。

---

## 两句提醒

**第一，脚本管机械项，眼睛管语义项。** `lint.py` 能查破折号、禁用词、引号、句号密度，查不了"这段读着像不像人"。后者只能念出来听。

**第二，台账比什么都重要。** 写到第五章崩掉的长篇，九成不是文笔问题，是前面的事忘了。
