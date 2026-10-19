#!/usr/bin/env node
/**
 * T1：lint 端口一致性
 *
 * 对 server/tests/fixtures/sepia/lint/ 下每个语料，比对
 *   SepiaLintService 的输出  vs  expected.json（由 lint.py --json --no-deslop 现场生成）
 * 逐项比 stats / 条数 / item / level / detail，任何一处不同即失败。
 *
 * 用法：
 *   node server/scripts/sepia-pack/parity-lint.cjs [--sepia-dist dist/services/sepia]
 */

const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(SERVER, 'tests', 'fixtures', 'sepia', 'lint');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sepiaDist = path.resolve(SERVER, arg('--sepia-dist', 'dist/services/sepia'));
const lintMod = require(path.join(sepiaDist, 'lint', 'sepiaLint.js'));
const pack = JSON.parse(
  fs.readFileSync(path.join(sepiaDist, 'pack', 'rules.compiled.json'), 'utf8'),
);

const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));

let pass = 0;
const failures = [];

for (const id of Object.keys(expected)) {
  const file = path.join(FIXTURES, `${id}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const want = expected[id];

  let got;
  try {
    got = lintMod.lintText(text, pack);
  } catch (err) {
    failures.push({ id, kind: 'throw', msg: String(err && err.message) });
    continue;
  }

  const diffs = [];
  for (const k of ['chars', 'paras', 'sents']) {
    if (got.stats[k] !== want.stats[k]) {
      diffs.push(`stats.${k}: 期望 ${want.stats[k]} 实得 ${got.stats[k]}`);
    }
  }
  if (got.findings.length !== want.items.length) {
    diffs.push(`条数: 期望 ${want.items.length} 实得 ${got.findings.length}`);
  }
  const n = Math.max(got.findings.length, want.items.length);
  for (let i = 0; i < n; i += 1) {
    const a = want.items[i];
    const b = got.findings[i];
    if (!a || !b) {
      diffs.push(`#${i}: 缺 ${a ? 'TS' : 'Python'} 一侧（${JSON.stringify(a || b)}）`);
      continue;
    }
    if (a.item !== b.item || a.level !== b.level || a.detail !== b.detail) {
      diffs.push(
        `#${i}: 期望 [${a.level}] ${a.item} | ${a.detail}\n        实得 [${b.level}] ${b.item} | ${b.detail}`,
      );
    }
  }

  if (diffs.length === 0) {
    pass += 1;
  } else {
    failures.push({ id, kind: 'diff', diffs });
  }
}

const total = Object.keys(expected).length;
for (const f of failures) {
  console.log(`\n✗ ${f.id}`);
  if (f.kind === 'throw') {
    console.log(`  抛错：${f.msg}`);
  } else {
    for (const d of f.diffs.slice(0, 8)) console.log(`  ${d}`);
    if (f.diffs.length > 8) console.log(`  …还有 ${f.diffs.length - 8} 条`);
  }
}

console.log(`\nT1 lint 端口一致性：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
