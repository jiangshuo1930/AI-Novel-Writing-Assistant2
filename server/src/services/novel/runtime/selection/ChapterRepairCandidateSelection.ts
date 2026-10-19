import { createHash } from "node:crypto";
import type { ChapterRuntimePackage } from "@ai-novel/shared/types/chapterRuntime";
import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import type { StyleRewriteGuard } from "@ai-novel/shared/types/styleEngine";

export interface ChapterRepairCandidateEvaluation {
  content: string;
  pass: boolean;
  runtimePackage: ChapterRuntimePackage;
  issues?: ReviewIssue[];
  assessmentVerified?: boolean;
  rewriteGuard?: StyleRewriteGuard;
}

export interface ChapterRepairSelectionRecord {
  selected: "original" | "candidate";
  reasonCode:
    | "candidate_passed"
    | "candidate_resolved_blockers"
    | "candidate_improved"
    | "original_retained_new_severe_issue"
    | "original_retained_obligation_regression"
    | "original_retained_sepia_regression"
    | "original_retained_no_clear_improvement"
    | "original_retained_unverified_review";
  reason: string;
  /** 只在 sepia 机械项变差时出现，供 UI / 日志直接取用，不必再匹配 reasonCode */
  rollbackReason?: "sepia_regression";
  originalContentHash: string;
  candidateContentHash: string;
  originalScore: number;
  candidateScore: number;
}

/** 与 sepia 转译层写进 riskTags 的前缀一致（`sepia_blocking:<n>`） */
const SEPIA_BLOCKING_PREFIX = "sepia_blocking";

/**
 * 从 riskTags 读 sepia 的**真实** blocking 条数。
 *
 * 不能数 `blockingIssues` 里 SEPIA_ 开头的条目：那个数组被验收层封顶到 5 条，
 * 5 条与 9 条看不出差别，回滚判定会失效。所以条数由标签携带。
 * 兼容早期不带数字的 `sepia_blocking`（按 1 条算）。
 */
export function readSepiaBlockingCount(runtimePackage: ChapterRuntimePackage): number {
  let count = 0;
  for (const tag of runtimePackage.meta?.riskTags ?? []) {
    if (tag === SEPIA_BLOCKING_PREFIX) {
      count = Math.max(count, 1);
      continue;
    }
    if (!tag.startsWith(`${SEPIA_BLOCKING_PREFIX}:`)) continue;
    const parsed = Number.parseInt(tag.slice(SEPIA_BLOCKING_PREFIX.length + 1), 10);
    if (Number.isFinite(parsed)) count = Math.max(count, parsed);
  }
  return count;
}

