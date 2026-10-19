/**
 * sepia findings → ANA 验收 / 修文的转译层（对应方案 §7.4）
 *
 * ## 分流的依据只有 sepia 自己给的那三条线
 *
 * `SKILL.md` 里已经写死了处置方式，转译层照抄即可，不另立判据：
 *
 *   | sepia 原文 | 依据字段 | 本层归类 |
 *   |---|---|---|
 *   | blocking「FAIL（必须清零）」「就地改写，规则全部带护栏，不需要判断」 | `level == err` | point → patch |
 *   | advisory +「[可直改] 形态即问题，就地改」 | `review == mechanical` | point → patch |
 *   | advisory +「[读上下文] 可能承担叙事功能，读上下文再定」 | `review == semantic` | distribution → manual |
 *   | sepia 自有 warn（不带 review），如段落参差、同长句、对话占比 | `level == warn` | 待看，不进改写清单 |
 *
 * 唯一豁免是 `lint:body-too-short`（正文不足 100 字 = 输入格式错，改无可改）。
 *
 * ## 两条曾经写错的地方，留档免得再犯
 *
 * 1. **「脚本只报告，永不自动改写」约束的是脚本，不是修文流程。**
 *    这句话在 `SKILL.md`「一条纪律」里，主语是 `lint.py`——所以标点归一默认
 *    `--check`，要真改必须显式 `--fix`。把它读成「findings 不能进 AI 修文」，
 *    就等于把 sepia 的四操作砍成三操作。
 *    保留的只有 `rewritable: false`：不许**正则自动改**。
 * 2. **判据不能靠手写白名单。** 早先按「哪类问题好改」列了 8 项白名单，
 *    sepia 的 7 类 blocking 句式一个都没进去，于是 `not-is-comparison`、
 *    `em-dash` 这些「必须清零」的硬伤被静默降级成「只报告」。
 *    现在改成读 `level` / `review` 字段：sepia 新增检查项时自动跟随，
 *    不会再漏。
 */

import type { SepiaGateFinding, SepiaGateReport } from '../gate/SepiaGateService';
import { isSepiaDisabled } from '../sepiaFlags';

export type SepiaAcceptanceSeverity = 'low' | 'medium' | 'high' | 'critical';

export type SepiaAcceptanceCategory =
  | 'continuity'
  | 'character'
  | 'plot'
  | 'mode_fit'
  | 'voice';

/**
 * `point` = 有唯一锚点、直接改；`context` = 照常进 patch，但要先读上下文判断；
 * `distribution` = 待看，不进改写清单。
 */
export type SepiaFixClass = 'point' | 'context' | 'distribution';

/** 结构上与 ANA 的 AcceptanceIssue 一致；不强绑类型，避免 sepia 子树依赖 prompting 层 */
export interface SepiaAcceptanceIssue {
  severity: SepiaAcceptanceSeverity;
  category: SepiaAcceptanceCategory;
  code: string;
  layer?: 'surface' | 'discourse' | 'narrative';
  canAutoRewrite?: boolean;
  evidence: string;
  currentEvidence?: string;
  fixSuggestion: string;
}

export interface SepiaAcceptanceDirective {
  mode: 'patch' | 'rewrite' | 'manual';
  target: 'continuity' | 'character' | 'plot' | 'ending' | 'voice';
  instruction: string;
}

/** 只描述要改的字段，避免 import ANA 的验收类型（会把 prompting 层拖进 sepia 子树） */
export interface SepiaAssessmentShape {
  status: 'accepted' | 'repairable' | 'needs_manual_review' | 'continue_with_risk';
  blockingIssues: SepiaAcceptanceIssue[];
  repairDirectives: SepiaAcceptanceDirective[];
  repairability: 'none' | 'patchable_obligation_gap' | 'rewrite_needed' | 'plan_misalignment';
  continuePolicy: 'continue' | 'repair_once' | 'pause';
  riskTags: string[];
}

/**
 * 唯一不许 patch 的 blocking 项：正文不足 100 字。
 *
 * sepia 对它的处置是「检查文件格式（正文需用空行分段）」——这是输入错，不是文风错，
 * 改无可改。列成显式豁免，而不是让它悄悄落进「只报告」里。
 */
const PATCH_EXEMPT: ReadonlySet<string> = new Set(['lint:body-too-short']);

/** 对话占比是情节配比，不是句子形态 */
const PLOT_CHECKS: ReadonlySet<string> = new Set(['lint:dialogue-ratio']);

