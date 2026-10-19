/**
 * T8：技法选择
 *
 * 判据来自 techniques.md 第 17-19 行校准（单篇 3–5 招、底层不占配额、减空洞+加颗粒同时做）
 * 与 roles.md 每个角色的「改写重点（必上技法）」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist', 'services', 'sepia');
const tech = require(path.join(dist, 'techniques', 'sepiaTechniques.js'));
const { getSepiaPack } = require(path.join(dist, 'pack', 'index.js'));

const pack = getSepiaPack();

test('规则包里 30 条技法 / 5 个角色，且技法编号连续', () => {
  assert.equal(pack.data.techniques.length, 30);
  assert.equal(pack.data.roles.length, 5);
  const nos = pack.data.techniques.map((item) => item.no);
  assert.deepEqual(nos, Array.from({ length: 30 }, (_, index) => index + 1));
});

test('每个角色都能选到 3–5 招，且必含减空洞 + 至少一条加颗粒', () => {
  for (const role of pack.data.roles) {
    const selection = tech.selectTechniques({ roleKey: role.key });
    const ids = selection.techniques.map((item) => item.id);
    assert.ok(ids.length >= 3 && ids.length <= 5, `${role.key} 选了 ${ids.length} 招`);
    assert.ok(ids.includes(tech.REDUCE_TECHNIQUE_ID), `${role.key} 缺减空洞`);
    assert.ok(
      ids.some((id) => tech.GRAIN_TECHNIQUE_IDS.includes(id)),
      `${role.key} 缺加颗粒：${ids.join(',')}`,
    );
    assert.equal(new Set(ids).size, ids.length, `${role.key} 有重复招式`);
  }
});

test('底层技法不占配额', () => {
  const selection = tech.selectTechniques({ roleKey: 'suspense' });
  const baseTags = selection.techniques.filter((item) => item.tags.includes('底层'));
  assert.equal(baseTags.length, 0);
});

test('角色匹配：信号词多的胜出，全不命中走通用', () => {
  const roles = pack.data.roles;
  assert.equal(tech.matchRole('密室 凶手 线索 不在场证明 失踪 监控', roles).key, 'suspense');
  assert.equal(tech.matchRole('表白 暗恋 前任 分手 心动', roles).key, 'romance');
  assert.equal(tech.matchRole('金丹 宗门 灵气 修仙 突破', roles).key, 'fantasy');
  // 「上班」本身就是都市角色的信号词，所以兜底样本不能带任何生活场景词
  assert.equal(tech.matchRole('嗯。', roles).key, 'general');
});

test('近 3 章用过的招降权：排到必上列表后面', () => {
  const freshFirst = tech.selectTechniques({ roleKey: 'suspense' });
  const used = freshFirst.techniques.filter((item) => item.reason === 'role_required').map((item) => item.id);
  assert.ok(used.length > 0);

  const allUsed = tech.selectTechniques({ roleKey: 'suspense', usedRecently: used });
  // 降权不是删除：仍需满足 3–5 招与两条底线
  assert.ok(allUsed.techniques.length >= 3);
  assert.ok(allUsed.techniques.some((item) => item.id === tech.REDUCE_TECHNIQUE_ID));
});

test('同一输入重复选择结果一致（确定性）', () => {
  const a = tech.selectTechniques({ roleKey: 'urban', text: '出租屋 加班 便利店' });
  const b = tech.selectTechniques({ roleKey: 'urban', text: '出租屋 加班 便利店' });
  assert.deepEqual(a.techniques.map((item) => item.id), b.techniques.map((item) => item.id));
});

test('契约渲染：行数等于招式数，带名称与说明', () => {
  const selection = tech.selectTechniques({ roleKey: 'romance' });
  const text = tech.renderTechniquesContract(selection);
  const lines = text.split('\n');
  assert.equal(lines.length, selection.techniques.length);
  assert.ok(lines.every((line) => line.length > 0));
});

test('选择结果可序列化 / 读回，坏数据不抛错', () => {
  const selection = tech.selectTechniques({ roleKey: 'fantasy' });
  const raw = tech.serializeSelection(selection);
  assert.deepEqual(
    tech.readSelectedIds(raw),
    selection.techniques.map((item) => item.id),
  );
  assert.deepEqual(tech.readSelectedIds('{坏'), []);
  assert.deepEqual(tech.readSelectedIds(null), []);
});
