/**
 * T11：卷级诊断
 *
 * 判据来自 arc-pass.md：连续三章同标签要改、全二星/连炸四星/钟摆不合格。
 * 只测纯函数；diagnoseVolume 的取库部分留给路由冒烟。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist', 'services', 'sepia');
const vol = require(path.join(dist, 'volume', 'volumeDiagnostics.js'));

test('钩子分类：六类各命中一例，命中不了记 unknown', () => {
  assert.equal(vol.classifyHook('井沿上蹲着个人。'), '危');
  assert.equal(vol.classifyHook('他数了三遍，都是二十三，可明明给了二十五。'), '疑');
  assert.equal(vol.classifyHook('她叫了他一声哥。'), '变');
  assert.equal(vol.classifyHook('天亮之前，把人找出来。'), '求');
  assert.equal(vol.classifyHook('他推开门，愣住了。'), '断');
  assert.equal(vol.classifyHook('灯灭了。可窗户上的影子还在。'), '静');
  assert.equal(vol.classifyHook(''), 'unknown');
  assert.equal(vol.classifyHook('他喝了口水。'), 'unknown');
});

function chapter(order, hookType) {
  return { order, title: `第${order}章`, hook: '', hookType, conflictLevel: null, intensity: null };
}

test('连续三章同标签 → 报 repeatedHook', () => {
  const repeated = vol.findRepeatedHook([chapter(1, '危'), chapter(2, '危'), chapter(3, '危')]);
  assert.ok(repeated);
  assert.equal(repeated.type, '危');
  assert.equal(repeated.run, 3);
  assert.equal(repeated.startOrder, 1);
  assert.equal(repeated.endOrder, 3);

  assert.equal(vol.findRepeatedHook([chapter(1, '危'), chapter(2, '疑'), chapter(3, '危')]), null);
});

test('unknown 不参与重复计数', () => {
  assert.equal(vol.findRepeatedHook([chapter(1, 'unknown'), chapter(2, 'unknown'), chapter(3, 'unknown')]), null);
});

test('全二星 / 连炸四章 / 钟摆 → 各报一条', () => {
  assert.ok(vol.findIntensityIssues([2, 2, 2, 2]).some((item) => item.includes('全是二星')));
  assert.ok(vol.findIntensityIssues([3, 3, 3, 3]).some((item) => item.includes('连炸')));
  assert.ok(vol.findIntensityIssues([1, 3, 1, 3, 1, 3]).some((item) => item.includes('钟摆')));
  assert.deepEqual(vol.findIntensityIssues([1, 2, 3, 1, 3]), []);
});
