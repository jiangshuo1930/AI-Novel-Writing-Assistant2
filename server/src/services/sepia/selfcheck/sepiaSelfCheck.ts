/**
 * sepia 结构自检的判定层（纯函数，不调 LLM、不碰数据库）
 *
 * 对应原版 `SKILL.md` 的两段：
 *   - write 第 8 步「查结构」：跑体检表（rubric.md），**诊断**用；
 *   - refactor 第 4 步 / 交付前：跑自检清单（selfcheck.md），**门槛**用。
 *
 * 两张表不能混成一张门槛，否则「每章都要过」会被 29 项诊断表撑成不可能：
 *
 *   | 表 | 判定 | 后果 |
 *   |---|---|---|
 *   | 体检表 5 组 29 项 | fail / over_corrected | advisory：进报告与风险标签，不阻断 |
 *   | 自检清单 L2 / L3-1 / L3-2 / L4 | fail | blocking：本章不许继续 |
 *
 * 「哪些 L 项必须过」不是这里发明的，来自 `selfcheck.md` 的通过标准原文：
 * **L2 取最高档通过、L3-1/L3-2 必须过、L4 整体像真人写的**。
 * 所以 L2 全组、L3 的前两项、L4 全组是门槛，L3-3 / L3-4 不是。
 */

import { createHash } from "node:crypto";
import type {
  SepiaSelfCheckGroupResult,
  SepiaSelfCheckItemResult,
  SepiaStructuralSelfCheckRecord,
} from "@ai-novel/shared/types/sepia";
import type { SepiaPack } from "../types";

export const SEPIA_SELFCHECK_PASS_TAG = "sepia_selfcheck:pass";
export const SEPIA_SELFCHECK_FAIL_PREFIX = "sepia_selfcheck:fail";
export const SEPIA_SELFCHECK_ADVISORY_PREFIX = "sepia_selfcheck_advisory";
export const SEPIA_SELFCHECK_UNAVAILABLE_TAG = "sepia_selfcheck_unavailable";

/**
 * 必须过的 L 项（selfcheck.md 的通过标准）。
 *
 * 用前缀匹配而不是全等：包里的写法是 `L3-1 细节支撑`，后缀随文档修订而变，
 * 但编号是稳定标识。
 */
const BLOCKING_LEVEL_ITEMS: ReadonlyArray<{ level: string; prefix: string; groupWide: boolean }> = [
  { level: "L2", prefix: "L2-", groupWide: true },
  { level: "L3", prefix: "L3-1", groupWide: false },
  { level: "L3", prefix: "L3-2", groupWide: false },
  { level: "L4", prefix: "L4-", groupWide: true },
];

/** 自检 blocking 项最多转成几条修文指令：结构项一条就够改一轮，多了修文模型会挑着做 */
const DIRECTIVE_CAP = 3;
/** 转成 blockingIssues 的条数，与 ANA 验收层的 5 条上限对齐 */
const ISSUE_CAP = 5;
const EVIDENCE_MAX = 60;

/** 模型漏判超过这个比例，就当它没照表做，结论记为 unavailable */
const MISSING_RATIO_LIMIT = 0.34;

export function isBlockingLevelItem(levelKey: string, item: string): boolean {
  // 先取出编号再比：`startsWith("L3-1")` 会把 `L3-12` 也算成门槛项，
  // 而 sepia 的编号只有一位数的分项。
  const matched = item.trim().match(/^L\d+-\d+/);
  const id = matched ? matched[0] : item.trim();
  return BLOCKING_LEVEL_ITEMS.some((rule) => {
    if (rule.level !== levelKey) return false;
    // L2 / L4 是整组必须过，L3 只点名两项
    return rule.groupWide ? id.startsWith(rule.prefix) : id === rule.prefix;
  });
}

export function hashSelfCheckContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeVerdict(raw: string | undefined): SepiaSelfCheckItemResult["verdict"] {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "fail" || value === "over_corrected") return value as SepiaSelfCheckItemResult["verdict"];
  if (value === "na") return "na";
  return "pass";
}

