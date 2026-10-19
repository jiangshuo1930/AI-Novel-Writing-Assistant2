# sepia vendor 脚本：哪些还在用，哪些已退役

这个目录是从 sepia-webnovel v0.5.1 原样 vendor 进来的。并入 ANA 后分三类：
**运行时不调用任何 Python**；构建期用 `lint.py` 编译词表；对照期用 `lint.py + deslop_bridge.py` 当基准跑 T1/T2。

## 一、构建期（生成 `rules.compiled.json`）

| 文件 | 用途 | 为什么不能删 |
|---|---|---|
| `lint.py` | `build-pack.py` 直接 import 它的 `load_banned_words()` / `load_sentence_patterns()` / `SOFT_WORDS` | 它是词表的唯一真源。删了词表就没有可复现的来源，「改一个字要能查出来」这条保证会丢 |

## 二、对照期（T1 / T2 的基准实现）

| 文件 | 用途 | 为什么不能删 |
|---|---|---|
| `lint.py` | `parity-lint.cjs` 跑 `lint.py --json`，与 TS 端口逐项比对 | 没有基准就没有一致性验证；TS 端口出偏差时无从发现 |
| `deslop_bridge.py` | `lint.py` 的 deslop 部分由它桥接 4 个 JS 检测器 | 删掉它，`lint.py` 只剩汇总项，T2 直接失效（实测过：删后 T2 从 20/20 掉到 0/20） |

这两条是**验收工具**，不是运行时依赖。运行时（`SepiaLintService` / `deslopRunner`）是它们的 TS 端口与 Node 子进程封装，不 spawn Python。

## 三、已退役（2026-10-19，P4）

| 文件 | 原用途 | 原 sha256 | 退役依据 | 承接者 |
|---|---|---|---|---|
| `test_deslop.py` | 19 条护栏用例（9 正 + 8 负 + 2 边界） | `87989d2e…28c4cc` | Python 测试在运行时无处调用，会形成防线真空 | `server/tests/sepiaDeslopGuards.test.cjs`（逐条迁移，校准依据写在注释里，22/22） |
| `verify_deslop_parity.py` | Python 版一致性校验 | `367e2b20…15aa97` | 功能已被 Node 版覆盖，两边同时存在会产生「哪份才是判据」的歧义 | `scripts/sepia-pack/parity-lint.cjs`、`parity-deslop.cjs` |

退役会让 `sourceHash` 变（文件清单变了），这是预期的：包内容确实不同，
`manifest.json` 与 `rules.compiled.json` 的 `sourceHash` 会一起更新，`packLoader` 启动校验照常。

## 四、重新编译

```bash
cd server
python scripts/sepia-pack/build-pack.py
node scripts/sepia-pack/copy-pack.cjs
```

`build-pack.py` 只依赖 `lint.py`；删掉它会让编译直接失败——这是有意为之的硬约束。
