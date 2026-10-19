#!/usr/bin/env node
/**
 * 只编译 sepia 子树（开发/联调期用）
 *
 * 为什么单独一个：仓库可能还没 `pnpm install`，而 dist/ 里已有一份 sepia 的
 * 产物用于 T1/T2 一致性测试。这个脚本只依赖 TypeScript 本身，不需要整个
 * server 的 node_modules。
 *
 * 用法：
 *   node server/scripts/sepia-pack/tsc-sepia.cjs
 *
 * 找 tsc 的顺序：
 *   server/node_modules/typescript → 托管 workspace 的 typescript → 报错
 * 找 @types/node 的顺序：
 *   server/node_modules/@types → 托管 workspace 的 @types → 报错
 * 找不到就失败，不静默跳过——否则 dist 里会留着旧产物，测试变成自欺。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', '..');
const MANAGED = process.env.SEPIA_TOOLCHAIN_ROOT
  || path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function findTsc() {
  const cands = [
    path.join(SERVER, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(MANAGED, 'typescript', 'bin', 'tsc'),
  ];
  return cands.find(exists) || null;
}

function findTypesRoot() {
  const cands = [
    path.join(SERVER, 'node_modules', '@types'),
    path.join(MANAGED, '@types'),
  ];
  return cands.find(exists) || null;
}

const tsc = findTsc();
if (!tsc) {
  console.error('[sepia] 未找到 typescript。先 `pnpm install`，或设置 SEPIA_TOOLCHAIN_ROOT 指向含 typescript 的 node_modules。');
  process.exit(2);
}
const typesRoot = findTypesRoot();
if (!typesRoot) {
  console.error('[sepia] 未找到 @types/node。先 `pnpm install`，或设置 SEPIA_TOOLCHAIN_ROOT。');
  process.exit(2);
}

const args = [
  tsc,
  '-p',
  path.join(SERVER, 'tsconfig.sepia.json'),
  '--typeRoots',
  typesRoot,
];

console.log(`[sepia] tsc: ${tsc}`);
const r = spawnSync(process.execPath, args, { cwd: SERVER, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status === null ? 2 : r.status);

const copy = spawnSync(process.execPath, [path.join(__dirname, 'copy-pack.cjs')], {
  cwd: SERVER,
  stdio: 'inherit',
});
process.exit(copy.status === null ? 2 : copy.status);
