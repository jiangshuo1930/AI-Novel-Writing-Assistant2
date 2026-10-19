/**
 * T13：sepia 开关归一
 *
 * 锁三件事：
 *   1. 新名 `SEPIA_DISABLED` 生效；
 *   2. 旧名 `SEPIA_GATE_DISABLED` 仍然生效（配置不动就能继续用），且只提示一次；
 *   3. 不缓存成常量——同一进程里先后改 env，两次读取结果要跟着变（测试要靠这个）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist', 'services', 'sepia');
const flags = require(path.join(dist, 'sepiaFlags.js'));

function withEnv(patch, fn) {
  const backup = {};
  for (const key of Object.keys(patch)) backup[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('两个变量都不设时为 false', () => {
  withEnv({ SEPIA_DISABLED: undefined, SEPIA_GATE_DISABLED: undefined }, () => {
    assert.equal(flags.isSepiaDisabled(), false);
  });
});

test('SEPIA_DISABLED=1 生效，且接受 true/on/yes', () => {
  for (const value of ['1', 'true', 'ON', ' yes ']) {
    withEnv({ SEPIA_DISABLED: value, SEPIA_GATE_DISABLED: undefined }, () => {
      assert.equal(flags.isSepiaDisabled(), true, `value=${value}`);
    });
  }
});

test('SEPIA_DISABLED=0 不误开', () => {
  withEnv({ SEPIA_DISABLED: '0', SEPIA_GATE_DISABLED: undefined }, () => {
    assert.equal(flags.isSepiaDisabled(), false);
  });
});

test('旧名 SEPIA_GATE_DISABLED 仍然生效', () => {
  withEnv({ SEPIA_DISABLED: undefined, SEPIA_GATE_DISABLED: '1' }, () => {
    assert.equal(flags.isSepiaDisabled(), true);
  });
});

test('旧名只提示一次（不刷屏）', () => {
  const original = console.warn;
  const messages = [];
  console.warn = (message) => messages.push(String(message));
  try {
    withEnv({ SEPIA_DISABLED: undefined, SEPIA_GATE_DISABLED: '1' }, () => {
      flags.resetSepiaFlagWarningForTest();
      flags.isSepiaDisabled();
      flags.isSepiaDisabled();
      flags.isSepiaDisabled();
    });
  } finally {
    console.warn = original;
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0], /SEPIA_DISABLED/);
});

test('不缓存：同一进程内改 env 立刻反映', () => {
  withEnv({ SEPIA_DISABLED: undefined, SEPIA_GATE_DISABLED: undefined }, () => {
    assert.equal(flags.isSepiaDisabled(), false);
    process.env.SEPIA_DISABLED = '1';
    assert.equal(flags.isSepiaDisabled(), true);
    delete process.env.SEPIA_DISABLED;
    assert.equal(flags.isSepiaDisabled(), false);
  });
});