/** 复读类命中「同一内容说了两遍」，归连续性 */
const CONTINUITY_CHECKS: ReadonlySet<string> = new Set(['deslop:verbatim-repeat']);

/** 单章最多带进验收的 sepia blocking 条数（ANA 自身对 blockingIssues 也设了 5 条上限） */
const ISSUE_CAP = 5;
/**
 * 最多转成 directive 的条数，与 `ISSUE_CAP` 取同一个数。
 *
 * 二者的关系必须是一对一：报告里能看到几条硬伤，修文清单里就得有几条对应指令。
 * 若 directive 上限更低，会出现「报告说 5 条、修文只收到 2 条」，
 * 修完仍不过门，却看不出是没修到——sepia 的「FAIL 必须清零」在这里断掉。
 */
const DIRECTIVE_CAP = 5;
/** currentEvidence 在 ANA schema 里有 350 字上限 */
const QUOTE_MAX = 350;

export const SEPIA_BLOCKING_TAG = 'sepia_blocking';
export const SEPIA_ADVISORY_TAG = 'sepia_advisory';
export const SEPIA_UNAVAILABLE_TAG = 'sepia_gate_unavailable';

/**
 * 计数标签：`sepia_blocking:9`。
 *
 * 不带数字的写法无法区分「5 条」和「9 条」——`blockingIssues` 本身被封顶到 5 条，
 * 修文后回滚判定要靠真实条数才看得出变差。解析方见
 * `ChapterRepairCandidateSelection.readSepiaBlockingCount`。
 */
function countTag(prefix: string, n: number): string {
  return `${prefix}:${n}`;
}

/**
 * 修法归类 —— 直接照抄 sepia 的分流，不另立判据。
 *
 * sepia 只给了三条线（`SKILL.md` 的「等级映射」与 `write` 第 7 步）：
 *
 *   | sepia 原文 | 依据字段 | 归类 |
 *   |---|---|---|
 *   | blocking「FAIL（必须清零）」「就地改写，规则全部带护栏，不需要判断」 | `level == err` | point |
 *   | advisory + 「[可直改] 形态即问题，就地改」 | `review == mechanical` | point |
 *   | advisory + 「[读上下文] 可能承担叙事功能，读上下文再定」 | `review == semantic` | context |
 *
 * `context` 与 `distribution` 的区别是**能不能进自动修文通道**，不是「改不改」：
 * `[读上下文]` 的意思是读了再定，定了仍可能要改，所以它照常进 patch，
 * 只是指令要求先判断该处是否承担叙事功能。patch 通道本身允许「读了不改」——
 * `chapterPatchRepair.prompts.ts` 第 12/14 条写明「无必要改动时返回空 patches」，
 * 流水线遇到正文未变会直接结束并保留原稿，不重跑验收。
 *
 * sepia 自有的 warn 项（段落参差、相邻同长句、对话占比、各类密度）不带 `review`，
 * 在 sepia 里是「待看」——不阻塞，也不进改写清单，因此归 distribution。
 *
 * 注意 `point` 只表示「能落成局部替换」，不表示「脚本可以自动改」：
 * `rewritable` 恒为 false。
 */
export function classifyFixClass(
  f: Pick<SepiaGateFinding, 'checkId' | 'severity' | 'review'>,
): SepiaFixClass {
  if (PATCH_EXEMPT.has(f.checkId)) return 'distribution';
  if (f.severity === 'blocking') return 'point';
  if (f.review === 'mechanical') return 'point';
  if (f.review === 'semantic') return 'context';
  return 'distribution';
}

function categoryOf(f: SepiaGateFinding): SepiaAcceptanceCategory {
  if (PLOT_CHECKS.has(f.checkId)) return 'plot';
  if (CONTINUITY_CHECKS.has(f.checkId)) return 'continuity';
  return 'voice';
}

