/**
 * 规则包单例入口
 *
 * 惰性加载：不要在服务启动时读包。规则包缺失/被改动应该只影响 sepia 的两个
 * 路由（返回 500 并说明原因），而不是让整个 ANA 起不来。
 *
 * 校验是"失败即抛"（对应方案 M5）：contentHash 不匹配、检测器字节被改动、
 * manifest 缺项，全部直接报错。静默降级会让"门"变成"没跑门"，而报告里
 * 看不出区别——这比报错更危险。
 */

import { assertDetectorBytes, defaultDeslopDir } from '../deslop/deslopRunner';
import { SepiaGateService } from '../gate/SepiaGateService';
import type { SepiaPack } from '../types';
import { defaultPackDir, loadSepiaPack } from './packLoader';

interface Cached {
  dir: string;
  pack: SepiaPack;
  gate: SepiaGateService;
}

let cached: Cached | null = null;

function load(): Cached {
  if (cached) return cached;
  const dir = defaultPackDir(__dirname);
  const pack = loadSepiaPack(dir);
  assertDetectorBytes(dir);
  cached = {
    dir,
    pack,
    gate: new SepiaGateService(pack, { deslopDir: defaultDeslopDir(dir) }),
  };
  return cached;
}

export function getSepiaPack(): SepiaPack {
  return load().pack;
}

export function getSepiaGate(): SepiaGateService {
  return load().gate;
}

/** 测试用：清掉单例，强制下次重新读盘 */
export function resetSepiaPackCache(): void {
  cached = null;
}
