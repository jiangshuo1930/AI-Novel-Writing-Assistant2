/**
 * T7：架构表 8 项校验
 *
 * 判据来自 sepia narrative-pass.md 第 9-21 行的合格线。
 * 这里只验证机械近似没有误伤「明明填对了」的项，也没有放过「明显是空话」的项。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist', 'services', 'sepia');
const bp = require(path.join(dist, 'blueprint', 'sepiaBlueprint.js'));

const good = {
  want: '把三号柜里那具无名女尸的身份查出来',
  obstacle: '殡仪馆的老规矩压着：无名尸不许留档，馆长盯着他',
  action: '他趁夜把寄存单抄了一份，塞进鞋垫底下',
  result: '寄存单上的签字是馆长自己的笔迹',
  change: { cognition: true },
  cliff: '馆长为什么要把一具无名尸的照片锁进自己抽屉',
  infoTiming: '死者的真实姓名压到第五章',
  relations: '老周和馆长有旧账，两人见面从不说话',
};

test('合格样本：8 项全填、无 gap', () => {
  const result = bp.validateBlueprint(good);
  assert.equal(result.ok, true);
  assert.equal(result.gaps.length, 0);
});

test('全空：6 项 blocked + 2 项 warning', () => {
  const result = bp.validateBlueprint({});
  assert.equal(result.ok, false);
  assert.equal(result.blockedCount, 6);
  assert.equal(result.warningCount, 2);
  assert.deepEqual(
    result.gaps.map((item) => item.field),
    ['want', 'obstacle', 'action', 'result', 'change', 'cliff', 'infoTiming', 'relations'],
  );
});

test('想要什么：空话被拦，具体目标放行', () => {
  const blocked = bp.validateBlueprint({ ...good, want: '变强' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.gaps[0].field, 'want');

  const alsoBlocked = bp.validateBlueprint({ ...good, want: '活下去，并且成长' });
  assert.equal(alsoBlocked.ok, false);
});

test('阻碍：只有「很难」算空话，出现规矩就放行', () => {
  const vague = bp.validateBlueprint({ ...good, obstacle: '这件事很难' });
  assert.equal(vague.ok, false);
  assert.equal(vague.gaps[0].field, 'obstacle');

  const concrete = bp.validateBlueprint({ ...good, obstacle: '这件事很难，因为馆长立了规矩不让查' });
  assert.equal(concrete.ok, true);
});

test('做了什么：只有心理活动被拦', () => {
  const mental = bp.validateBlueprint({ ...good, action: '想了想' });
  assert.equal(mental.ok, false);
  assert.equal(mental.gaps[0].field, 'action');

  const visible = bp.validateBlueprint({ ...good, action: '他把寄存单抄了一份' });
  assert.equal(visible.ok, true);
});

test('结果：与上一章相同 = 原地踏步', () => {
  const same = bp.validateBlueprint(
    { ...good, result: '什么都没变。' },
    { previousResult: '什么都没变' },
  );
  assert.equal(same.ok, false);
  assert.equal(same.gaps[0].field, 'result');

  const moved = bp.validateBlueprint(
    { ...good, result: '他拿到了寄存单' },
    { previousResult: '他还在找寄存单' },
  );
  assert.equal(moved.ok, true);
});

test('实质变化：四项全 false 被拦', () => {
  const result = bp.validateBlueprint({ ...good, change: {} });
  assert.equal(result.ok, false);
  assert.equal(result.gaps[0].field, 'change');
});

test('章末悬着：写成「未来会怎样」被拦', () => {
  const result = bp.validateBlueprint({ ...good, cliff: '未来会怎样，谁也不知道' });
  assert.equal(result.ok, false);
  assert.equal(result.gaps[0].field, 'cliff');
});

test('信息时间点与关系旧账：只出 warning，不阻断', () => {
  const result = bp.validateBlueprint({ ...good, infoTiming: '', relations: '大家对他都很友好' });
  assert.equal(result.ok, true);
  assert.equal(result.blockedCount, 0);
  assert.equal(result.warningCount, 2);
  assert.deepEqual(result.gaps.map((item) => item.field), ['infoTiming', 'relations']);
});

test('坏 JSON 不抛错，按没有架构表处理', () => {
  assert.equal(bp.parseBlueprint('{坏'), null);
  assert.equal(bp.parseBlueprint(null), null);
  const parsed = bp.parseBlueprint(JSON.stringify(good));
  assert.equal(parsed.want, good.want);
});

test('契约渲染只出 6 行，且带变化项', () => {
  const text = bp.renderBlueprintContract(good);
  const lines = text.split('\n');
  assert.equal(lines.length, 6);
  assert.match(text, /实质变化：认知/);
});