function clip(value: string | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stripMarkdown(value: string): string {
  return value.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

/**
 * 自检清单的原始条目是 `**L2-1 开头**：是否从具体、当下事件切入？…`。
 *
 * 拆成编号 + 正文：编号是稳定标识（模型只回编号，判定与合并都不怕标题被改写），
 * 正文原样保留（改法不能由我们总结）。
 */
export function parseLevelItems(rawItems: string[]): Array<{ id: string; text: string }> {
  return rawItems.map((raw) => {
    const clean = stripMarkdown(raw);
    const matched = clean.match(/^(L\d-\d+)\s*([^：:]*)[：:]?\s*([\s\S]*)$/);
    if (!matched) return { id: clean, text: clean };
    const [, id, title, body] = matched;
    const name = title.trim();
    const rest = body.trim();
    return { id, text: `${name}${rest ? `：${rest}` : ""}` };
  });
}

/**
 * 把模型输出对齐到包里的项。
 *
 * 对不齐的情况分两种，处置不同：
 *   - 模型自创的项 → 直接丢（不能让它用新名字提新问题）；
 *   - 包里有的项模型没判 → 记 `na` 并计入缺失，缺失过多时整份结论降级为 unavailable。
 *
 * 判 pass 的项强制清空证据：模型常给"没问题"也附一句原文，留着会被当成问题引用。
 */
function alignGroup(
  groupKey: string,
  title: string,
  expectedItems: string[],
  produced: Array<{ item?: string; verdict?: string; evidence?: string; fix?: string }> | undefined,
): { group: SepiaSelfCheckGroupResult; missing: number } {
  const byItem = new Map<string, { verdict?: string; evidence?: string; fix?: string }>();
  for (const entry of produced ?? []) {
    const name = stripMarkdown(entry.item ?? "");
    if (!name) continue;
    byItem.set(name, entry);
  }
  let missing = 0;
  const items: SepiaSelfCheckItemResult[] = expectedItems.map((rawName) => {
    const name = stripMarkdown(rawName);
    const hit = byItem.get(name);
    if (!hit) {
      missing += 1;
      return { item: name, verdict: "na", evidence: "", fix: "" };
    }
    const verdict = normalizeVerdict(hit.verdict);
    const judged = verdict === "fail" || verdict === "over_corrected";
    return {
      item: name,
      verdict,
      evidence: judged ? clip(hit.evidence, EVIDENCE_MAX) : "",
      fix: judged ? clip(hit.fix, 40) : "",
    };
  });
  const verdict = items.some((item) => item.verdict === "fail" || item.verdict === "over_corrected")
    ? "fail"
    : "pass";
  return { group: { key: groupKey, title, verdict, items }, missing };
}

export interface RawSelfCheckOutput {
  diagnosis?: Array<{ key?: string; items?: Array<{ item?: string; verdict?: string; evidence?: string; fix?: string }> }>;
  levels?: Array<{ key?: string; items?: Array<{ item?: string; verdict?: string; evidence?: string; fix?: string }> }>;
  summary?: string;
}

export interface BuildSelfCheckRecordInput {
  raw: RawSelfCheckOutput;
  pack: SepiaPack;
  content: string;
  model?: string;
  now?: Date;
}

/** 模型输出 + 规则包 → 落库/合并用的结论对象 */
export function buildSelfCheckRecord(input: BuildSelfCheckRecordInput): SepiaStructuralSelfCheckRecord {
  const { pack, raw } = input;
  const now = input.now ?? new Date();
  const rubricGroups = pack.data.diagnosis?.groups ?? [];
  const levelGroups = (pack.data.selfCheck?.levels ?? []).filter((level) => level.key !== "L1");

  const diagnosisGroups: SepiaSelfCheckGroupResult[] = [];
  const levelResults: SepiaSelfCheckGroupResult[] = [];
  let expected = 0;
  let missing = 0;

  for (const group of rubricGroups) {
    const produced = raw.diagnosis?.find((item) => item.key?.trim() === group.key);
    const aligned = alignGroup(
      group.key,
      stripMarkdown(group.title),
      group.items.map((item) => item.item),
      produced?.items,
    );
    expected += group.items.length;
    missing += aligned.missing;
    diagnosisGroups.push(aligned.group);
  }
  for (const level of levelGroups) {
    const produced = raw.levels?.find((item) => item.key?.trim() === level.key);
    const levelItemIds = parseLevelItems(level.items).map((item) => item.id);
    const aligned = alignGroup(level.key, stripMarkdown(level.title), levelItemIds, produced?.items);
    expected += levelItemIds.length;
    missing += aligned.missing;
    levelResults.push(aligned.group);
  }

  const unavailable = expected === 0 || missing / Math.max(expected, 1) > MISSING_RATIO_LIMIT;
  const blocking: SepiaSelfCheckItemResult[] = [];
  const advisory: SepiaSelfCheckItemResult[] = [];

  for (const group of levelResults) {
    for (const item of group.items) {
      if (item.verdict !== "fail") continue;
      if (isBlockingLevelItem(group.key, item.item)) blocking.push(item);
      else advisory.push(item);
    }
  }
  for (const group of diagnosisGroups) {
    for (const item of group.items) {
      if (item.verdict === "fail" || item.verdict === "over_corrected") advisory.push(item);
    }
  }

  /**
   * 落库只存摘要，所以摘要必须自带"哪几项没过"：
   * 编辑器与告警都只能看到这一段文本，光给一句"整体偏干"等于没说。
   */
  const modelSummary = (raw.summary ?? "").trim();
  const failing = (blocking.length > 0 ? blocking : advisory).slice(0, 3).map((item) => item.item);
  const summary = unavailable
    ? (modelSummary || "结构自检未按表完成，结论记为不可用。")
    : blocking.length > 0
      ? `${modelSummary ? `${modelSummary}；` : ""}自检有 ${blocking.length} 项未过：${failing.join("、")}。`
      : modelSummary || "自检通过。";

  return {
    schemaVersion: 1,
    verdict: unavailable ? "unavailable" : blocking.length > 0 ? "fail" : "pass",
    diagnosis: {
      groups: diagnosisGroups,
      failed: diagnosisGroups.reduce(
        (sum, group) => sum + group.items.filter((item) => item.verdict === "fail").length,
        0,
      ),
      overCorrected: diagnosisGroups.reduce(
        (sum, group) => sum + group.items.filter((item) => item.verdict === "over_corrected").length,
        0,
      ),
    },
    levels: {
      groups: levelResults,
      failed: levelResults.reduce(
        (sum, group) => sum + group.items.filter((item) => item.verdict === "fail").length,
        0,
      ),
    },
    blocking,
    advisory,
    summary,
    packVersion: pack.meta.packVersion,
    model: input.model ?? "",
    contentHash: hashSelfCheckContent(input.content),
    checkedAt: now.toISOString(),
  };
}

/** 结论标签：与机械门的 `sepia_blocking:N` 分开命名，两套计数不能互相冒充 */
export function selfCheckRiskTags(record: SepiaStructuralSelfCheckRecord): string[] {
  if (record.verdict === "unavailable") return [SEPIA_SELFCHECK_UNAVAILABLE_TAG];
  if (record.verdict === "fail") {
    return [
      `${SEPIA_SELFCHECK_FAIL_PREFIX}:${record.blocking.length}`,
      ...(record.advisory.length > 0 ? [`${SEPIA_SELFCHECK_ADVISORY_PREFIX}:${record.advisory.length}`] : []),
    ];
  }
  return [
    SEPIA_SELFCHECK_PASS_TAG,
    ...(record.advisory.length > 0 ? [`${SEPIA_SELFCHECK_ADVISORY_PREFIX}:${record.advisory.length}`] : []),
  ];
}

/** 从 riskTags 读自检未过项数；缺失/不可用都按 0 计（是否放行由调用方另行判断） */
export function readSelfCheckBlockingCount(tags: string[] | undefined): number {
  let count = 0;
  for (const tag of tags ?? []) {
    if (!tag.startsWith(`${SEPIA_SELFCHECK_FAIL_PREFIX}:`)) continue;
    const parsed = Number.parseInt(tag.slice(SEPIA_SELFCHECK_FAIL_PREFIX.length + 1), 10);
    if (Number.isFinite(parsed)) count = Math.max(count, parsed);
  }
  return count;
}

export function hasSelfCheckUnavailableTag(tags: string[] | undefined): boolean {
  return (tags ?? []).includes(SEPIA_SELFCHECK_UNAVAILABLE_TAG);
}

/** 结构项归到哪一类修文目标：结构/节奏走 plot，人物动机走 character，其余当表达 */
function targetOf(item: SepiaSelfCheckItemResult): "plot" | "character" | "voice" {
  if (/^L3-3/.test(item.item)) return "character";
  if (/^L2-2|^L4-4|^L3-4/.test(item.item)) return "plot";
  return "voice";
}

function issueCategoryOf(item: SepiaSelfCheckItemResult): "plot" | "character" | "voice" {
  return targetOf(item);
}

export function issueCodeOf(item: SepiaSelfCheckItemResult): string {
  return `SEPIA_SELFCHECK_${item.item.replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, "_").replace(/^_|_$/g, "")}`;
}

/**
 * 与 ANA 的 AcceptanceIssue 结构一致；不 import prompting 层。
 *
 * severity / category 用完整联合而不是收窄成 `"high"`：这里的对象要能塞进
 * 验收层的 `blockingIssues`，字段类型一旦比那边窄，泛型约束会在调用方报错。
 */
export interface SelfCheckAcceptanceIssue {
  severity: "low" | "medium" | "high" | "critical";
  category: "continuity" | "character" | "plot" | "mode_fit" | "voice";
  code: string;
  /** 恒为 false：正则自动改写在这里没有权限，只是字段名要跟验收层对齐 */
  canAutoRewrite?: boolean;
  evidence: string;
  fixSuggestion: string;
}

export interface SelfCheckAcceptanceDirective {
  mode: "patch" | "rewrite" | "manual";
  target: "continuity" | "character" | "plot" | "ending" | "voice";
  instruction: string;
}

export function toSelfCheckIssues(record: SepiaStructuralSelfCheckRecord): SelfCheckAcceptanceIssue[] {
  return record.blocking.slice(0, ISSUE_CAP).map((item) => ({
    severity: "high",
    category: issueCategoryOf(item),
    code: issueCodeOf(item),
    canAutoRewrite: false,
    evidence: `[sepia 自检 ${item.item}] ${item.evidence || item.fix}`.trim(),
    fixSuggestion: item.fix || "按自检项在正文中重写该处，不改动事实与情节走向。",
  }));
}

/**
 * 自检项 → 修文指令。
 *
 * 一律走 `patch`，不给 `rewrite`：整章重写会把刚清零的机械项重新写脏，
 * 而且成本是另一回事。结构级问题如果补丁改不动，流水线会判「无明确改善」并停在
 * needs_repair——这才是 sepia 的纪律（不过就停），不是偷偷换个更大的动作。
 */
export function toSelfCheckDirectives(record: SepiaStructuralSelfCheckRecord): SelfCheckAcceptanceDirective[] {
  return record.blocking.slice(0, DIRECTIVE_CAP).map((item) => ({
    mode: "patch",
    target: targetOf(item),
    instruction: `[sepia 自检 ${item.item}] ${item.evidence ? `原文：${item.evidence}；` : ""}${item.fix || "按该项要求重写此处。"}`
      + "只改叙述方式与段落组织，不新增事实、不改变情节与人物关系。",
  }));
}

/** 合并需要的最小结构；保持泛型避免把 prompting 层拖进 sepia 子树 */
export interface SelfCheckAssessmentShape {
  status: "accepted" | "repairable" | "needs_manual_review" | "continue_with_risk";
  blockingIssues: SelfCheckAcceptanceIssue[];
  repairDirectives: SelfCheckAcceptanceDirective[];
  continuePolicy: "continue" | "repair_once" | "pause";
  riskTags: string[];
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
 * 把自检结论合进验收结果。
 *
 * 三条与机械门一致的顺序：
 *   1. `needs_manual_review` 不被降级；
 *   2. 自检不可用**不**当作通过，但也不阻断——它是 LLM 调用，网络抖动不该让整章停摆，
 *      所以只打 `sepia_selfcheck_unavailable` 让人看得见"这章没跑自检"。
 *      机械门不一样：那是确定性脚本，没跑成按未过门算。
 *   3. 自检 blocking 非空 → `repair_once`，修完复跑；仍不过由流水线停在 needs_repair。
 */
export function mergeSelfCheckIntoAssessment<T extends SelfCheckAssessmentShape>(
  assessment: T,
  record: SepiaStructuralSelfCheckRecord,
): T {
  const riskTags = Array.from(new Set([...assessment.riskTags, ...selfCheckRiskTags(record)]));
  const directives = dedupeBy(
    [...toSelfCheckDirectives(record), ...assessment.repairDirectives],
    (directive) => `${directive.mode}|${directive.target}|${directive.instruction}`,
  );

  if (record.verdict !== "fail" || record.blocking.length === 0) {
    return { ...assessment, repairDirectives: directives, riskTags };
  }

  const status = assessment.status === "needs_manual_review" ? "needs_manual_review" : "repairable";
  return {
    ...assessment,
    status,
    continuePolicy: status === "needs_manual_review" ? "pause" : "repair_once",
    blockingIssues: dedupeBy(
      [...assessment.blockingIssues, ...toSelfCheckIssues(record)],
      (issue) => `${issue.code}|${issue.evidence}`,
    ),
    repairDirectives: directives,
    riskTags,
  };
}
