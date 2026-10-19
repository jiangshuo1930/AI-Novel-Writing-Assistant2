/**
 * SepiaGateService：sepia 机械门
 *
 * 职责只有一个——把 `lint.py --json` 的原始 items 转译成 ANA 能直接消费的
 * 三元组（severity × layer × rewritable），不改变任何判定。
 *
 * 三条不能动的纪律（对应方案 §7.3 的 C5 裁决）：
 *   1. 分级只看 finding 本身，**不看它来自人工还是模型**。映射表里没有"来源"这一维。
 *   2. 机械项 `rewritable` 恒为 false。`review: mechanical` 只表示"能靠正则定位"，
 *      不等于"能靠正则改对"（删否定铺垫、用动作呈现，都依赖上下文）。
 *   3. 汇总项 `去味检测器（story-deslop）` 的 level 是"本次有没有硬伤"的聚合，
 *      不是一条独立问题。它必须被排除，否则 blocking 会凭空多 1 条。
 */

import path from 'path';

import type { DeslopScanOptions, DeslopStatus } from '../deslop/deslopRunner';
import { defaultDeslopDir, mergeDeslop } from '../deslop/deslopRunner';
import { lintText } from '../lint/sepiaLint';
import type { SepiaFinding, SepiaLintStats, SepiaPack, SepiaReview } from '../types';

/** deslop 汇总项：不是问题，是统计行 */
const SUMMARY_ITEM = '去味检测器（story-deslop）';

/** 附属行：以 `  ↳ ` 开头的定位/命中明细，归属上一条主项 */
const CHILD_PREFIX = '  ↳ ';

/**
 * lint 项名 → checkId。
 *
 * 只做"命名空间化"：`L1-1` 这类本来就是编号的直接沿用；sepia 里没有编号的
 * 检查项补一个稳定的英文 id，避免把中文名当 key 四处散落。
 * 未登记的项走 `lint:` + 原名，不会静默丢掉。
 */
const CHECK_ID: Record<string, string> = {
  正文: 'lint:body-too-short',
  'L1-1 破折号': 'L1-1',
  'L1-2 禁用词': 'L1-2',
  '道具警惕项（不算硬伤）': 'lint:prop-warning',
  'L1-5 引号': 'L1-5',
  'L1-6 冒号': 'L1-6',
  'L1-9 句式套子': 'L1-9',
  'L1-9 不是X而是Y密度': 'L1-9-density',
  'L1-12 句号密度': 'L1-12',
  段落参差: 'lint:paragraph-rhythm',
  相邻同长句: 'lint:adjacent-length',
  超长句: 'lint:long-sentence',
  对话占比: 'lint:dialogue-ratio',
  'L1-7 开篇比喻（候选）': 'L1-7',
  'L1-8 镜头式开场（候选）': 'L1-8',
  'L1-10 内心总结句（候选）': 'L1-10',
  替代词过载: 'lint:replacement-overload',
};

/** deslop 项的 detail 形如 `第N行·message（type）｜「excerpt」` */
const DESLOP_DETAIL = /^第(\d+)行·([\s\S]*?)（([a-z][a-z0-9-]*)）(?:｜「([\s\S]*?)」)?$/;
/** 有 excerpt 时 detail 以 `」` 结尾，无 excerpt 时以 `）` 结尾 */
const DESLOP_TYPE_TAIL = /（([a-z][a-z0-9-]*)）(?:｜「[\s\S]*」)?$/;

export type SepiaGateSeverity = 'blocking' | 'advisory';
export type SepiaGateLayer = 'surface' | 'discourse' | 'narrative';

export interface SepiaGateFinding {
  /** `L1-1` / `lint:paragraph-rhythm` / `deslop:not-is-comparison` */
  checkId: string;
  severity: SepiaGateSeverity;
  layer: SepiaGateLayer;
  /** sepia 自有项没有这个概念，留 undefined 而不是替它编一个 */
  review?: SepiaReview;
  /** 机械项恒为 false（C5）：定位精确，改法依赖上下文 */
  rewritable: boolean;
  /** 连续原文片段；sepia 项多数不带引文，此时为空串 */
  quote: string;
  /** 行号；只有 deslop 项给得出 */
  line: number | null;
  message: string;
  /** 原样保留 sepia 的 item / detail，报告与 UI 直接可读 */
  rawItem: string;
  rawDetail: string;
}

export interface SepiaGateReport {
  packVersion: string;
  contentHash: string;
  /** ok / unavailable / skipped */
  deslop: DeslopStatus;
  /** false 表示 deslop 没跑成，报告里的 blocking 数只覆盖 lint 部分 */
  deslopOk: boolean;
  stats: SepiaLintStats;
  blocking: SepiaGateFinding[];
  advisory: SepiaGateFinding[];
  blockingCount: number;
  advisoryCount: number;
  /** 与 `lint.py --json` 逐字一致的 items，供对照与排障，不参与分级 */
  raw: SepiaFinding[];
}

/**
 * 单项分级：err → blocking，warn → advisory，其余不进报告。
 *
 * 注意 ok/info 也被显式处理，而不是"默认跳过"——将来 sepia 新增等级时，
 * 这里会漏掉而不是乱猜，属于宁可少报也不虚构。
 */
export function gradeOne(f: SepiaFinding): SepiaGateSeverity | null {
  if (f.level === 'err') return 'blocking';
  if (f.level === 'warn') return 'advisory';
  return null;
}

