/**
 * T13：规则包导入的冲突判定
 *
 * 只测纯函数 diffAntiAiSeeds。核心是四条：新增 / 一致 / 升级覆盖 / 本地改过不覆盖。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist', 'services', 'sepia');
const { diffAntiAiSeeds } = require(path.join(dist, 'pack', 'sepiaPackImport.js'));

const PACK = 'sepia-webnovel';
const VERSION = '0.5.1';

function seed(over = {}) {
  return {
    key: 'sepia.lexicon.group-1',
    name: '一组',
    type: 'forbidden',
    severity: 'high',
    description: '描述',
    detectPatterns: ['仿佛'],
    promptInstruction: '命中即换',
    autoRewrite: false,
    enabled: true,
    globalBaselineEnabled: false,
    ...over,
  };
}

function row(over = {}) {
  return {
    key: 'sepia.lexicon.group-1',
    name: '一组',
    type: 'forbidden',
    severity: 'high',
    description: '描述',
    detectPatternsJson: JSON.stringify(['仿佛']),
    promptInstruction: '命中即换',
    packKey: PACK,
    packVersion: VERSION,
    ...over,
  };
}

test('库里没有 → added', () => {
  assert.equal(diffAntiAiSeeds([seed()], [], VERSION)[0].action, 'added');
});

test('内容与版本一致 → unchanged', () => {
  assert.equal(diffAntiAiSeeds([seed()], [row()], VERSION)[0].action, 'unchanged');
});

test('版本旧、内容不同 → updated（正常升级）', () => {
  const old = row({ packVersion: '0.5.0', description: '旧描述' });
  assert.equal(diffAntiAiSeeds([seed()], [old], VERSION)[0].action, 'updated');
});

test('同版本但内容被改过 → local_modified，不覆盖', () => {
  const edited = row({ description: '作者自己改过' });
  const item = diffAntiAiSeeds([seed()], [edited], VERSION)[0];
  assert.equal(item.action, 'local_modified');
  assert.match(item.note, /不覆盖/);
});

test('同名 key 被非包规则占用 → foreign_key，不覆盖', () => {
  const foreign = row({ packKey: null, packVersion: null });
  assert.equal(diffAntiAiSeeds([seed()], [foreign], VERSION)[0].action, 'foreign_key');
});

test('包内 15 条种子结构与规则字段齐全', () => {
  const { getSepiaPack } = require(path.join(dist, 'pack', 'index.js'));
  const pack = getSepiaPack();
  assert.equal(pack.data.antiAiRuleSeeds.length, 15);
  for (const item of pack.data.antiAiRuleSeeds) {
    assert.match(item.key, /^sepia\.(lexicon|pattern)\./);
    assert.ok(item.detectPatterns.length > 0, `${item.key} 没有检测样本`);
    assert.ok(item.promptInstruction.length > 0);
    assert.equal(item.autoRewrite, false, '包规则禁止自动改写');
  }
});
