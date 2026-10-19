# sepia 规则包工具链

七个脚本，按执行顺序：

| # | 脚本 | 作用 | 何时跑 |
|---|---|---|---|
| 1 | `build-pack.py` | 读 `src/services/sepia/pack/source/` 的规则文件，产出 `rules.compiled.json` + `manifest.json` | 规则文件变更后 |
| 2 | `gen-lint-fixtures.py` | 用 `lint.py` 本体生成 T1 语料与期望值（ground truth 不手写） | 语料变更后 |
| 3 | `tsc-sepia.cjs` | 只编译 `src/services/sepia/**` 到 `dist/`，再跑 `copy-pack` | 改 sepia 代码后 |
| 4 | `copy-pack.cjs` | 把 pack 的 JSON 与 vendor 的 deslop JS 同步进 `dist/`（已在 `pnpm build` 里挂钩） | 每次构建 |
| 5 | `parity-lint.cjs` | T1：TS lint 端口 vs `lint.py --no-deslop` 逐项比对 | 改端口后 / CI |
| 6 | `parity-deslop.cjs` | T2：`lint.py` 全量输出（含 deslop）vs `runSepiaGate` 逐项比对 | 改端口/换检测器后 / CI |
| 7 | `tests/*.test.cjs` | T3：分级转译 + 规则包防篡改 | 改 gate / 改包后 |

## 命令

```bash
# 1. 重编译规则包（--verify-against 会额外比对另一个 sepia 源码目录，确认数据没漂）
python server/scripts/sepia-pack/build-pack.py \
  --verify-against ../sepia-webnovel/scripts

# 2. 重新生成 T1 语料
python server/scripts/sepia-pack/gen-lint-fixtures.py

# 3. 构建 + 同步（整仓 build；没装依赖时用 tsc-sepia.cjs）
pnpm --filter @ai-novel/server build
# 或只编 sepia 子树：
node server/scripts/sepia-pack/tsc-sepia.cjs

# 4. T1 端口一致性
pnpm --filter @ai-novel/server sepia:parity

# 5. T2 deslop 一致性（会先校验检测器 sha256 与 type 标签覆盖）
node server/scripts/sepia-pack/parity-deslop.cjs

# 6. T3 分级 / 规则包防篡改、T4 验收转译、T5 复跑回滚
pnpm --filter @ai-novel/server sepia:test
# 等价于：
node --test server/tests/sepiaGate.test.cjs server/tests/sepiaPack.test.cjs \
  server/tests/sepiaAcceptance.test.cjs server/tests/sepiaRegression.test.cjs
```

## 三条约束

1. **解析不重写**：`build-pack.py` 直接 `import` vendor 的 `lint.py` 调它的 loader。
   重写解析器 = 词表漂移，而 `contentHash` 查不出来。
2. **阈值不进 JSON**：`lint.py` 的阈值是内嵌字面量（无模块级常量），抽出来要人判断，
   等于改 sepia。阈值留在 `lint/sepiaLint.ts` 里逐字转写，并标注来源。
3. **期望值不手写**：`expected.json` 全部由 `lint.py --json --no-deslop` 现场生成。
   手写期望值等于用我的理解当标准，测不出端口偏差。

## deslop 调用口径（`deslopRunner.ts`）

| 项 | 值 | 依据 |
|---|---|---|
| 超时 | 60 s | `deslop_bridge.py` 的 `subprocess.run(..., timeout=60)`。曾计划 3 s，被否决：改超时就是改行为 |
| 检测器失败 | 跳过该检测器，另一个照跑 | 同 Python 的 `continue`；不是"门降级为不阻塞" |
| 退出码 2 | 跳过 | `check-*.js` 读文件失败的约定 |
| 破折号 | 与 L1-1 去重，以 sepia 为准 | `merge_deslop()` 的 `seen_dash` |
| 剥 meta | 有 markdown 结构时写临时文件再扫 | 同 Python；副作用是临时目录里没有 `.deslop-whitelist`，**这是上游既有行为，未修正** |
| 字节校验 | 启动时比对 manifest 的 sha256 | 这是"检测器零改写"从口号变成可执行检查的唯一办法 |

`mergeDeslop` 的 `sourcePath` 对应 `lint.py` 的 `a.file`：正文来自文件时传它，
`.deslop-whitelist` 才能生效；正文来自数据库的章节没有这个路径，只能走临时文件。

## 语料设计

每个语料踩一个阈值边界，且都 ≥100 字（`n_char < 100` 会走早退分支，后面 14 项全不执行）：

| 用例 | 验证点 |
|---|---|
| `s01_short_body` | 早退分支仍报 L1-1 |
| `s02_clean` | 干净文本基线（`err=0`） |
| `s03_dash` | `——` 算 1 处，不数横杠字符 |
| `s04_banned` | 长词覆盖短词（「空气仿佛凝固了」命中后「仿佛」不单算） |
| `s05_quotes` | 直角 + 半角混排 |
| `s06_colon` | 冒号只 warn |
| `s07_pattern_once` / `_dense` | 「不是X而是Y」1 次 vs 3 次（密度红线） |
| `s08_low_period` | 句号密度低于 5 |
| `s09_uniform_paras` | 连续 4 段长度雷同 |
| `s10_same_length` | 相邻同长句 ≥3 |
| `s11_long_sentences` | 超长句 ≥3 |
| `s12_dialogue_low` / `_high` | 对话占比 <30%（有场景）/ >50% |
| `s13_opening` | 开篇比喻 + 镜头式开场两个候选 |
| `s14_inner` | 内心总结句候选 |
| `s15_replacement` | 替代词过载（≥4 次） |
| `s16_markdown` | 标题/表格/代码块/引用不进正文 |
| `s17_section` | 「## 四、正文」分节只取正文节 |
| `s18_real_chapter` | 真实章节（2723 字）整体回归 |