/** deslop 的 item 形如 `句式与密度·破折号`，type 只在 detail 尾部 */
function deslopTypeOf(detail: string): string | null {
  const m = DESLOP_TYPE_TAIL.exec(detail);
  return m ? m[1] : null;
}

function parseDeslopDetail(detail: string): {
  line: number | null;
  message: string;
  quote: string;
} {
  const m = DESLOP_DETAIL.exec(detail);
  if (!m) return { line: null, message: detail, quote: '' };
  return {
    line: Number.parseInt(m[1], 10),
    message: m[2].trim(),
    quote: m[4] ?? '',
  };
}

/** lint 项的引文：detail 里第一处「…」 */
function lintQuoteOf(detail: string): string {
  const m = /「([^」]*)」/.exec(detail);
  return m ? m[1] : '';
}

export function toGateFinding(f: SepiaFinding): SepiaGateFinding | null {
  const severity = gradeOne(f);
  if (!severity) return null;
  // 汇总项是统计行，不是问题；不过滤会让 blocking 数虚高 1
  if (f.item === SUMMARY_ITEM) return null;
  // 附属行（位置/命中/长句/候选）不独立成条：attachChildLines 已把它并入上一条主项
  if (f.item.startsWith(CHILD_PREFIX)) return null;

  const isDeslop = f.item.includes('·') && !f.item.startsWith('L1-');
  if (isDeslop) {
    const type = deslopTypeOf(f.detail);
    const parsed = parseDeslopDetail(f.detail);
    return {
      checkId: type ? `deslop:${type}` : `deslop:${f.item}`,
      severity,
      layer: 'surface',
      review: f.review,
      rewritable: false,
      quote: parsed.quote,
      line: parsed.line,
      message: parsed.message,
      rawItem: f.item,
      rawDetail: f.detail,
    };
  }

  const head = f.item.replace(/（候选）$/, '');
  return {
    checkId: CHECK_ID[f.item] ?? `lint:${head}`,
    severity,
    layer: 'surface',
    review: f.review,
    rewritable: false,
    quote: lintQuoteOf(f.detail),
    line: null,
    message: f.detail,
    rawItem: f.item,
    rawDetail: f.detail,
  };
}

/**
 * 把 `  ↳ …` 附属行并入上一条主项。
 *
 * lint.py 会给部分主项补一行明细：L1-1 破折号补 `  ↳ 位置`（命中行前 40 字）、
 * L1-2 禁用词补 `  ↳ 命中`（命中词 × 次数）、超长句补 `  ↳ 长句`、L1-10 补 `  ↳ 候选`。
 * 这些行不独立成条，但**信息必须跟着主项走**：丢掉之后 L1-1 只剩「2 处」，
 * 修文拿不到原文锚点，sepia 的「FAIL 必须清零」就落不了地。
 *
 * 只做拼接，不改 level、不改判定。浅拷贝避免污染 `report.raw`。
 */
function attachChildLines(items: SepiaFinding[]): SepiaFinding[] {
  const out: SepiaFinding[] = [];
  for (const f of items) {
    if (!f.item.startsWith(CHILD_PREFIX)) {
      out.push({ ...f });
      continue;
    }
    const parent = out[out.length - 1];
    // 没有主项可挂时丢弃：与 lint.py 里这行只是 info 明细同义
    if (!parent) continue;
    parent.detail = parent.detail ? `${parent.detail}；${f.detail.trim()}` : f.detail.trim();
  }
  return out;
}

export function gradeFindings(items: SepiaFinding[]): {
  blocking: SepiaGateFinding[];
  advisory: SepiaGateFinding[];
} {
  const blocking: SepiaGateFinding[] = [];
  const advisory: SepiaGateFinding[] = [];
  for (const f of attachChildLines(items)) {
    const g = toGateFinding(f);
    if (!g) continue;
    (g.severity === 'blocking' ? blocking : advisory).push(g);
  }
  return { blocking, advisory };
}

export interface SepiaGateRunOptions extends DeslopScanOptions {
  /** 对应 lint.py 的 --no-deslop */
  noDeslop?: boolean;
}

export class SepiaGateService {
  private readonly pack: SepiaPack;

  private readonly options: SepiaGateRunOptions;

  constructor(pack: SepiaPack, options: SepiaGateRunOptions = {}) {
    this.pack = pack;
    this.options = options;
  }

  /**
   * 跑完整门。顺序与 lint.py 相同：先 lint，再 merge deslop。
   * 顺序不能换——mergeDeslop 靠「L1-1 破折号」是否已存在做去重。
   */
  async run(content: string, options: SepiaGateRunOptions = {}): Promise<SepiaGateReport> {
    // 默认路径兜底：漏传 deslopDir 会让 gate 静默返回 "unavailable"，
    // 而报告里看起来只是"没发现问题"——这是最危险的一类失败。
    const opts: SepiaGateRunOptions = {
      deslopDir: defaultDeslopDir(path.join(__dirname, '..', 'pack')),
      ...this.options,
      ...options,
    };
    const { findings, stats } = lintText(content, this.pack);
    const deslop: DeslopStatus = opts.noDeslop
      ? 'skipped'
      : await mergeDeslop(content, findings, opts);
    const { blocking, advisory } = gradeFindings(findings);
    return {
      packVersion: this.pack.meta.packVersion,
      contentHash: this.pack.meta.contentHash,
      deslop,
      deslopOk: deslop === 'ok',
      stats,
      blocking,
      advisory,
      blockingCount: blocking.length,
      advisoryCount: advisory.length,
      raw: findings,
    };
  }
}
