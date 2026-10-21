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

test('advisory 形态项在硬伤清零后独立开一轮修文，并标记为「只差 advisory」', () => {
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([], {
    advisory: [
      finding({ checkId: 'L1-6', severity: 'advisory', rawItem: 'L1-6 冒号', message: '19 处（尽量 0）' }),
      finding({ checkId: 'lint:long-sentence', severity: 'advisory', rawItem: '超长句', message: '5 句 >55 字' }),
    ],
    advisoryCount: 2,
  }));
  assert.equal(merged.status, 'repairable');
  assert.equal(merged.continuePolicy, 'repair_once');
  // 关键：不算硬伤，章节仍可判过，否则一个冒号密度会卡死整条流水线
  assert.ok(merged.riskTags.includes(acc.SEPIA_ADVISORY_REPAIR_TAG));
  assert.ok(!merged.riskTags.some((t) => t.startsWith('sepia_blocking')));
  assert.equal(merged.blockingIssues.length, 0);
  const instructions = merged.repairDirectives.map((d) => d.instruction).join('\n');
  assert.match(instructions, /L1-6/);
  assert.match(instructions, /55 字/);
});

test('advisory 清理可整体关掉（排障时回到只清 blocking）', () => {
  process.env.SEPIA_ADVISORY_REPAIR = 'off';
  try {
    const merged = acc.mergeSepiaIntoAssessment(assessment(), report([], {
      advisory: [finding({ checkId: 'L1-6', severity: 'advisory', rawItem: 'L1-6 冒号', message: '19 处' })],
      advisoryCount: 1,
    }));
    assert.equal(merged.status, 'accepted');
    assert.equal(merged.continuePolicy, 'continue');
    assert.ok(!merged.riskTags.includes(acc.SEPIA_ADVISORY_REPAIR_TAG));
  } finally {
    delete process.env.SEPIA_ADVISORY_REPAIR;
  }
});

test('有硬伤时 advisory 指令随行，不留「硬伤清零、advisory 原样」', () => {
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report(
    [finding({ checkId: 'L1-1', severity: 'blocking', message: '破折号 3 处' })],
    {
      advisory: [finding({ checkId: 'L1-6', severity: 'advisory', rawItem: 'L1-6 冒号', message: '19 处' })],
      advisoryCount: 1,
    },
  ));
  assert.equal(merged.status, 'repairable');
  assert.ok(!merged.riskTags.includes(acc.SEPIA_ADVISORY_REPAIR_TAG));
  assert.match(merged.repairDirectives.map((d) => d.instruction).join('\n'), /L1-6/);
});

test('advisory-only 的合并结果能真正进入修文通道（不被「没有 blockingIssues」挡掉）', () => {
  const { shouldAttemptAutomaticRepair } = require(path.resolve(__dirname, '..', 'dist', 'services', 'novel', 'runtime', 'repair', 'ChapterRepairEligibility.js'));
  const merged = acc.mergeSepiaIntoAssessment(assessment(), report([], {
    advisory: [finding({ checkId: 'L1-6', severity: 'advisory', rawItem: 'L1-6 冒号', message: '19 处' })],
    advisoryCount: 1,
  }));
  const runtimePackage = {
    meta: {
      acceptanceStatus: merged.status,
      continuePolicy: merged.continuePolicy,
      repairDirectives: merged.repairDirectives,
      riskTags: merged.riskTags,
    },
    audit: { hasBlockingIssues: false },
    timelineCheck: { status: 'passed' },
  };
  assert.equal(shouldAttemptAutomaticRepair(runtimePackage, 'light_repair'), true);

  // 反证：把 advisory 清理关掉时，同一份报告不应再要求修文
  process.env.SEPIA_ADVISORY_REPAIR = 'off';
  try {
    const off = acc.mergeSepiaIntoAssessment(assessment(), report([], {
      advisory: [finding({ checkId: 'L1-6', severity: 'advisory', rawItem: 'L1-6 冒号', message: '19 处' })],
      advisoryCount: 1,
    }));
    assert.equal(shouldAttemptAutomaticRepair({
      meta: { acceptanceStatus: off.status, continuePolicy: off.continuePolicy, repairDirectives: off.repairDirectives, riskTags: off.riskTags },
      audit: { hasBlockingIssues: false },
      timelineCheck: { status: 'passed' },
    }, 'light_repair'), false);
  } finally {
    delete process.env.SEPIA_ADVISORY_REPAIR;
  }
});

test('计数型硬伤要带上正文原句：没定位的模型只能凭记忆写 targetExcerpt，一改就整单作废', () => {
  const content = [
    '沈砚忽然换了副笑脸，语气软下来。',
    '姜雪辞盯着他，半晌没挪开。',
    '窗外雨停了。',
  ].join("\n");
  const r = report([finding({
    checkId: 'L1-2',
    message: '命中 2 处 / 扫描 153 条；忽然 × 1；半晌 × 1',
  })]);
  const directives = acc.toRepairDirectives(r, content);
  assert.equal(directives.length, 1);
  const text = directives[0].instruction;
  assert.match(text, /命中原文/);
  assert.match(text, /沈砚忽然换了副笑脸/);
  assert.match(text, /半晌没挪开/);
  assert.doesNotMatch(text, /窗外雨停了/);

  const issues = acc.toAcceptanceIssues(r, content);
  assert.match(issues[0].evidence, /命中原文/);
  assert.match(issues[0].evidence, /忽然换了副笑脸/);
});

test('引号里的句号不切句：切在引号内会让补丁锚到半句上，改坏对白结构', () => {
  const content = '她说：“会。经脉接触，药力分岔。”然后转身走了。';
  const hits = acc.locateHitSentences(content, { checkId: 'L1-2', message: '命中 1 处；转身 × 1' });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].startsWith('她说：'));
  assert.ok(hits[0].endsWith('然后转身走了。'));
});

test('冒号与相邻同长句也能给到具体句子，而不是只报条数', () => {
  const content = [
    '他低头看了眼筐底。',
    '筐底沾着新鲜的药渣。',
    '紫苏叶和赤灵芝混在一起。',
    '“节点跳动：半格。”',
  ].join("\n");
  const colon = acc.locateHitSentences(content, { checkId: 'L1-6', message: '4 处（尽量 0）' });
  assert.ok(colon.some(s => s.includes('节点跳动：半格')));
  const runs = acc.locateHitSentences(content, { checkId: 'lint:adjacent-length', message: '最长连续 3 句长度接近' });
  assert.ok(runs.length >= 3);
});
