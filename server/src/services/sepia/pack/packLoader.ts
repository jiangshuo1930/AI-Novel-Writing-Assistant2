/**
 * 规则包加载器
 *
 * 加载 + 校验 contentHash。约定（对应合并方案 M5）：
 * 包缺失或哈希不匹配 → **抛错，不降级**。理由：静默降级会让"门"变成"没跑门"，
 * 而报告里看不出区别；sepia 的整个价值是可复现，宁可让链路失败。
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { SepiaPack } from '../types';

/** 与 Python json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":")) 等价 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',');
  return `{${body}}`;
}

export function hashPackData(pack: SepiaPack): string {
  return createHash('sha256').update(canonicalJson(pack.data), 'utf8').digest('hex');
}

export interface LoadSepiaPackOptions {
  /** 校验 contentHash，默认 true */
  verify?: boolean;
}

export function loadSepiaPack(packDir: string, options: LoadSepiaPackOptions = {}): SepiaPack {
  const verify = options.verify !== false;
  const file = path.join(packDir, 'rules.compiled.json');
  if (!fs.existsSync(file)) {
    throw new Error(`[sepia] 规则包缺失：${file}（先跑 server/scripts/sepia-pack/build-pack.py）`);
  }
  const pack = JSON.parse(fs.readFileSync(file, 'utf8')) as SepiaPack;
  if (!pack?.data?.bannedWords || !pack?.data?.sentencePatterns || !pack?.data?.softWords) {
    throw new Error(`[sepia] 规则包结构不完整：${file}`);
  }
  if (verify) {
    const actual = hashPackData(pack);
    if (actual !== pack.meta.contentHash) {
      throw new Error(
        `[sepia] 规则包 contentHash 不匹配：期望 ${pack.meta.contentHash}，实得 ${actual}。` +
          '包被手改过，请重新编译而不是就地编辑 JSON。',
      );
    }
  }
  return pack;
}

/** 默认路径：services/sepia/lint/ 或 services/sepia/ 下都指向 services/sepia/pack */
export function defaultPackDir(fromDir: string): string {
  return path.resolve(fromDir, '..', 'pack');
}
