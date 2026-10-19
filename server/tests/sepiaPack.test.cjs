#!/usr/bin/env node
/**
 * 规则包加载与防篡改测试
 *
 * 这套断言守的是"可复现"：包被手改、检测器被手改、包丢失，都必须**报错**。
 * 一旦哪天真静默降级了，报告会显示"0 个问题"，而没人分得清是正文干净
 * 还是门根本没跑。
 *
 * 用法：
 *   node --test server/tests/sepiaPack.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SERVER = path.resolve(__dirname, '..');
const DIST = path.join(SERVER, 'dist', 'services', 'sepia');
const PACK_DIR = path.join(DIST, 'pack');

const { loadSepiaPack } = require(path.join(PACK_DIR, 'packLoader.js'));
const { assertDetectorBytes, defaultDeslopDir, typeDrift } = require(path.join(
  DIST,
  'deslop',
  'deslopRunner.js',
));
const { getSepiaPack, getSepiaGate, resetSepiaPackCache } = require(path.join(PACK_DIR, 'index.js'));

function tempCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sepia-pack-'));
  fs.cpSync(PACK_DIR, dir, { recursive: true });
  return dir;
}

test('规则包能加载，计数与 manifest 一致', () => {
  const pack = loadSepiaPack(PACK_DIR);
  assert.ok(pack.data.bannedWords.length > 100, '禁用词表过小，疑似解析失败');
  assert.ok(pack.data.sentencePatterns.length > 0, '句式表为空');
  assert.ok(pack.data.softWords.length > 0, '道具软词表为空');
  assert.match(pack.meta.contentHash, /^[0-9a-f]{64}$/);
});

test('单例：同一进程内只读一次盘', () => {
  resetSepiaPackCache();
  const a = getSepiaPack();
  const b = getSepiaPack();
  assert.equal(a, b, '两次取包返回了不同对象');
  assert.equal(getSepiaPack(), a);
});

test('包被改动一个字 → contentHash 校验失败', () => {
  const dir = tempCopy();
  try {
    const file = path.join(dir, 'rules.compiled.json');
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    pack.data.bannedWords[0] = `${pack.data.bannedWords[0]}改动`;
    fs.writeFileSync(file, JSON.stringify(pack, null, 2));
    assert.throws(() => loadSepiaPack(dir), /contentHash 不匹配/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('包目录为空 → 明确报缺包，不返回空词表', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sepia-empty-'));
  try {
    assert.throws(() => loadSepiaPack(dir), /规则包缺失/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('检测器字节被改动 → 加载时即失败', () => {
  const dir = tempCopy();
  try {
    const js = path.join(defaultDeslopDir(dir), 'check-degeneration.js');
    fs.appendFileSync(js, '\n// tampered\n');
    assert.throws(() => assertDetectorBytes(dir), /检测器字节被改动/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deslop 的 type 与中文标签一一对应（无遗漏、无死键）', () => {
  const drift = typeDrift(defaultDeslopDir(PACK_DIR));
  assert.deepEqual(drift.missing, [], `JS 产出但未登记中文名：${drift.missing.join(',')}`);
  assert.deepEqual(drift.stale, [], `登记了但 JS 已不产出：${drift.stale.join(',')}`);
  assert.ok(drift.seen.length >= 20, `只扫到 ${drift.seen.length} 类，疑似正则失效`);
});

test('gate 单例可直接跑一次完整门', async () => {
  resetSepiaPackCache();
  const file = path.join(SERVER, 'tests', 'fixtures', 'sepia', 'lint', 's18_real_chapter.md');
  const report = await getSepiaGate().run(fs.readFileSync(file, 'utf8'), { sourcePath: file });
  assert.equal(report.deslop, 'ok');
  assert.equal(report.deslopOk, true);
  assert.equal(report.packVersion, getSepiaPack().meta.packVersion);
  assert.equal(report.blockingCount, report.blocking.length);
  assert.equal(report.advisoryCount, report.advisory.length);
});
