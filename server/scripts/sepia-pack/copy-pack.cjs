#!/usr/bin/env node
/**
 * 构建后把规则包搬进 dist
 *
 * tsc 只处理 .ts，pack/ 下的 JSON 与 vendor 的 deslop JS 不会自动进 dist。
 * 运行时（dist/services/sepia/...）必须能读到：
 *   - rules.compiled.json / manifest.json
 *   - source/scripts/deslop/*.js（Node 子进程调用，字节不变）
 */

const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', '..');
const SRC = path.join(SERVER, 'src', 'services', 'sepia', 'pack');
const DST = path.join(SERVER, 'dist', 'services', 'sepia', 'pack');

const FILES = ['rules.compiled.json', 'manifest.json'];
const DIRS = [path.join('source', 'scripts', 'deslop')];

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

if (!fs.existsSync(SRC)) {
  console.log('[sepia] 未找到 pack 源目录，跳过');
  process.exit(0);
}

let n = 0;
for (const f of FILES) {
  const from = path.join(SRC, f);
  if (!fs.existsSync(from)) continue;
  copyFile(from, path.join(DST, f));
  n += 1;
}
for (const d of DIRS) {
  const from = path.join(SRC, d);
  if (!fs.existsSync(from)) continue;
  for (const name of fs.readdirSync(from)) {
    if (!name.endsWith('.js')) continue;
    copyFile(path.join(from, name), path.join(DST, d, name));
    n += 1;
  }
}
console.log(`[sepia] 规则包已同步到 dist：${n} 个文件`);