/** code 必须稳定可去重：checkId 里的 `:` 换成 `_`，保留大小写以便与 sepia 报告对照 */
export function issueCodeOf(f: SepiaGateFinding): string {
  return `SEPIA_${f.checkId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** 定位信息统一压进 evidence：ANA 的 AcceptanceIssue 没有 line 字段 */
function evidenceOf(f: SepiaGateFinding): string {
  const where = f.line != null ? `第${f.line}行 ` : '';
  return `[sepia ${f.checkId}] ${where}${f.message}`.trim();
}

function suggestionOf(f: SepiaGateFinding, klass: SepiaFixClass): string {
  const where = f.line != null ? `第${f.line}行` : '全文';
  if (klass === 'point') {
    return `按 sepia 报告修正${where}的形态问题；只改标点、用词与断句，不得新增事实、不得改变人物与因果。`;
  }
  if (klass === 'context') {
    return `sepia 标为 [读上下文]（${f.rawItem}）：该处可能承担叙事功能，先读上下文再定；确认不承担才改，保留原文时写明依据。`;
  }
  return `sepia 判定为全章分布问题（${f.rawItem}）：不能靠局部替换解决，需按整章节奏改写，或由作者处理。`;
}

export function toAcceptanceIssues(report: SepiaGateReport): SepiaAcceptanceIssue[] {
  return report.blocking.slice(0, ISSUE_CAP).map((f) => {
    const quote = f.quote.trim();
    return {
      severity: 'high',
      category: categoryOf(f),
      code: issueCodeOf(f),
      layer: f.layer,
      // 即使点位型也不允许"脚本自动改"：rewritable 的语义是正则改写权限
      canAutoRewrite: false,
      evidence: evidenceOf(f),
      ...(quote && quote.length <= QUOTE_MAX ? { currentEvidence: quote } : {}),
      fixSuggestion: suggestionOf(f, classifyFixClass(f)),
    };
  });
}

export function toRepairDirectives(report: SepiaGateReport): SepiaAcceptanceDirective[] {
  const out: SepiaAcceptanceDirective[] = [];
  // 顺序即优先级，与 sepia 的清单一致：
  //   blocking 全部要进（sepia: FAIL 必须清零）；advisory 里 [可直改] 与 [读上下文] 也进，
  //   只有 sepia 自有 warn（待看）不进——sepia 里它本来就不要求清零。
  for (const f of [...report.blocking, ...report.advisory]) {
    if (out.length >= DIRECTIVE_CAP) break;
    const klass = classifyFixClass(f);
    if (f.severity === 'advisory' && klass === 'distribution') continue;
    const where = f.line != null ? `第${f.line}行` : '全文';
    out.push({
      mode: klass === 'distribution' ? 'manual' : 'patch',
      target: PLOT_CHECKS.has(f.checkId)
        ? 'plot'
        : CONTINUITY_CHECKS.has(f.checkId)
          ? 'continuity'
          : 'voice',
      instruction: klass === 'point'
        ? `[sepia ${f.checkId}] ${where}：${f.message}。只做形态修正，禁止新增事实或改变情节。`
        : klass === 'context'
          ? `[sepia ${f.checkId}] ${where}：${f.message}。标为 [读上下文]：先看该处是否承担叙事功能；`
            + `承担则保留原文并在说明里给出依据（可以不产出补丁），不承担才做局部修正。`
          : `[sepia ${f.checkId}] ${f.rawItem}：${f.message}。全章分布问题，局部替换无效，不要用 patch 处理。`,
    });
  }
  return out;
}

/**
 * 该报告是否**全部**是「待看」项（决定 repairability）。
 *
 * `context`（[读上下文]）不算——它照常进 patch 通道，只是要求先判断再改；
 * 只有全都是 sepia 自有 warn 或 `body-too-short` 时，才落到 `rewrite_needed`。
 */
export function isDistributionOnly(report: SepiaGateReport): boolean {
  return report.blocking.length > 0
    && report.blocking.every((f) => classifyFixClass(f) === 'distribution');
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 把 sepia 的 blocking 合进验收结果。
 *
 * 三条不可协商的顺序：
 *   1. `needs_manual_review` 不被降级——sepia 没有权利把人工复核改回可自动修。
 *   2. 已有的 LLM blockingIssues 排在前面，sepia 追加在后，总数封顶。
 *   3. `continuePolicy` 用 `repair_once`：最多一次修文，之后仍不过就落 needs_repair，
 *      不存在"修文—复检—再修文"的循环。
 */
export function mergeSepiaIntoAssessment<T extends SepiaAssessmentShape>(
  assessment: T,
  report: SepiaGateReport,
): T {
  const sepiaIssues = toAcceptanceIssues(report);
  const sepiaDirectives = toRepairDirectives(report);
  const deslopDegraded = !report.deslopOk && report.deslop !== 'skipped';
  const riskTags = Array.from(new Set([
    ...assessment.riskTags,
    ...(report.blockingCount > 0 ? [countTag(SEPIA_BLOCKING_TAG, report.blockingCount)] : []),
    ...(report.advisoryCount > 0 ? [countTag(SEPIA_ADVISORY_TAG, report.advisoryCount)] : []),
    ...(deslopDegraded ? ['sepia_deslop_unavailable'] : []),
  ]));

  const directiveKey = (d: SepiaAcceptanceDirective): string =>
    `${d.mode}|${d.target}|${d.instruction}`;

  // 「这章过没过」以**报告里的 blocking 计数**为准，不能只数 `blockingIssues`：
  // 那个数组按 ISSUE_CAP 截断，去重后还可能更少。只数数组会出现两种错判——
  // 9 条硬伤被读成 5 条（少算），以及硬伤全都落在豁免/去重里被读成 0 条（错放行）。
  // 所以放行条件写成一个显式的合取项：sepiaBlocking === 0 且没有可落地的条目。
  const sepiaBlockingCount = report.blockingCount;
  const hasSepiaBlocking = sepiaBlockingCount > 0;

  // 只有 advisory、没有 blocking 时**不主动开修文**：
  // sepia 的 warn 是「待看」，它自己的 write 第 7 步只要求 FAIL 清零；ANA 的修文
  // 也只应由验收判定触发。指令照样带出去，等本章因 blocking 进入修文时随行，
  // 这就是 sepia 的 refactor——拿完整缺陷清单一次改完，而不是为一条 warn 单开一轮。
  if (!hasSepiaBlocking && sepiaIssues.length === 0) {
    return {
      ...assessment,
      repairDirectives: dedupeBy([...assessment.repairDirectives, ...sepiaDirectives], directiveKey),
      riskTags,
    };
  }

  const status = assessment.status === 'needs_manual_review'
    ? 'needs_manual_review'
    : 'repairable';
  const repairability = isDistributionOnly(report)
    ? 'rewrite_needed'
    : 'patchable_obligation_gap';

  // 幂等：缓存里取回的评估可能已经合过一次，重复追加会让指令翻倍。
  // 去重键带 evidence（含行号与命中内容）——同一 checkId 的**不同命中**必须保留，
  // 否则「4 段复读」会被压成 1 条，修文只能看到一半。
  const blockingIssues = dedupeBy(
    [...assessment.blockingIssues, ...sepiaIssues],
    (issue) => `${issue.code}|${issue.evidence}`,
  );
  const repairDirectives = dedupeBy(
    [...assessment.repairDirectives, ...sepiaDirectives],
    directiveKey,
  );

  return {
    ...assessment,
    status,
    repairability: assessment.repairability === 'plan_misalignment' ? assessment.repairability : repairability,
    continuePolicy: status === 'needs_manual_review' ? 'pause' : 'repair_once',
    blockingIssues,
    repairDirectives,
    riskTags,
  };
}

/** 测试与降级路径用：只要 `run(content)` 这一件事 */
export interface SepiaGatePort {
  run(content: string): Promise<SepiaGateReport>;
}

export interface ApplySepiaGateDeps {
  gate?: SepiaGatePort;
  /** 关掉 sepia 门的逃生阀（排障用），默认读环境变量 */
  disabled?: boolean;
}

/**
 * 验收后接一道 sepia 机械门。
 *
 * 降级纪律：sepia 的任何故障都不能让验收失败或章节存不下来。规则包缺失、
 * 检测器挂掉、超出超时——一律返回原 assessment，并打 `sepia_gate_unavailable`
 * 标记，让报告里看得见"这章没跑机械门"，而不是伪装成"没发现问题"。
 */
export async function applySepiaGate<T extends SepiaAssessmentShape>(
  assessment: T,
  content: string,
  deps: ApplySepiaGateDeps = {},
): Promise<{ assessment: T; report: SepiaGateReport | null; degraded: boolean }> {
  const disabled = deps.disabled ?? isSepiaDisabled();
  if (disabled) {
    return { assessment, report: null, degraded: false };
  }
  try {
    const gate = deps.gate ?? (await import('../pack')).getSepiaGate();
    const report = await gate.run(content);
    return { assessment: mergeSepiaIntoAssessment(assessment, report), report, degraded: false };
  } catch (error) {
    console.warn('[sepia] 机械门不可用，本章按"未跑门"处理', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      assessment: {
        ...assessment,
        riskTags: Array.from(new Set([...assessment.riskTags, SEPIA_UNAVAILABLE_TAG])),
      },
      report: null,
      degraded: true,
    };
  }
}
