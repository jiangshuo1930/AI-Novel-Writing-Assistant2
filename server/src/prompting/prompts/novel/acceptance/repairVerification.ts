import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ChapterAcceptanceAssessmentOutput,
  ChapterAcceptancePromptInput,
} from "../chapterAcceptance.prompts";

export class ChapterRepairVerificationError extends Error {
  /** evidence_invalid 的复验可以降级 salvaged；身份/覆盖不匹配必须整体作废。 */
  constructor(message: string, readonly code?: "identity_invalid" | "evidence_invalid" | "coverage_invalid") {
    super(message);
    this.name = "ChapterRepairVerificationError";
  }
}

export const repairVerificationSchema = z.object({
  contentHash: z.string().trim().min(1),
  checks: z.array(z.object({
    kind: z.enum(["issue", "obligation"]),
    key: z.string().trim().min(1),
    status: z.enum(["resolved", "unresolved"]),
    currentEvidence: z.string().trim().min(1).max(350),
    reason: z.string().trim().min(1),
  })).max(20),
  factPreservation: z.object({
    sourceContentHash: z.string().trim().min(1),
    status: z.enum(["preserved", "authorized_correction", "changed", "uncertain"]),
    correctionIssueIds: z.array(z.string()).max(8),
    currentEvidence: z.string().trim().min(1).max(350),
    reason: z.string().trim().min(1),
  }).optional(),
});

export function candidateContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Retain requirements, but never present old evidence as candidate prose. */
export function buildRepairReviewChecklist(input: ChapterAcceptancePromptInput) {
  const baseline = input.repairReviewBaseline;
  if (!baseline) return null;
  return {
    contentHash: candidateContentHash(input.content),
    issues: [...new Map(baseline.blockingIssues.map(issue => [issue.code, {
      kind: "issue" as const, key: issue.code, category: issue.category,
      requirement: issue.fixSuggestion,
    }])).values()],
    obligations: [...new Map(baseline.missingObligations.map(item => [`${item.kind}:${item.summary}`, {
      kind: "obligation" as const, key: `${item.kind}:${item.summary}`, requirement: item.summary,
    }])).values()],
    repairDirectives: baseline.repairDirectives,
    ...(input.styleRewriteBaseline ? { styleProtection: input.styleRewriteBaseline } : {}),
  };
}

function compactQuote(value: string): string {
  return value.replace(/\s+/gu, "");
}

/** Validate identities, coverage and literal evidence only; AI owns semantic judgments. */
export function validateRepairReview(
  output: ChapterAcceptanceAssessmentOutput,
  input: ChapterAcceptancePromptInput,
): ChapterAcceptanceAssessmentOutput {
  const checklist = buildRepairReviewChecklist(input);
  if (!checklist) return output;
  const verification = output.repairVerification;
  if (!verification || verification.contentHash !== checklist.contentHash) {
    throw new ChapterRepairVerificationError("修文复验未核对当前候选正文身份。", "identity_invalid");
  }
  const currentContent = compactQuote(input.content);
  // 收集证据不合法的具体条目，供语义重试反馈定位，避免模型重复复用历史报告证据。
  const invalidEvidenceKeys: string[] = [];
  const verifyQuote = (quote: string | undefined, label: string) => {
    if (!quote || !compactQuote(quote) || !currentContent.includes(compactQuote(quote))) {
      invalidEvidenceKeys.push(label);
    }
  };
  const expected = new Set([...checklist.issues, ...checklist.obligations].map(item => `${item.kind}:${item.key}`));
  const seen = new Set<string>();
  const remaining = new Set([
    ...output.blockingIssues.map(issue => `issue:${issue.code}`),
    ...output.missingObligations.map(item => `obligation:${item.kind}:${item.summary}`),
  ]);
  for (const check of verification.checks) {
    const key = `${check.kind}:${check.key}`;
    if (!expected.has(key) || seen.has(key)) {
      throw new ChapterRepairVerificationError(`修文复验核对项不匹配或重复：${key}。checks 必须按清单的 kind/key 恰好核对一次。`);
    }
    seen.add(key);
    verifyQuote(check.currentEvidence, `${key}`);
    if (check.status === "resolved" && remaining.has(key)) {
      throw new ChapterRepairVerificationError(`修文复验把已解决项同时列为未解决问题：${key}。要么从 blockingIssues 删除，要么改判 unresolved。`);
    }
    if (check.status === "unresolved" && output.status === "accepted") {
      throw new ChapterRepairVerificationError(`修文复验存在未解决项 ${key}，不能宣称全部验收通过。status 应为 repairable 或 continue_with_risk。`);
    }
  }
  if (seen.size !== expected.size) {
    const missing = [...expected].filter(key => !seen.has(key)).join("、");
    throw new ChapterRepairVerificationError(`修文复验遗漏核对项：${missing}。清单中每个条目都必须出现一次。`, "coverage_invalid");
  }
  for (const issue of output.blockingIssues) verifyQuote(issue.currentEvidence, `blockingIssue:${issue.code}`);
  for (const item of output.missingObligations) verifyQuote(item.currentEvidence, `obligation:${item.kind}:${item.summary}`);
  if (invalidEvidenceKeys.length) {
    throw new ChapterRepairVerificationError(
      `以下条目的 currentEvidence 不是当前正文的原句（疑似复制了历史报告证据）：${invalidEvidenceKeys.join("、")}。`
      + `必须从本轮正文中连续复制这些问题的现存原句；若该问题已被修掉，改判 resolved 并引用修后正文。`,
      "evidence_invalid",
    );
  }
  if (input.styleRewriteBaseline) {
    const facts = verification.factPreservation;
    const authorized = input.styleRewriteBaseline.allowedCorrectionIssueIds;
    if (!facts || facts.sourceContentHash !== input.styleRewriteBaseline.sourceContentHash
      || facts.status === "changed" || facts.status === "uncertain"
      || facts.correctionIssueIds.some(id => !authorized.includes(id))
      || (facts.status === "authorized_correction" && facts.correctionIssueIds.length === 0)
      || (facts.status === "preserved" && facts.correctionIssueIds.length > 0)) {
      throw new ChapterRepairVerificationError("表达修文未完成可信的事实保护核对，保留原稿。");
    }
    verifyQuote(facts.currentEvidence, "factPreservation");
  }
  return output;
}
