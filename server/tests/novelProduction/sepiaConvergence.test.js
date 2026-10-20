const test = require('node:test');
const assert = require('node:assert/strict');
const { createPipelineHarness } = require('./sourceHarness.cjs');

/**
 * sepia 原版的 write 第 7 步 / refactor 第 3 步都是「跑 lint，把 FAIL 清零」——是循环。
 * 这里锁住三条：能收敛、不空转、不越预算。
 */
const meta = (blocking) => ({
  acceptanceStatus: blocking > 0 ? 'repairable' : 'accepted',
  continuePolicy: blocking > 0 ? 'repair_once' : 'continue',
  riskTags: blocking > 0 ? [`sepia_blocking:${blocking}`] : [],
});

test('sepia mechanical findings keep repairing until the gate is clean', async () => {
  const h = createPipelineHarness({
    scores: [78, 78, 82],
    acceptanceMeta: [meta(3), meta(2), meta(0)],
    repairContents: ['candidate one', 'candidate two'],
  });

  const result = await h.run({ autoRepair: true, maxRetries: 1 });

  assert.equal(h.events.filter((event) => event === 'acceptance').length, 3);
  assert.equal(h.events.filter((event) => event === 'repair').length, 2);
  assert.deepEqual(h.committedContents, ['candidate two']);
  assert.equal(result.pass, true);
});

test('sepia convergence stops when a repair no longer reduces the blocking count', async () => {
  const h = createPipelineHarness({
    scores: [78, 78],
    acceptanceMeta: [meta(3), meta(3)],
    repairContents: ['candidate one'],
  });

  const result = await h.run({ autoRepair: true, maxRetries: 1 });

  assert.equal(h.events.filter((event) => event === 'repair').length, 1);
  assert.equal(result.repairSelection.reasonCode, 'original_retained_no_clear_improvement');
  assert.deepEqual(h.committedContents, ['original draft']);
});

test('the convergence budget is capped even when every round improves', async () => {
  const h = createPipelineHarness({
    scores: [78, 78, 78, 78],
    acceptanceMeta: [meta(5), meta(4), meta(3), meta(2)],
    repairContents: ['candidate one', 'candidate two', 'candidate three'],
  });

  await h.run({ autoRepair: true, maxRetries: 1 });

  // attemptLimit = 3 → 最多三次修文，不会无限追下去
  assert.equal(h.events.filter((event) => event === 'repair').length, 3);
});

test('non-sepia failures still spend a single repair even with the wider attempt limit', async () => {
  const h = createPipelineHarness({ scores: [70, 70, 70] });

  await h.run({ autoRepair: true, maxRetries: 1 });

  assert.equal(h.events.filter((event) => event === 'repair').length, 1);
  assert.equal(h.events.filter((event) => event === 'acceptance').length, 2);
});

test('mechanical rounds are labelled so the outer chapter budget can let them through', async () => {
  const claims = [];
  const h = createPipelineHarness({
    scores: [78, 78, 82],
    acceptanceMeta: [meta(3), meta(2), meta(0)],
    repairContents: ['candidate one', 'candidate two'],
  });

  await h.run({ autoRepair: true, maxRetries: 1 }, {
    onRetryConsumed: async (_kind, details) => {
      claims.push(Boolean(details && details.mechanicalOnly));
      return true;
    },
  });

  assert.deepEqual(claims, [true, true]);
});

/**
 * 结构自检是第二级门：机械项清零之后才轮到它，它的未过项同样要修到清零。
 * 两条分开计数——合成一个数字会在回滚时分不清"句子改坏了"还是"结构改坏了"。
 */
const selfCheckMeta = (failed) => ({
  acceptanceStatus: failed > 0 ? 'repairable' : 'accepted',
  continuePolicy: failed > 0 ? 'repair_once' : 'continue',
  riskTags: failed > 0 ? [`sepia_selfcheck:fail:${failed}`] : ['sepia_selfcheck:pass'],
});

test('structural self-check failures keep repairing after the mechanical gate is clean', async () => {
  const h = createPipelineHarness({
    scores: [78, 78, 82],
    acceptanceMeta: [selfCheckMeta(2), selfCheckMeta(1), selfCheckMeta(0)],
    repairContents: ['candidate one', 'candidate two'],
  });

  const result = await h.run({ autoRepair: true, maxRetries: 1 });

  assert.equal(h.events.filter((event) => event === 'acceptance').length, 3);
  assert.equal(h.events.filter((event) => event === 'repair').length, 2);
  assert.equal(result.pass, true);
  assert.deepEqual(h.committedContents, ['candidate two']);
});

test('a repair that adds self-check failures is rolled back even with the same score', async () => {
  const h = createPipelineHarness({
    scores: [78, 78],
    acceptanceMeta: [selfCheckMeta(1), selfCheckMeta(2)],
    repairContents: ['candidate one'],
  });

  const result = await h.run({ autoRepair: true, maxRetries: 1 });

  assert.equal(result.repairSelection.reasonCode, 'original_retained_sepia_regression');
  assert.equal(result.repairSelection.rollbackReason, 'sepia_regression');
  assert.deepEqual(h.committedContents, ['original draft']);
});

test('self-check rounds also claim the sepia-only budget instead of the normal retry budget', async () => {
  const claims = [];
  const h = createPipelineHarness({
    scores: [78, 82],
    acceptanceMeta: [selfCheckMeta(1), selfCheckMeta(0)],
    repairContents: ['candidate one'],
  });

  await h.run({ autoRepair: true, maxRetries: 1 }, {
    onRetryConsumed: async (_kind, details) => {
      claims.push(Boolean(details && details.mechanicalOnly));
      return true;
    },
  });

  assert.deepEqual(claims, [true]);
});
