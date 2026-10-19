/**
 * T4：sepia → 验收 / 修文转译
 *
 * 只测转译层自己的判定（点位型 vs 分布型、状态不被降级、封顶、降级路径），
 * 不重复测 lint 端口（T1）与 deslop 一致性（T2）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist', 'services', 'sepia');
const acc = require(path.join(dist, 'acceptance', 'sepiaAcceptance.js'));

function finding(over = {}) {
  return {
    checkId: 'L1-2',
    severity: 'blocking',
    layer: 'surface',
    rewritable: false,
    quote: '',
    line: null,
    message: '命中禁用词「仿佛」',
    rawItem: 'L1-2 禁用词',
    rawDetail: '共 3 处：仿佛、忽然、一丝',
    ...over,
  };
}

function report(blocking = [], over = {}) {
  return {
    packVersion: 'test',
    contentHash: 'test',
    deslop: 'ok',
    deslopOk: true,
    stats: { chars: 100, paras: 3, sents: 5 },
    blocking,
    advisory: [],
    blockingCount: blocking.length,
    advisoryCount: 0,
    raw: [],
    ...over,
  };
}

function assessment(over = {}) {
  return {
    status: 'accepted',
    blockingIssues: [],
    repairDirectives: [],
    repairability: 'none',
    continuePolicy: 'continue',
    riskTags: [],
    ...over,
  };
}

test('修法归类照抄 sepia 的分流（binding → point / [可直改] → point / [读上下文] → 不留）', () => {
  // sepia：「blocking → FAIL（必须清零）→ 就地改写，规则全部带护栏，不需要判断」
  assert.equal(acc.classifyFixClass(finding({ checkId: 'L1-1', severity: 'blocking' })), 'point');
  assert.equal(acc.classifyFixClass(finding({ checkId: 'L1-9-density', severity: 'blocking' })), 'point');
  assert.equal(acc.classifyFixClass(finding({ checkId: 'deslop:em-dash', severity: 'blocking' })), 'point');
  assert.equal(acc.classifyFixClass(finding({ checkId: 'deslop:not-is-comparison', severity: 'blocking', review: 'mechanical' })), 'point');
  // sepia：「advisory → WARN [可直改] → mechanical：形态即问题，就地改」
  assert.equal(acc.classifyFixClass(finding({ checkId: 'deslop:metaphor-density-tic', severity: 'advisory', review: 'mechanical' })), 'point');
  // sepia：「advisory → WARN [读上下文] → semantic：可能承担叙事功能，读上下文再定」
  // 归 context：照常进 patch，只是要求先判断再改
  assert.equal(acc.classifyFixClass(finding({ checkId: 'deslop:soft-verb', severity: 'advisory', review: 'semantic' })), 'context');
  // sepia 自有 warn 项不带 review，在 sepia 里是「待看」，不清零
  assert.equal(acc.classifyFixClass(finding({ checkId: 'lint:paragraph-rhythm', severity: 'advisory' })), 'distribution');
  // 唯一豁免：正文不足 100 字 = 输入格式错，改无可改
  assert.equal(acc.classifyFixClass(finding({ checkId: 'lint:body-too-short', severity: 'blocking' })), 'distribution');
  // 新出现的 blocking 项默认进 patch，而不是被悄悄降级成「只报告」
  assert.equal(acc.classifyFixClass(finding({ checkId: 'lint:brand-new-check', severity: 'blocking' })), 'point');
});

test('blocking → high severity，code 前缀稳定，line 压进 evidence', () => {
  const issues = acc.toAcceptanceIssues(report([
    finding({ checkId: 'deslop:meta-leak', line: 12, message: '出现 prompt 字样', quote: '这是 prompt 提示' }),
  ]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'high');
  assert.equal(issues[0].code, 'SEPIA_deslop_meta-leak');
  assert.equal(issues[0].canAutoRewrite, false);
  assert.match(issues[0].evidence, /第12行/);
  assert.equal(issues[0].currentEvidence, '这是 prompt 提示');
});

test('超过 350 字的引文不塞进 currentEvidence（ANA schema 有上限）', () => {
  const issues = acc.toAcceptanceIssues(report([finding({ quote: '字'.repeat(400) })]));
  assert.equal(issues[0].currentEvidence, undefined);
});

test('repairable：点位型 → patchable_obligation_gap + repair_once', () => {
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([finding()]));
  assert.equal(merged.status, 'repairable');
  assert.equal(merged.repairability, 'patchable_obligation_gap');
  assert.equal(merged.continuePolicy, 'repair_once');
  assert.equal(merged.repairDirectives.length, 1);
  assert.equal(merged.repairDirectives[0].mode, 'patch');
  assert.ok(merged.riskTags.some((t) => t.startsWith(acc.SEPIA_BLOCKING_TAG + ':')));
});

test('blocking 只剩 body-too-short → rewrite_needed + manual（唯一豁免项）', () => {
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([
    finding({ checkId: 'lint:body-too-short', severity: 'blocking', message: '只识别到 11 字正文，检查文件格式' }),
  ]));
  assert.equal(merged.repairability, 'rewrite_needed');
  assert.equal(merged.repairDirectives.length, 1);
  assert.equal(merged.repairDirectives[0].mode, 'manual');
  // 输入格式问题也照常进 issues，不能因为改不了就不报
  assert.equal(merged.blockingIssues.length, 1);
});

test('plot 类硬伤归情节配比（target=plot）', () => {
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([
    finding({ checkId: 'lint:dialogue-ratio', severity: 'blocking', message: '对话占比 8%，低于 15%' }),
  ]));
  assert.equal(merged.repairDirectives[0].target, 'plot');
  assert.equal(merged.repairDirectives[0].mode, 'patch');
});

test('sepia 自有 warn（待看）不进改写清单，但照常进 issues', () => {
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([
    finding({ checkId: 'L1-2', severity: 'blocking' }),
  ], {
    blockingCount: 1,
    advisory: [finding({ checkId: 'lint:paragraph-rhythm', severity: 'advisory', message: '4 段长度差 <10%' })],
    advisoryCount: 1,
  }));
  assert.equal(merged.repairDirectives.length, 1);
  assert.equal(merged.repairDirectives[0].instruction.includes('L1-2'), true);
  assert.ok(merged.riskTags.some((t) => t.startsWith(acc.SEPIA_ADVISORY_TAG + ':')));
});

test('blocking 一条不落全部转成 patch 指令（上限与 issues 同为 5）', () => {
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([
    finding({ checkId: 'L1-2' }),
    finding({ checkId: 'L1-5' }),
    finding({ checkId: 'L1-6' }),
    finding({ checkId: 'lint:long-sentence' }),
  ]));
  assert.equal(merged.repairDirectives.length, 4);
  assert.ok(merged.repairDirectives.every((d) => d.mode === 'patch'));
  assert.ok(merged.blockingIssues.length >= 4);
});

test('needs_manual_review 不被 sepia 降级', () => {
  const merged = acc.mergeSepiaIntoAssessment(
    assessment({ status: 'needs_manual_review', continuePolicy: 'pause' }),
    report([finding()]),
  );
  assert.equal(merged.status, 'needs_manual_review');
  assert.equal(merged.continuePolicy, 'pause');
});

test('plan_misalignment 不被覆盖', () => {
  const merged = acc.mergeSepiaIntoAssessment(
    assessment({ repairability: 'plan_misalignment' }),
    report([finding()]),
  );
  assert.equal(merged.repairability, 'plan_misalignment');
});

test('无 blocking 时 assessment 原样返回，只补 riskTag', () => {
  const base = assessment({ status: 'accepted', continuePolicy: 'continue' });
  const merged = acc.mergeSepiaIntoAssessment(base, report([]));
  assert.equal(merged.status, 'accepted');
  assert.equal(merged.continuePolicy, 'continue');
  assert.equal(merged.blockingIssues.length, 0);
  assert.ok(!merged.riskTags.some((t) => t.startsWith(acc.SEPIA_BLOCKING_TAG)));
});

test('deslop 没跑成时打标记，但不当成 blocking', () => {
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([], { deslop: 'unavailable', deslopOk: false }));
  assert.equal(merged.status, 'accepted');
  assert.ok(merged.riskTags.includes('sepia_deslop_unavailable'));
});

test('同一 code 不重复追加（复跑同一章时幂等）', () => {
  const once = acc.mergeSepiaIntoAssessment(assessment(), report([finding()]));
  const twice = acc.mergeSepiaIntoAssessment(once, report([finding()]));
  assert.equal(twice.blockingIssues.length, once.blockingIssues.length);
  assert.equal(twice.repairDirectives.length, once.repairDirectives.length);
});

test('门抛错时降级：assessment 不变，打 unavailable 标记', async () => {
  const base = assessment();
  const r = await acc.applySepiaGate(base, '正文', {
    gate: { run: async () => { throw new Error('规则包缺失'); } },
  });
  assert.equal(r.degraded, true);
  assert.equal(r.report, null);
  assert.equal(r.assessment.status, 'accepted');
  assert.equal(r.assessment.blockingIssues.length, 0);
  assert.ok(r.assessment.riskTags.includes(acc.SEPIA_UNAVAILABLE_TAG));
});

test('正常路径经 applySepiaGate 合入', async () => {
  const r = await acc.applySepiaGate(assessment(), '正文', {
    gate: { run: async () => report([finding()]) },
  });
  assert.equal(r.degraded, false);
  assert.equal(r.assessment.status, 'repairable');
});

test('SEPIA_GATE_DISABLED=1 时完全跳过（不调用门）', async () => {
  let called = false;
  const r = await acc.applySepiaGate(assessment(), '正文', {
    disabled: true,
    gate: { run: async () => { called = true; return report([finding()]); } },
  });
  assert.equal(called, false);
  assert.equal(r.assessment.status, 'accepted');
});

test('放行条件单列 blocking 计数：数组被去重/截断到 0 条也不算通过', () => {
  // 报告说 1 条硬伤，但 blocking 数组是空的（例如条目都落在豁免或去重里）。
  // 旧写法只数数组，会把这一章判成 accepted —— 等于错放行。
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([], { blockingCount: 1 }));
  assert.equal(merged.status, 'repairable');
  assert.equal(merged.continuePolicy, 'repair_once');
  assert.ok(merged.riskTags.includes('sepia_blocking:1'));
  // 没有可落地条目时不去编指令
  assert.equal(merged.blockingIssues.length, 0);
});

test('[读上下文] 也进 patch 通道，但指令要求先判断再改', () => {
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([], {
    advisory: [
      finding({ checkId: 'deslop:soft-verb', severity: 'advisory', review: 'semantic', message: '软动词：进行 / 作出', line: 7 }),
    ],
    advisoryCount: 1,
  }));
  // 只有 advisory 时仍要有可执行指令，否则 LLM 根本没机会判断
  assert.equal(merged.repairDirectives.length, 1);
  const d = merged.repairDirectives[0];
  assert.equal(d.mode, 'patch');
  assert.match(d.instruction, /读上下文/);
  assert.match(d.instruction, /保留原文/);
  assert.match(d.instruction, /可以不产出补丁/);
  // 不进 blockingIssues：advisory 不阻塞
  assert.equal(merged.blockingIssues.length, 0);
  assert.ok(merged.riskTags.some((t) => t.startsWith(acc.SEPIA_ADVISORY_TAG + ':')));
});

test('[读上下文] 不把 accepted 抬成 repairable：warn 不主动开修文', () => {
  // 之前 semantic 落 manual，directive 全非 patch 会让 shouldAttemptAutomaticRepair 返回 false
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([], {
    advisory: [finding({ checkId: 'deslop:soft-verb', severity: 'advisory', review: 'semantic', line: 3 })],
    advisoryCount: 1,
  }));
  assert.equal(merged.status, 'accepted');              // sepia 的 warn 不阻塞，也不该开修文
  assert.equal(merged.continuePolicy, 'continue');
  assert.ok(merged.repairDirectives.some((d) => d.mode === 'patch'));  // 指令随行
});
