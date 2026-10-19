#!/usr/bin/env node
/**
 * T2：deslop 一致性（Python lint.py 全量输出  vs  TS runSepiaGate）
 *
 * 这不只是"findings 数量与类型"的弱比对：直接比 `lint.py --json` 的完整
 * JSON 与 TS 的 { stats, findings, deslop }，逐项比 item / level / review / detail。
 *
 * 为什么必须比 detail：deslop 的 detail 里带行号、「excerpt」截断（24 码位）
 * 和中文 type 标签。行号错位、中文映射退化、切片按 UTF-16 切坏代理对，
 * 都只会在这里暴露，不会在"条数一致"里暴露。
 *
 * 前置：node 必须在 PATH 里（Python 侧 shutil.which("node") 要用）。
 *
 * 用法：
 *   node server/scripts/sepia-pack/parity-deslop.cjs [--python <exe>] [--sepia-dist <dir>]
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(SERVER, 'tests', 'fixtures', 'sepia', 'lint');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sepiaDist = path.resolve(SERVER, arg('--sepia-dist', 'dist/services/sepia'));
const pythonExe = arg(
  '--python',
  path.join(
    process.env.USERPROFILE || '',
    '.workbuddy',
    'binaries',
    'python',
    'versions',
    '3.13.12',
    'python.exe',
  ),
);

const gateMod = require(path.join(sepiaDist, 'gate', 'sepiaGate.js'));
const runnerMod = require(path.join(sepiaDist, 'deslop', 'deslopRunner.js'));
const pack = JSON.parse(
  fs.readFileSync(path.join(sepiaDist, 'pack', 'rules.compiled.json'), 'utf8'),
);
const packDir = path.join(sepiaDist, 'pack');
// 对照脚本用 **src** 里的 vendored 副本：dist 只带运行时需要的 deslop JS 与规则 JSON，
// 不带 references/ 与 lint.py（lint 已端口化）。两边 lint.py 必须字节一致，
// 一致性由 manifest 的 sourceHash 保证。
const lintPy = path.join(
  SERVER,
  'src',
  'services',
  'sepia',
  'pack',
  'source',
  'scripts',
  'lint.py',
);

if (!fs.existsSync(pythonExe)) {
  console.error(`未找到 Python：${pythonExe}（用 --python 指定）`);
  process.exit(2);
}
if (!fs.existsSync(lintPy)) {
  console.error(`未找到 vendored lint.py：${lintPy}`);
  process.exit(2);
}

// 先验证 dist 的检测器与 manifest 记录的 sha256 一致：
// 字节被改过的检测器会让 T2 "通过"而线上行为漂移，必须先卡住。
try {
  runnerMod.assertDetectorBytes(packDir);
  const drift = runnerMod.typeDrift(path.join(packDir, 'source', 'scripts', 'deslop'));
  if (drift.missing.length || drift.stale.length) {
    console.error(
      `[sepia] type 标签漂移：缺失 ${JSON.stringify(drift.missing)} 死键 ${JSON.stringify(drift.stale)}`,
    );
    process.exit(2);
  }
  console.log(`[sepia] 检测器字节校验通过，type 覆盖 ${drift.seen.length} 类`);
} catch (err) {
  console.error(`[sepia] ${String((err && err.message) || err)}`);
  process.exit(2);
}

// Python 侧靠 shutil.which("node") 找 node；把当前 node 所在目录塞进 PATH 前面。
const nodeDir = path.dirname(process.execPath);
const ENV = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}` };

function runPython(file) {
  const r = spawnSync(pythonExe, [lintPy, file, '--json'], {
    encoding: 'utf8',
    env: ENV,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw new Error(`python 启动失败：${r.error.message}`);
  // lint.py 在 err 级 findings 存在时退出码为 1，属正常
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`lint.py 退出码 ${r.status}\n${r.stderr || ''}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`lint.py 输出不是 JSON：\n${(r.stdout || '').slice(0, 400)}`);
  }
}

function norm(v) {
  return {
    item: v.item,
    level: v.level,
    detail: v.detail,
    review: v.review || '',
  };
}

(async () => {
  const ids = fs
    .readdirSync(FIXTURES)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.replace(/\.md$/, ''))
    .sort();

  let pass = 0;
  const failures = [];

  for (const id of ids) {
    const file = path.join(FIXTURES, `${id}.md`);
    const text = fs.readFileSync(file, 'utf8');

    let want;
    try {
      want = runPython(file);
    } catch (err) {
      failures.push({ id, kind: 'python', msg: String(err.message) });
      continue;
    }

    let got;
    try {
      got = await gateMod.runSepiaGate(text, pack, {
        deslopDir: path.join(packDir, 'source', 'scripts', 'deslop'),
        sourcePath: file,
      });
    } catch (err) {
      failures.push({ id, kind: 'throw', msg: String((err && err.message) || err) });
      continue;
    }

    const diffs = [];
    if (want.deslop !== got.deslop) {
      diffs.push(`deslop 状态: 期望 ${want.deslop} 实得 ${got.deslop}`);
    }
    for (const k of ['chars', 'paras', 'sents']) {
      if (want.stats[k] !== got.stats[k]) {
        diffs.push(`stats.${k}: 期望 ${want.stats[k]} 实得 ${got.stats[k]}`);
      }
    }
    if (want.items.length !== got.findings.length) {
      diffs.push(`条数: 期望 ${want.items.length} 实得 ${got.findings.length}`);
    }
    const n = Math.max(want.items.length, got.findings.length);
    for (let i = 0; i < n; i += 1) {
      const a = want.items[i];
      const b = got.findings[i];
      if (!a || !b) {
        diffs.push(`#${i}: 缺 ${a ? 'TS' : 'Python'} 一侧（${JSON.stringify(a || b)}）`);
        continue;
      }
      const na = norm(a);
      const nb = norm(b);
      for (const k of ['item', 'level', 'detail', 'review']) {
        if (na[k] !== nb[k]) {
          diffs.push(`#${i}.${k}: 期望 ${JSON.stringify(na[k])} 实得 ${JSON.stringify(nb[k])}`);
        }
      }
    }

    if (diffs.length === 0) pass += 1;
    else failures.push({ id, kind: 'diff', diffs });
  }

  for (const f of failures) {
    console.log(`\n✗ ${f.id}`);
    if (f.kind === 'diff') {
      for (const d of f.diffs.slice(0, 10)) console.log(`  ${d}`);
      if (f.diffs.length > 10) console.log(`  …还有 ${f.diffs.length - 10} 条`);
    } else {
      console.log(`  ${f.kind === 'python' ? 'Python 侧' : 'TS 侧'}失败：${f.msg}`);
    }
  }

  console.log(`\nT2 deslop 一致性：${pass}/${ids.length} 通过`);
  process.exit(pass === ids.length ? 0 : 1);
})();
