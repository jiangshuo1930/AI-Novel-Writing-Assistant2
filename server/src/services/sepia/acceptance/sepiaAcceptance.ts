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
/**
 * 「这一章只差 advisory」。
 *
 * 打上这个标记意味着：机械门没有硬伤，开这一轮修文只是为了把 advisory 清掉。
 * 它**不能**让章节判成不过——advisory 在 sepia 里本来就不阻塞；流水线必须
 * 用这个标记把「清 advisory 的修文」和「因硬伤而修文」区分开，否则一个冒号
 * 密度就能把 120 章的流水线全卡在 needs_repair。
 */
export const SEPIA_ADVISORY_REPAIR_TAG = 'sepia_advisory_repair_only';
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

/**
 * 计数型 finding 的命中项：`忽然 × 3；猛地 × 2` → [忽然, 猛地]。
 *
 * sepia 的 deslop 只报「命中 8 处」和一份词频表，不给句子。修文模型拿到的
 * 如果是这个，只能在自己脑内全文检索，凭记忆写 `targetExcerpt`——多一个标点
 * 就定位失败，整条补丁作废。第 4 章 8 处禁用词修了两轮原地不动，根因就在这。
 */
function parseHitTerms(message: string): string[] {
  const out: string[] = [];
  const re = /([^\s；;，,、×/]+)\s*×\s*\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const term = (m[1] ?? '').trim();
    if (term && term.length <= 12 && !out.includes(term)) out.push(term);
  }
  return out;
}

/**
 * 按句末标点切句，保留原文顺序；不合并、不改写。
 *
 * 引号内的句号不切：`“会。经脉接触……”` 若在这里断开，切出来的半句
 * 会让修文模型把 targetExcerpt 定位到跨引号的残片上，一改就把对白结构弄坏。
 */
