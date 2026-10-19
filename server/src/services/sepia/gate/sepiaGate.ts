/**
 * sepia 机械门（对应 `python scripts/lint.py <file> --json`）
 *
 * 输出形状与 lint.py 的 JSON 一一对应，唯一区别是字段名：
 *   lint.py            { stats, items, deslop }
 *   runSepiaGate  { stats, findings, deslop }
 *
 * 顺序也与 lint.py 相同：先跑完 14 项自有检查（含 <100 字早退分支），
 * 再把 deslop 结果并入。这个顺序不能换——merge_deslop 依赖
 * "L1-1 破折号" 是否已经存在于 items 里来做去重。
 */

import type { DeslopScanOptions, DeslopStatus } from '../deslop/deslopRunner';
import { mergeDeslop } from '../deslop/deslopRunner';
import { lintText } from '../lint/sepiaLint';
import type { SepiaFinding, SepiaLintStats, SepiaPack } from '../types';

export interface SepiaGateResult {
  stats: SepiaLintStats;
  findings: SepiaFinding[];
  /** ok / unavailable / skipped（对应 lint.py 的 deslop 字段） */
  deslop: DeslopStatus;
}

export interface SepiaGateOptions extends DeslopScanOptions {
  /** 对应 lint.py 的 --no-deslop */
  noDeslop?: boolean;
}

export async function runSepiaGate(
  text: string,
  pack: SepiaPack,
  options: SepiaGateOptions = {},
): Promise<SepiaGateResult> {
  const { findings, stats } = lintText(text, pack);
  if (options.noDeslop) return { stats, findings, deslop: 'skipped' };
  const deslop = await mergeDeslop(text, findings, options);
  return { stats, findings, deslop };
}
