#!/usr/bin/env node
/**
 * 路由冒烟：只挂 sepia 路由，不起整个 server（不需要 DB / LLM / 环境变量）
 *
 * 验证的是"这条路能不能真的走通"——类型通过不代表运行时没坑：
 *   - 规则包在 dist 里能不能被找到（copy-pack 少一个文件就 500）
 *   - deslop 子进程在 HTTP 请求线程里能不能跑起来
 *   - 参数校验是不是真的返回 400 而不是 500
 *
 * 用法：
 *   node server/scripts/sepia-pack/smoke-routes.cjs
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const SERVER = path.resolve(__dirname, '..', '..');
const DIST = path.join(SERVER, 'dist');
const FIXTURE = path.join(SERVER, 'tests', 'fixtures', 'sepia', 'lint', 's18_real_chapter.md');

const router = require(path.join(DIST, 'routes', 'sepia.js')).default;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/sepia', router);

const failures = [];
let pass = 0;

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    failures.push(`${name}：${detail}`);
  }
}

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/sepia`;
  const content = fs.readFileSync(FIXTURE, 'utf8');

  const get = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json() };
  };
  const post = async (p, body) => {
    const r = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  try {
    const packs = await get('/packs');
    check('GET /packs 状态', packs.status === 200, `实得 ${packs.status} ${JSON.stringify(packs.body)}`);
    check('GET /packs success', packs.body.success === true, JSON.stringify(packs.body));
    check(
      'GET /packs 计数',
      packs.body.data?.counts?.bannedWords > 100,
      JSON.stringify(packs.body.data?.counts),
    );
    check(
      'GET /packs 版本',
      typeof packs.body.data?.packVersion === 'string' && packs.body.data.packVersion.length > 0,
      String(packs.body.data?.packVersion),
    );

    const lint = await post('/lint', { content });
    check('POST /lint 状态', lint.status === 200, `实得 ${lint.status} ${JSON.stringify(lint.body).slice(0, 200)}`);
    check('POST /lint 跳过 deslop', lint.body.data?.deslop === 'skipped', String(lint.body.data?.deslop));
    check(
      'POST /lint 有 stats',
      typeof lint.body.data?.stats?.chars === 'number' && lint.body.data.stats.chars > 0,
      JSON.stringify(lint.body.data?.stats),
    );

    const gate = await post('/gate', { content });
    check('POST /gate 状态', gate.status === 200, `实得 ${gate.status} ${JSON.stringify(gate.body).slice(0, 200)}`);
    check('POST /gate deslop 跑通', gate.body.data?.deslop === 'ok', String(gate.body.data?.deslop));
    check(
      'POST /gate 分级计数自洽',
      gate.body.data?.blockingCount === gate.body.data?.blocking?.length
        && gate.body.data?.advisoryCount === gate.body.data?.advisory?.length,
      JSON.stringify({
        b: gate.body.data?.blockingCount,
        bl: gate.body.data?.blocking?.length,
        a: gate.body.data?.advisoryCount,
        al: gate.body.data?.advisory?.length,
      }),
    );
    check(
      'POST /gate 机械项不可改写',
      (gate.body.data?.blocking ?? []).every((f) => f.rewritable === false)
        && (gate.body.data?.advisory ?? []).every((f) => f.rewritable === false),
      '存在 rewritable=true 的机械项',
    );

    const empty = await post('/lint', { content: '   ' });
    check('空 content → 400', empty.status === 400, `实得 ${empty.status}`);
    check('空 content 有错误信息', typeof empty.body.error === 'string', JSON.stringify(empty.body));

    const badType = await post('/lint', { content: 42 });
    check('content 非字符串 → 400', badType.status === 400, `实得 ${badType.status}`);

    const tooLong = await post('/lint', { content: '啊'.repeat(200_001) });
    check('超长 content → 400', tooLong.status === 400, `实得 ${tooLong.status}`);
  } catch (err) {
    failures.push(`请求异常：${String((err && err.message) || err)}`);
  } finally {
    server.close();
  }

  for (const f of failures) console.log(`✗ ${f}`);
  console.log(`\n路由冒烟：${pass}/${pass + failures.length} 通过`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
