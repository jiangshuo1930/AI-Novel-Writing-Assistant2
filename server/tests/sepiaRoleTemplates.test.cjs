/**
 * T12：sepia 角色模板
 *
 * 验证 5 个角色模板都在、绑定的 AntiAiRule key 都真实存在（否则种子会静默绑不上），
 * 且内容与 roles.md 的必上技法一致（防止手抄漂移）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist');
const { DEFAULT_STYLE_TEMPLATES, DEFAULT_ANTI_AI_RULES } = require(
  path.join(dist, 'services', 'styleEngine', 'defaults.js'),
);

const roleKeys = ['suspense', 'romance', 'fantasy', 'urban', 'general'];
const sepiaTemplates = DEFAULT_STYLE_TEMPLATES.filter((item) => item.key.startsWith('sepia-role-'));

test('5 个 sepia 角色模板齐全', () => {
  assert.equal(sepiaTemplates.length, 5);
  assert.deepEqual(
    sepiaTemplates.map((item) => item.key).sort(),
    roleKeys.map((key) => `sepia-role-${key}`).sort(),
  );
});

test('模板绑定的 AntiAiRule key 都存在', () => {
  const known = new Set(DEFAULT_ANTI_AI_RULES.map((rule) => rule.key));
  for (const template of sepiaTemplates) {
    for (const key of template.defaultAntiAiRuleKeys) {
      assert.ok(known.has(key), `${template.key} 绑了不存在的规则 ${key}`);
    }
  }
});

test('模板里写明了来源版本，便于追溯', () => {
  for (const template of sepiaTemplates) {
    assert.match(template.analysisMarkdown, /sepia-webnovel v0\.5\.1/);
  }
});

test('悬疑模板的必上技法与 roles.md 对齐（抽查 3 条）', () => {
  const suspense = sepiaTemplates.find((item) => item.key === 'sepia-role-suspense');
  assert.match(suspense.analysisMarkdown, /第22招 主角必须犯错/);
  assert.match(suspense.analysisMarkdown, /第19招 干扰项注入/);
  assert.match(suspense.analysisMarkdown, /第24招 信息碎玻璃化/);
});

test('原有 8 个模板没被改动', () => {
  const builtin = DEFAULT_STYLE_TEMPLATES.filter((item) => !item.key.startsWith('sepia-role-'));
  assert.equal(builtin.length, 8);
  assert.ok(builtin.some((item) => item.key === 'bottom-loop-reality'));
  assert.ok(builtin.some((item) => item.key === 'absurd-dark-humor'));
});
