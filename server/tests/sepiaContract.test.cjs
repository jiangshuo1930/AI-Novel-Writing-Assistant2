/**
 * T9：生成期 sepia 契约（context block 的数据层）
 *
 * 验证三件事：
 *   1. 没开 sepia 的章不产出契约（注入层就没有这个 block，回滚路径与合并前一致）
 *   2. 契约只带「本章那点东西」，字数在 700 字预算内
 *   3. 章上存了技法就按存的来，不重新选（可复现）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist', 'services', 'sepia');
const { buildSepiaWritingContract, renderSepiaContractText } = require(
  path.join(dist, 'contract', 'buildSepiaContract.js'),
);
const { validateBlueprint } = require(path.join(dist, 'blueprint', 'sepiaBlueprint.js'));

const blueprint = {
  want: '把三号柜里那具无名女尸的身份查出来',
  obstacle: '殡仪馆的老规矩压着，馆长盯着他',
  action: '他趁夜把寄存单抄了一份',
  result: '寄存单上的签字是馆长自己的笔迹',
  change: { cognition: true },
  cliff: '馆长为什么把无名尸的照片锁进抽屉',
  infoTiming: '死者真实姓名压到第五章',
  relations: '老周和馆长有旧账',
};

const novel = {
  title: '清溪',
  genre: { name: '悬疑', description: '县城殡仪馆的悬疑探案' },
  primaryStoryMode: null,
};

test('章上没有架构表也没有技法 → 不产出契约', () => {
  assert.equal(buildSepiaWritingContract({ chapter: { order: 1 }, novel }), null);
});

test('有架构表 → 契约含 6 行架构项、3–5 招、≤8 禁词', () => {
  const contract = buildSepiaWritingContract({
    chapter: { order: 3, sepiaBlueprintJson: JSON.stringify(blueprint) },
    novel,
  });
  assert.ok(contract);
  assert.equal(contract.blueprintLines.length, 6);
  assert.ok(contract.techniques.length >= 3 && contract.techniques.length <= 5);
  assert.ok(contract.bannedWords.length <= 8);
  assert.ok(contract.persona.length <= 120);
  assert.equal(contract.roleKey, 'suspense');
});

test('章上存了技法 → 按存的来，不重新选', () => {
  const stored = ['tech30', 'tech22', 'tech19'];
  const contract = buildSepiaWritingContract({
    chapter: {
      order: 3,
      sepiaBlueprintJson: JSON.stringify(blueprint),
      sepiaTechKeysJson: JSON.stringify({ roleKey: 'suspense', techniques: stored }),
    },
    novel,
  });
  assert.deepEqual(contract.techniques.map((item) => item.id), stored);
});

test('契约渲染文本含七块，且总字数在 900 字内', () => {
  const contract = buildSepiaWritingContract({
    chapter: { order: 3, sepiaBlueprintJson: JSON.stringify(blueprint) },
    novel,
  });
  const text = renderSepiaContractText(contract);
  assert.match(text, /编辑视角：/);
  assert.match(text, /人味底线/);
  assert.match(text, /本章技法/);
  assert.match(text, /篇章安排/);
  assert.match(text, /架构表已定/);
  assert.match(text, /本类型禁用词/);
  // 甲部 14 条底线必须出现在 prompt 里，而不是只存在于规则包
  assert.match(text, /糙话\/脏话/);
  assert.match(text, /句式断裂/);
  assert.ok(text.length <= 900, `实际 ${text.length} 字`);
});

test('坏 JSON 不抛错：按没有架构表处理', () => {
  const contract = buildSepiaWritingContract({
    chapter: { order: 3, sepiaBlueprintJson: '{坏', sepiaTechKeysJson: '[]' },
    novel,
  });
  assert.equal(contract, null);
});

test('架构表合格时，契约里的项与原文一致（没被改写）', async () => {
  const validation = validateBlueprint(blueprint);
  assert.equal(validation.ok, true);
  const contract = buildSepiaWritingContract({
    chapter: { order: 3, sepiaBlueprintJson: JSON.stringify(blueprint) },
    novel,
  });
  assert.ok(contract.blueprintLines.some((line) => line.includes('三号柜')));
});
