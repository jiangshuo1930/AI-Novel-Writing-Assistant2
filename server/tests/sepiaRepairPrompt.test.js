const test = require('node:test');
const assert = require('node:assert/strict');
const { preparePromptExecution } = require('../dist/prompting/core/promptRunner');
const { chapterPatchRepairPrompt } = require('../dist/prompting/prompts/novel/chapterPatchRepair.prompts');

const base = {
  novelTitle: '本书',
  chapterTitle: '第一章',
  chapterContent: '林舟把碗放下。',
  issuesJson: '[]',
};

const render = (promptInput) => preparePromptExecution({ asset: chapterPatchRepairPrompt, promptInput })
  .messages.map((message) => String(message.content)).join('\n');

/**
 * sepia 的机械项是「每处都要清零」，不是「这一类挑一个代表改掉」。
 * 通用补丁上限 4 条，7 处破折号改不完；只有带 [sepia …] 时才放开到 8 条。
 */
test('patch repair keeps the four-patch cap for ordinary issues', () => {
  const text = render(base);
  assert.ok(text.includes('最多输出 4 个最高价值补丁'));
  assert.ok(!text.includes('最多 8 条补丁'));
  assert.ok(!text.includes('删除测试'));
});

test('patch repair asks for every mechanical hit when sepia findings are present', () => {
  const text = render({
    ...base,
    issuesJson: JSON.stringify([
      { fixSuggestion: '[sepia L1-1] 全文：7 处（要求 0）。只做形态修正，禁止新增事实或改变情节。' },
    ]),
  });
  assert.ok(text.includes('最多 8 条补丁'));
  assert.ok(text.includes('报「7 处」就要改掉七处'));
  assert.ok(text.includes('先看架构'));
  assert.ok(text.includes('删除测试'));
  assert.ok(!text.includes('最多输出 4 个最高价值补丁'));
});
