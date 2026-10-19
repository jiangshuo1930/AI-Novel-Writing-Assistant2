/**
 * T10：生成前门的决策规则
 *
 * 只测纯决策函数。取数（读 novel/chapter）不在这里测，
 * 那条路径需要 DB，放到路由冒烟与端到端里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist', 'services', 'sepia');
const gate = require(path.join(dist, 'blueprint', 'sepiaBlueprintGate.js'));

function decide(over = {}) {
  return gate.decideBlueprintGate({
    mode: 'write',
    runtimeMode: 'single',
    blueprintMissing: false,
    blockedCount: 0,
    warningCount: 0,
    gaps: [],
    ...over,
  });
}

test('架构表合格 → 不拦', () => {
  assert.equal(decide().blocked, false);
});

test('write 模式 + 单章 → 拦', () => {
  assert.equal(decide({ blockedCount: 2 }).blocked, true);
});

test('write 模式 + 批量导演 → 降级不拦', () => {
  const result = decide({ blockedCount: 2, runtimeMode: 'autopilot' });
  assert.equal(result.blocked, false);
  assert.match(result.reason, /降级/);
});

test('all 模式 + 批量导演 → 仍然拦', () => {
  assert.equal(decide({ blockedCount: 1, mode: 'all', runtimeMode: 'autopilot' }).blocked, true);
});

test('off 模式 → 只记录不拦', () => {
  const result = decide({ blockedCount: 3, mode: 'off' });
  assert.equal(result.blocked, false);
  assert.match(result.reason, /只记录/);
});

test('没填架构表 → 不拦（存量书不能被卡死）', () => {
  const result = decide({ blueprintMissing: true, blockedCount: 0 });
  assert.equal(result.blocked, false);
  assert.match(result.reason, /未填架构表/);
});

test('断言入口：拦下时抛的错带全部 gaps，且错误名可被问题治理识别', async () => {
  const error = new gate.BlueprintGateBlockedError('架构表 2 项不合格：x；y', [
    { field: 'want', level: 'blocked', reason: 'x', quote: '' },
    { field: 'result', level: 'blocked', reason: 'y', quote: '' },
  ]);
  assert.equal(error.name, 'BlueprintGateBlockedError');
  assert.equal(error.gaps.length, 2);
});