function splitSentences(content: string): string[] {
  const out: string[] = [];
  let buffer = '';
  let quote: string | null = null;
  for (const ch of content) {
    if (quote) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '“' || ch === '「') { quote = ch === '“' ? '”' : '」'; buffer += ch; continue; }
    if (ch === '\n') {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += ch;
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?') {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

function clipSentence(sentence: string, max = 120): string {
  const s = sentence.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 把一条 finding 还原成正文里可以逐字复制的原句。
 *
 * 只做确定性定位：词是 sepia 报出来的，句子是原文切片，不做任何猜测性扩写。
 * 定位不到就返回空，让修文照旧按条数处理——不编造原文。
 */
/**
 * 相邻同长句：找出最长的那段「字数差 ≤3」的连续句群。
 *
 * sepia 只说「最长连续 5 句长度接近」，不说是哪 5 句。没有定位，模型只能
 * 全章猜着打断，改完门照样报同一项。
 */
function locateAdjacentRun(sentences: string[]): string[] {
  const lens = sentences.map(s => s.replace(/\s/g, '').length);
  let best: { start: number; end: number } | null = null;
  let start = 0;
  for (let i = 1; i <= lens.length; i += 1) {
    const continued = i < lens.length && Math.abs(lens[i]! - lens[i - 1]!) <= 3;
    if (continued) continue;
    const run = { start, end: i - 1 };
    if (run.end - run.start + 1 >= 3 && (!best || run.end - run.start > best.end - best.start)) best = run;
    start = i;
  }
  if (!best) return [];
  return sentences.slice(best.start, best.end + 1).map(s => clipSentence(s));
}

export function locateHitSentences(
  content: string,
  finding: Pick<SepiaGateFinding, 'checkId' | 'message'> & { quote?: string },
  limit = 8,
): string[] {
  if (!content.trim()) return [];
  const sentences = splitSentences(content);
  if (sentences.length === 0) return [];

  let terms = parseHitTerms(finding.message);
  if (terms.length === 0 && finding.quote) {
    // 有些 deslop 项把词表放在 quote 里（空格分隔），例如微动作复读的「了下 了一圈 了眼」。
    terms = finding.quote.split(/\s+/).map(t => t.trim()).filter(t => t.length >= 2 && t.length <= 12);
  }
  if (terms.length === 0) {
    if (finding.checkId === 'L1-6') terms = ['：', ':'];
    else if (finding.checkId === 'lint:adjacent-length') {
      return locateAdjacentRun(sentences);
    } else if (finding.checkId === 'lint:long-sentence' || finding.checkId === 'L1-12') {
      // 分布型：没有点名项，给最长的几句作为拆句对象
      return sentences
        .filter(s => s.replace(/“[^”]*”/g, '').length >= (finding.checkId === 'L1-12' ? 42 : 56))
        .sort((a, b) => b.length - a.length)
        .slice(0, 3)
        .map(s => clipSentence(s));
    } else return [];
  }

  const out: string[] = [];
  for (const sentence of sentences) {
    if (out.length >= limit) break;
    if (terms.some(term => sentence.includes(term))) {
      const clipped = clipSentence(sentence);
      if (!out.includes(clipped)) out.push(clipped);
    }
  }
  return out;
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

export function toAcceptanceIssues(report: SepiaGateReport, content = ''): SepiaAcceptanceIssue[] {
  return report.blocking.slice(0, ISSUE_CAP).map((f) => {
    const quote = f.quote.trim();
    const hits = quote ? [] : locateHitSentences(content, f);
    return {
      severity: 'high',
      category: categoryOf(f),
      code: issueCodeOf(f),
      layer: f.layer,
      // 即使点位型也不允许"脚本自动改"：rewritable 的语义是正则改写权限
      canAutoRewrite: false,
      evidence: hits.length ? `${evidenceOf(f)}；命中原文：${hits.join(' / ')}` : evidenceOf(f),
      ...(quote && quote.length <= QUOTE_MAX ? { currentEvidence: quote } : {}),
      fixSuggestion: suggestionOf(f, classifyFixClass(f)),
    };
  });
}

/**
 * 把命中原文拼进指令。
 *
 * 指令是修文模型唯一能看到的缺陷描述（`toAcceptanceDirectiveIssues` 只传 instruction，
 * evidence 到不了模型），所以原句必须写在这里，不能只挂在报告上。
 */
function withPeriod(message: string): string {
  const trimmed = message.trim();
  return /[。！？…]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

function withHits(instruction: string, hits: string[]): string {  if (hits.length === 0) return instruction;
  return `${instruction}\n命中原文（逐句改完，一处不留；targetExcerpt 必须逐字复制下列句子）：\n`
    + hits.map(hit => `- ${hit}`).join('\n');
}

export function toRepairDirectives(report: SepiaGateReport, content = ''): SepiaAcceptanceDirective[] {
  const out: SepiaAcceptanceDirective[] = [];
  // 顺序即优先级，与 sepia 的清单一致：
  //   blocking 全部要进（sepia: FAIL 必须清零）；advisory 里 [可直改] 与 [读上下文] 也进，
  //   只有 sepia 自有 warn（待看）不进——sepia 里它本来就不要求清零。
  for (const f of [...report.blocking, ...report.advisory]) {
    if (out.length >= DIRECTIVE_CAP) break;
    const klass = classifyFixClass(f);
    if (f.severity === 'advisory' && klass === 'distribution') continue;
    const where = f.line != null ? `第${f.line}行` : '全文';
    const hits = klass === 'point' || klass === 'context' ? locateHitSentences(content, f) : [];
    out.push({
      mode: klass === 'distribution' ? 'manual' : 'patch',
      target: PLOT_CHECKS.has(f.checkId)
        ? 'plot'
        : CONTINUITY_CHECKS.has(f.checkId)
          ? 'continuity'
          : 'voice',
      instruction: klass === 'point'
        ? withHits(`[sepia ${f.checkId}] ${where}：${withPeriod(f.message)}只做形态修正，禁止新增事实或改变情节。`, hits)
        : klass === 'context'
          ? withHits(`[sepia ${f.checkId}] ${where}：${withPeriod(f.message)}标为 [读上下文]：先看该处是否承担叙事功能；`
            + `承担则保留原文并在说明里给出依据（可以不产出补丁），不承担才做局部修正。`, hits)
          : `[sepia ${f.checkId}] ${f.rawItem}：${withPeriod(f.message)}全章分布问题，局部替换无效，不要用 patch 处理。`,
    });
  }
  return out;
}

/**
 * advisory 里**能靠局部替换落地**的项。
 *
 * `classifyFixClass` 把 sepia 自有 warn 归为 `distribution`（sepia 原文的「待看」），
 * 因此它们不进 blocking 的修文清单——但「待看」不等于「不管」：
 * 冒号密度、句号密度、超长句、相邻同长句、对话占比、引号强调这六项，命中处都能
 * 落成具体句子的替换（拆句、改标点、去引号），只是要按整章分布调，不能一条一条硬改。
 * 单独列一张表，让 advisory 清理走同一套 patch 通道，而不必先把它们谎报成 blocking。
 */
const ADVISORY_PATCH_CHECKS: ReadonlySet<string> = new Set([
  'L1-6',
  'L1-12',
  'lint:long-sentence',
  'lint:adjacent-length',
  'lint:dialogue-ratio',
  'deslop:quote-emphasis-tic',
]);

/** advisory 一轮最多带进清单的条数：这几项互相牵连，全塞进去模型只会挑好改的做。 */
const ADVISORY_DIRECTIVE_CAP = 4;

/** 逃生阀：排障时可关掉 advisory 自动清理，回到「只清 blocking」。 */
function isAdvisoryRepairEnabled(): boolean {
  const raw = process.env.SEPIA_ADVISORY_REPAIR?.trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

/**
 * advisory 的修法要带上阈值，否则模型只会把句子改短一点点，下一轮门照样报。
 *
 * 「超长句 5 句 >55 字」这种描述对模型没有约束力，必须写成「拆到 55 字以内」。
 */
function advisoryInstruction(f: SepiaGateFinding): string {
  const detail = f.message.trim();
  switch (f.checkId) {
    case 'L1-6':
      return `[sepia ${f.checkId}] ${f.rawItem}：${detail}。把叙述里的冒号改成逗号或句号；`
        + `台词前后的说话标签也用逗号，全章 0 处。`;
    case 'L1-12':
      return `[sepia ${f.checkId}] ${f.rawItem}：${detail}。靠拆句把句号密度抬进 5–8/百字；`
        + `在长句的转折、动作起止处断句，不要在同一个主语里硬切。`;
    case 'lint:long-sentence':
      return `[sepia ${f.checkId}] ${f.rawItem}：${detail}。把每条超 55 字的句子拆成两句，`
        + `优先在并列谓语或「，他/她」处断；拆完总字数不变。`;
    case 'lint:adjacent-length':
      return `[sepia ${f.checkId}] ${f.rawItem}：${detail}。连续三句字数接近时打断：`
        + `要么把其中一句并进上一句，要么在短句里补一个具体动作；不要靠加形容词拉长。`;
    case 'lint:dialogue-ratio':
      return `[sepia ${f.checkId}] ${f.rawItem}：${detail}。在台词之间补叙述动作、环境或身体反应，`
        + `把占比压回 30–50%；不许删台词内容，也不许新增情节。`;
    case 'deslop:quote-emphasis-tic':
      return `[sepia ${f.checkId}] ${f.rawItem}：${detail}。`
        + `叙述里 1-4 字的短词去掉引号直接写；只保留真正反讽或转述的那一两处。`;
    default:
      return `[sepia ${f.checkId}] ${f.rawItem}：${detail}。只做形态修正，禁止新增事实或改变情节。`;
  }
}

/**
 * advisory → 补丁指令。
 *
 * 与 blocking 的 `toRepairDirectives` 分开：那些指令带「必须清零」的语义，
 * 这里只要求「按分布改到位」，改不动可以保留并在说明里给出依据。
 */
export function toAdvisoryDirectives(report: SepiaGateReport, content = ''): SepiaAcceptanceDirective[] {
  const out: SepiaAcceptanceDirective[] = [];
  for (const f of report.advisory) {
    if (out.length >= ADVISORY_DIRECTIVE_CAP) break;
    if (!ADVISORY_PATCH_CHECKS.has(f.checkId)) continue;
    out.push({
      mode: 'patch',
      target: PLOT_CHECKS.has(f.checkId)
        ? 'plot'
        : CONTINUITY_CHECKS.has(f.checkId)
          ? 'continuity'
          : 'voice',
      instruction: withHits(advisoryInstruction(f), locateHitSentences(content, f, 4)),
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
  content = '',
): T {
  const sepiaIssues = toAcceptanceIssues(report, content);
  const sepiaDirectives = toRepairDirectives(report, content);
  /**
   * advisory 的清理清单。
   *
   * sepia 原文里 warn 只是「待看」，它自己的 write 第 7 步只要求 FAIL 清零，
   * 所以这条通道默认不抢跑 blocking。但「不阻塞」不等于「永远不改」：
   * 用户看到报告里挂着 6 条 advisory，下一章仍会一模一样地挂着——因为它们
   * 从来没进过任何一次修文。这里把它们接进同一条 patch 通道，只在
   * blocking 已经清零、且没有别的可落地条目时才独立开一轮。
   */
  const advisoryDirectives = isAdvisoryRepairEnabled() && report.advisoryCount > 0
    ? toAdvisoryDirectives(report, content)
    : [];
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

  // 只有 advisory、没有 blocking 时**不抢在 blocking 前面开修文**：
  // sepia 的 warn 是「待看」，ANA 的修文也只应由验收判定触发。指令照样带出去，
  // 等本章因 blocking 进入修文时随行，这就是 sepia 的 refactor——拿完整缺陷清单
  // 一次改完，而不是为一条 warn 单开一轮。
  //
  // 例外是「这章根本没有 blocking 可改」：此时 advisory 永远不会被任何一轮修文
  // 带上，只能一路挂到完本。这时给它一次 `repair_once` 的机会，改完仍不过就照常
  // 收束，不追加第二轮（continuePolicy 与 blocking 路径同一条）。
  if (!hasSepiaBlocking && sepiaIssues.length === 0) {
    const canRepairAdvisory = advisoryDirectives.length > 0
      && assessment.status !== 'needs_manual_review'
      && assessment.continuePolicy !== 'pause';
    if (!canRepairAdvisory) {
      return {
        ...assessment,
        repairDirectives: dedupeBy([...assessment.repairDirectives, ...sepiaDirectives], directiveKey),
        riskTags,
      };
    }
    return {
      ...assessment,
      status: 'repairable',
      repairability: assessment.repairability === 'plan_misalignment'
        ? assessment.repairability
        : 'patchable_obligation_gap',
      continuePolicy: 'repair_once',
      repairDirectives: dedupeBy(
        [...assessment.repairDirectives, ...sepiaDirectives, ...advisoryDirectives],
        directiveKey,
      ),
      // 只有 advisory 的这一个特例要显式标出来：流水线据此知道「开了修文，
      // 但这章并不算不过」，并在第二轮之后停止重复索取 advisory 清理。
      riskTags: Array.from(new Set([...riskTags, SEPIA_ADVISORY_REPAIR_TAG])),
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
  // 有 blocking 时 advisory 也要随行：同一次修文把完整缺陷清单改完，
  // 不留下「blocking 清零、advisory 原样」的半成品报告。
  const repairDirectives = dedupeBy(
    [...assessment.repairDirectives, ...sepiaDirectives, ...advisoryDirectives],
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
    return { assessment: mergeSepiaIntoAssessment(assessment, report, content), report, degraded: false };
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