export function selectChapterRepairCandidate(input: {
  original: ChapterRepairCandidateEvaluation;
  candidate: ChapterRepairCandidateEvaluation;
}): ChapterRepairSelectionRecord {
  const originalSevereIssues = collectSevereIssueKeys(input.original);
  const candidateSevereIssues = collectSevereIssueKeys(input.candidate);
  const addedSevereIssues = [...candidateSevereIssues]
    .filter((key) => !originalSevereIssues.has(key));
  const originalMissing = collectMissingObligationKeys(input.original.runtimePackage);
  const candidateMissing = collectMissingObligationKeys(input.candidate.runtimePackage);
  const addedMissingObligations = [...candidateMissing]
    .filter((key) => !originalMissing.has(key));
  const base = {
    originalContentHash: hashContent(input.original.content),
    candidateContentHash: hashContent(input.candidate.content),
    originalScore: input.original.runtimePackage.audit.score.overall,
    candidateScore: input.candidate.runtimePackage.audit.score.overall,
  };

  const guard = input.candidate.rewriteGuard;
  if (input.candidate.assessmentVerified === false || (guard && (
    guard.sourceContentHash !== base.originalContentHash || guard.candidateContentHash !== base.candidateContentHash
    || guard.checks.some(check => check.status !== "passed")
    || ["patch_scope", "edit_budget", "protected_terms", "semantic_facts"].some(code => !guard.checks.some(check => check.code === code))
  ))) {
    return {
      ...base, selected: "original", reasonCode: "original_retained_unverified_review",
      reason: "候选正文的复验未完成有效核对，保留原稿及其检查结果。",
    };
  }

  if (addedSevereIssues.length > 0) {
    return {
      ...base,
      selected: "original",
      reasonCode: "original_retained_new_severe_issue",
      reason: "修复候选引入了原稿没有的高严重度问题，因此保留原稿。",
    };
  }

  if (addedMissingObligations.length > 0
    || candidateMissing.size > originalMissing.size) {
    return {
      ...base,
      selected: "original",
      reasonCode: "original_retained_obligation_regression",
      reason: "修复候选新增或扩大了未兑现章节义务，因此保留原稿。",
    };
  }

  // sepia 复跑回滚：机械项只增不减，说明这次修文把可量化的毛病改多了。
  // 放在 candidate_passed 之前——候选即便"通过"了 LLM 验收，机械门变差也不算改善。
  const originalSepiaBlocking = readSepiaBlockingCount(input.original.runtimePackage);
  const candidateSepiaBlocking = readSepiaBlockingCount(input.candidate.runtimePackage);
  if (candidateSepiaBlocking > originalSepiaBlocking) {
    return {
      ...base,
      selected: "original",
      reasonCode: "original_retained_sepia_regression",
      rollbackReason: "sepia_regression",
      reason: `修复候选使 sepia 机械项由 ${originalSepiaBlocking} 条增至 ${candidateSepiaBlocking} 条，按复跑纪律回滚原稿。`,
    };
  }

  if (input.candidate.pass && !input.original.pass) {
    return {
      ...base,
      selected: "candidate",
      reasonCode: "candidate_passed",
      reason: "修复候选通过接收检查，而原稿未通过。",
    };
  }

  const originalBlocking = countBlockingIssues(input.original);
  const candidateBlocking = countBlockingIssues(input.candidate);
  if (candidateBlocking < originalBlocking) {
    return {
      ...base,
      selected: "candidate",
      reasonCode: "candidate_resolved_blockers",
      reason: "修复候选减少了阻塞性问题，且没有引入新的严重问题或义务缺口。",
    };
  }

  const originalIssueCount = input.original.runtimePackage.audit.openIssues.length;
  const candidateIssueCount = input.candidate.runtimePackage.audit.openIssues.length;
  if (candidateMissing.size < originalMissing.size || candidateIssueCount < originalIssueCount) {
    return {
      ...base,
      selected: "candidate",
      reasonCode: "candidate_improved",
      reason: "修复候选减少了未兑现义务或结构化审校问题，且没有引入新的严重风险。",
    };
  }

  return {
    ...base,
    selected: "original",
    reasonCode: "original_retained_no_clear_improvement",
    reason: "修复候选没有形成明确的结构化质量改善，因此保留原稿。",
  };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function collectSevereIssueKeys(evaluation: ChapterRepairCandidateEvaluation): Set<string> {
  return new Set([
    ...evaluation.runtimePackage.audit.openIssues
      .filter((issue) => issue.severity === "high" || issue.severity === "critical")
      // Runtime audit issues retain stable ids/codes. Derived ReviewIssue
      // values intentionally omit AI evidence, which is not an identity.
      .map((issue) => normalizeKey(issue.code || issue.id)),
  ]);
}

function collectMissingObligationKeys(runtimePackage: ChapterRuntimePackage): Set<string> {
  return new Set((runtimePackage.obligationCoverage?.missing ?? [])
    .map((obligation) => normalizeKey(`${obligation.kind}:${obligation.summary}`)));
}

function countBlockingIssues(evaluation: ChapterRepairCandidateEvaluation): number {
  const severeIssueCount = collectSevereIssueKeys(evaluation).size;
  const explicitBlockingCount = evaluation.runtimePackage.replanRecommendation?.blockingIssueIds?.length ?? 0;
  return Math.max(
    severeIssueCount + explicitBlockingCount,
    evaluation.runtimePackage.audit.hasBlockingIssues ? 1 : 0,
  );
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}
