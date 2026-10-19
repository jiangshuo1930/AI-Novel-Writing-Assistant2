#!/usr/bin/env node
/**
 * T3：sepia 机械门分级测试
 *
 * 只测 gate 的**转译**是否正确，不测 lint/deslop 的判定（那是 T1/T2 的事）。
 * 重点卡三类容易悄悄错的地方：
 *   1. 汇总项被当成 blocking —— 会让 blocking 数永远虚高 1，且没人看得出
 *   2. 附属行（↳ 位置/命中）被当成独立问题 —— 同一问题报两次
 *   3. 有人给机械项开了 rewritable —— 直接违反 C5 裁决，系统会开始自动改句子
 *
 * 用法：
 *   node --test server/tests/sepiaGate.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const SERVER = path.resolve(__dirname, '..');
const DIST = path.join(SERVER, 'dist', 'services', 'sepia');
const FIXTURES = path.join(SERVER, 'tests', 'fixtures', 'sepia', 'lint');

const { SepiaGateService, gradeFindings } = require(path.join(DIST, 'gate', 'SepiaGateService.js'));

const pack = JSON.parse(fs.readFileSync(path.join(DIST, 'pack', 'rules.compiled.json'), 'utf8'));
const deslopDir = path.join(DIST, 'pack', 'source', 'scripts', 'deslop');

function gate(id) {
  const file = path.join(FIXTURES, `${id}.md`);
  const svc = new SepiaGateService(pack, { deslopDir, sourcePath: file });
  return svc.run(fs.readFileSync(file, 'utf8'), { sourcePath: file });
}

function isChild(item) {
  return item.startsWith('  ↳ ');
}

function isSummary(item) {
  return item === '去味检测器（story-deslop）';
}

test('汇总项不进入 blocking/advisory，但仍保留在 raw', async () => {
  const r = await gate('s09_uniform_paras');
  const summary = r.raw.filter((f) => isSummary(f.item));
  assert.equal(summary.length, 1, 'raw 里应有一条汇总项');
  assert.equal(summary[0].level, 'err', '该样本有 deslop 硬伤，汇总项应为 err');

  const ids = [...r.blocking, ...r.advisory].map((f) => f.checkId);
  assert.ok(
    !ids.some((id) => id.includes('summary')),
    `汇总项泄漏进了分级结果：${ids.join(',')}`,
  );
  // 若汇总项被计数，blocking 会是 10
  assert.equal(r.blockingCount, 9);
});

test('分级条数 = raw 里 err/warn 主项数（排除汇总与附属行）', async () => {
  const ids = fs
    .readdirSync(FIXTURES)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.replace(/\.md$/, ''));

  for (const id of ids) {
    const r = await gate(id);
    const want = r.raw.filter((f) => {
      if (isSummary(f.item) || isChild(f.item)) return false;
      return f.level === 'err' || f.level === 'warn';
    });
    assert.equal(
      r.blockingCount + r.advisoryCount,
      want.length,
      `${id}: 分级条数与 raw 不一致`,
    );
    assert.equal(
      r.blockingCount,
      want.filter((f) => f.level === 'err').length,
      `${id}: blocking 数不对`,
    );
    assert.equal(
      r.advisoryCount,
      want.filter((f) => f.level === 'warn').length,
      `${id}: advisory 数不对`,
    );
  }
});

test('机械项一律不可自动改写（C5）', async () => {
  for (const id of ['s09_uniform_paras', 's03_dash', 's18_real_chapter']) {
    const r = await gate(id);
    for (const f of [...r.blocking, ...r.advisory]) {
      assert.equal(f.rewritable, false, `${id}: ${f.checkId} 被标成可改写`);
    }
  }
});

test('deslop 项带 type、行号与连续引文', async () => {
  const r = await gate('s09_uniform_paras');
  const deslop = r.blocking.filter((f) => f.checkId.startsWith('deslop:'));
  assert.ok(deslop.length > 0, '该样本应有 deslop 硬伤');
  for (const f of deslop) {
    assert.match(f.checkId, /^deslop:[a-z][a-z0-9-]+$/);
    assert.equal(typeof f.line, 'number');
    assert.ok(f.line >= 1);
    assert.ok(f.quote.length > 0, `${f.checkId} 缺引文`);
    assert.equal(f.layer, 'surface');
  }
});

test('lint 项 checkId 有稳定命名空间，未登记项也不丢', async () => {
  const r = await gate('s18_real_chapter');
  for (const f of [...r.blocking, ...r.advisory]) {
    assert.ok(f.checkId.length > 0);
    assert.ok(
      /^(L1-\d+|lint:|deslop:)/.test(f.checkId),
      `checkId 不合规：${f.checkId}（rawItem=${f.rawItem}）`,
    );
  }
});

test('正文不足 100 字时 deslop 仍然要跑', async () => {
  // lint.py 在早退分支里特意先算完破折号再做 deslop 去重；
  // 若这里 deslop 被跳过，短章会静默漏掉整层检测。
  const r = await gate('s01_short_body');
  assert.equal(r.deslop, 'ok', 'deslop 不应被短文本分支跳过');
});

test('同一输入重复运行结果一致', async () => {
  const a = await gate('s09_uniform_paras');
  const b = await gate('s09_uniform_paras');
  assert.deepEqual(
    a.blocking.map((f) => `${f.checkId}@${f.line}`),
    b.blocking.map((f) => `${f.checkId}@${f.line}`),
  );
  assert.equal(a.blockingCount, b.blockingCount);
  assert.equal(a.advisoryCount, b.advisoryCount);
});

test('gradeFindings 不改变输入数组', () => {
  const items = [
    { item: 'L1-1 破折号', level: 'err', detail: '2 处（要求 0）' },
    { item: 'L1-6 冒号', level: 'warn', detail: '3 处（尽量 0）' },
    { item: 'L1-5 引号', level: 'ok', detail: '正常' },
  ];
  const snapshot = JSON.parse(JSON.stringify(items));
  const { blocking, advisory } = gradeFindings(items);
  assert.deepEqual(items, snapshot, '输入被就地改写');
  assert.equal(blocking.length, 1);
  assert.equal(advisory.length, 1);
  assert.equal(blocking[0].checkId, 'L1-1');
});

test('↳ 位置附属行并入主项引文（丢掉就没了修文锚点）', async () => {
  const r = await gate('s03_dash');
  const dash = r.blocking.find((f) => f.checkId === 'L1-1');
  assert.ok(dash, 's03 应报 L1-1 破折号');
  assert.ok(dash.quote.length > 0, 'L1-1 的命中原文必须跟着主项走');
  assert.match(dash.quote, /—/);
  // 附属行本身不能独立成条
  assert.equal(r.blocking.filter((f) => isChild(f.rawItem)).length, 0);
});

test('不变量：所有 blocking 都能修，只有正文过短豁免', async () => {
  const acc = require(path.join(DIST, 'acceptance', 'sepiaAcceptance.js'));
  const ids = fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.md'));
  const unrepairable = [];
  for (const id of ids) {
    const r = await gate(path.basename(id, '.md'));
    for (const f of r.blocking) {
      if (acc.classifyFixClass(f) === 'distribution' && f.checkId !== 'lint:body-too-short') {
        unrepairable.push(`${id}:${f.checkId}`);
      }
    }
  }
  assert.deepEqual(unrepairable, [],
    '这些 blocking 被降级成「只报告」，等于 sepia 的 FAIL 清零落不了地');
});
