/**
 * T14：deslop 护栏用例（从 sepia 的 test_deslop.py 逐条迁成 TS）
 *
 * 原 Python 测试在 P4 退役后跑不了，这些断言不能丢：
 * 正样本必须拦得住，负样本必须不误伤，否则「照搬」只对原稿成立、对护栏不成立。
 * 用例的校准依据保留在每条注释里（来自 story-deslop 源码注释）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist', 'services', 'sepia');
const {
  mergeDeslop,
  labelFor,
  defaultDeslopDir,
} = require(path.join(dist, 'deslop', 'deslopRunner.js'));

const deslopDir = defaultDeslopDir(path.join(dist, 'pack'));

async function scanText(text) {
  const findings = [];
  const status = await mergeDeslop(text, findings, { deslopDir });
  // 汇总项「去味检测器（story-deslop）」只表示「本次有没有硬伤」，不是一条具体命中
  const details = findings.filter((item) => !item.item.startsWith('去味检测器'));
  return { status, findings: details };
}

async function expectHit(name, text, type) {
  const { status, findings } = await scanText(text);
  assert.equal(status, 'ok', `${name}: 检测器不可用`);
  const label = labelFor(type);
  assert.ok(
    findings.some((item) => item.item.includes(label)),
    `${name}: 应命中 ${type}(${label})，实际 ${findings.map((f) => f.item).join(' / ') || '无'}`,
  );
}

async function expectMiss(name, text) {
  const { status, findings } = await scanText(text);
  assert.equal(status, 'ok', `${name}: 检测器不可用`);
  assert.equal(findings.length, 0, `${name}: 不应有任何命中，实际 ${findings.map((f) => f.item).join(' / ')}`);
}

test('正样本：固定句式与模板必须拦得住', async (t) => {
  await t.test('不是A而是B（固定句式模板，blocking）', () =>
    expectHit('不是A而是B', '他不是愤怒，而是平静。', 'not-is-comparison'));

  await t.test('音量反差（实战漏网 A：《万疆》20 章 0 命中）', () =>
    expectHit('音量反差', '声音不大，却压住了全场。', 'voice-contrast'));

  await t.test('否定排比（同句 ≥2 个「没有X，」连排）', () =>
    expectHit('否定排比', '没有伴奏，没有和声，没有提词器。', 'negation-parade'));

  await t.test('否定排比变体（先否定铺垫再「只是」收肯定）', () =>
    expectHit('否定排比变体', '他没炫技，没有那种架势。他只是唱。', 'negation-parade'));

  await t.test('反序对比（not-is 的反序变种，实战漏网 C）', () =>
    expectHit('反序对比', '是真嗓子，不是修音修出来的。', 'reverse-not-is'));

  await t.test('预告式收尾（文末 600 字窗口）', () =>
    expectHit('预告式收尾', '没人知道，这才刚刚开头。', 'trailer-ending'));

  await t.test('章尾总结体（盖章过去）', () =>
    expectHit('章尾总结体', '这一切都结束了。', 'trailer-summary'));

  await t.test('破折号（标点硬门禁）', () =>
    expectHit('破折号', '他开口了——声音很低。', 'em-dash'));

  await t.test('工程词泄漏（tier1 流水线术语）', () =>
    expectHit('工程词泄漏', '他想起了细纲里写的伏笔。', 'meta-leak'));
});

test('负样本：护栏必须放过（误伤=0 是设计目标）', async (t) => {
  await t.test('either-or 不算翻转', () => expectMiss('either-or', '这不是A，就是B。'));
  await t.test('反问尾巴', () => expectMiss('反问尾巴', '他不是英雄吗？'));
  await t.test('确认语承接', () => expectMiss('确认语承接', '不是第一次来。是的，他还记得。'));
  await t.test('黏着语素「沉没」', () => expectMiss('黏着语素', '船沉没在雾里，没人回头。'));
  await t.test('时间惯用语「没多久」', () => expectMiss('时间惯用语', '没多久，没等她撑伞，他就走了。'));
  await t.test('台词内不算', () => expectMiss('台词内', '“不是不报，是时候未到。”'));
  await t.test('正常否定对偶', () => expectMiss('正常否定对偶', '他没哭也没闹。'));
  await t.test('普通「不是」', () => expectMiss('普通不是', '这不是我的伞。'));
});

test('边界：引号遮罩口径与 story-deslop 一致', async (t) => {
  await t.test('弯引号内的套词是人物口语，不算命中', () =>
    expectMiss('台词内套词', '“你深吸一口气，眼里闪过一丝复杂的神色。”\n\n她忍不住深吸一口气。'));

  await t.test('跳过标记是流程标记，不是豁免——脚本照常检测', () =>
    expectHit('跳过标记仍扫描', '<!-- 去味:跳过 -->\n他不是愤怒，而是平静。', 'not-is-comparison'));
});
