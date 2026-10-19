/**
 * T5：修文后 sepia 复跑回滚
 *
 * 只测择优层新增的那条判定：sepia 机械项条数增加时保留原稿。
 * 其余择优规则（新增严重问题、义务缺口、未验证复验）保持原样，用对照用例确保没被带偏。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(
  __dirname, '..', 'dist', 'services', 'novel', 'runtime', 'selection', 'ChapterRepairCandidateSelection.js',
);
const { selectChapterRepairCandidate, readSepiaBlockingCount } = require(dist);

function pkg({ sepia = 0, legacyTag = false, severe = [], medium = 0, missing = [], blocking = false, score = 80 } = {}) {
  const tags = sepia > 0 ? [`sepia_blocking:${sepia}`] : [];
  if (legacyTag) tags.push('sepia_blocking');
  return {
    meta: { riskTags: tags },
    audit: {
      score: { overall: score },
      openIssues: [
        ...severe.map((code) => ({ id: code, code, severity: 'high' })),
        ...Array.from({ length: medium }, (_, i) => ({ id: `m${i}`, code: `m${i}`, severity: 'medium' })),
      ],
      hasBlockingIssues: blocking,
    },
    obligationCoverage: { missing },
    replanRecommendation: { blockingIssueIds: [] },
  };
}

function evalOf(content, runtimePackage, pass = false) {
  return { content, pass, runtimePackage };
}

test('读取真实条数：带数字标签 / 旧格式 / 无标签', () => {
  assert.equal(readSepiaBlockingCount(pkg({ sepia: 9 })), 9);
  assert.equal(readSepiaBlockingCount(pkg({ sepia: 0, legacyTag: true })), 1);
  assert.equal(readSepiaBlockingCount(pkg({ sepia: 0 })), 0);
  assert.equal(readSepiaBlockingCount({ meta: {} }), 0);
});

test('sepia 由 1 增至 3 → 回滚原稿，rollbackReason=sepia_regression', () => {
  const r = selectChapterRepairCandidate({
    original: evalOf('原始正文', pkg({ sepia: 1, medium: 4 })),
    // candidate 结构化问题更少，本来会被 candidate_improved 选中
    candidate: evalOf('修文正文', pkg({ sepia: 3, medium: 1 })),
  });
  assert.equal(r.selected, 'original');
  assert.equal(r.reasonCode, 'original_retained_sepia_regression');
  assert.equal(r.rollbackReason, 'sepia_regression');
  assert.match(r.reason, /1 条增至 3 条/);
});

test('sepia 条数持平 → 不触发回滚，仍按原有规则择优', () => {
  const r = selectChapterRepairCandidate({
    original: evalOf('原始正文', pkg({ sepia: 2, medium: 4 })),
    candidate: evalOf('修文正文', pkg({ sepia: 2, medium: 1 })),
  });
  assert.equal(r.selected, 'candidate');
  assert.equal(r.reasonCode, 'candidate_improved');
  assert.equal(r.rollbackReason, undefined);
});

test('sepia 减少 → 正常采纳候选', () => {
  const r = selectChapterRepairCandidate({
    original: evalOf('原始正文', pkg({ sepia: 3 }), false),
    candidate: evalOf('修文正文', pkg({ sepia: 0 }), true),
  });
  assert.equal(r.selected, 'candidate');
  assert.equal(r.reasonCode, 'candidate_passed');
  assert.equal(r.rollbackReason, undefined);
});

test('候选"通过"了 LLM 验收但 sepia 变差 → 仍然回滚（判定顺序在前）', () => {
  const r = selectChapterRepairCandidate({
    original: evalOf('原始正文', pkg({ sepia: 1 }), false),
    candidate: evalOf('修文正文', pkg({ sepia: 4 }), true),
  });
  assert.equal(r.selected, 'original');
  assert.equal(r.reasonCode, 'original_retained_sepia_regression');
});

test('对照：新增高严重度问题仍走原分支，不被 sepia 判定抢走', () => {
  const r = selectChapterRepairCandidate({
    original: evalOf('原始正文', pkg({ sepia: 1 })),
    candidate: evalOf('修文正文', pkg({ sepia: 3, severe: ['NEW_CRITICAL'] })),
  });
  assert.equal(r.selected, 'original');
  // 新严重问题在 sepia 判定之前短路
  assert.equal(r.reasonCode, 'original_retained_new_severe_issue');
});

test('对照：无 sepia 标签的老数据行为不变', () => {
  const r = selectChapterRepairCandidate({
    original: evalOf('原始正文', pkg({ medium: 2 })),
    candidate: evalOf('修文正文', pkg({ medium: 0 })),
  });
  assert.equal(r.selected, 'candidate');
  assert.equal(r.reasonCode, 'candidate_improved');
  assert.equal(r.rollbackReason, undefined);
});
