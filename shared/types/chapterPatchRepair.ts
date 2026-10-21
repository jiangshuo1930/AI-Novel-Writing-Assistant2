import { z } from "zod";

export const CHAPTER_PATCH_REPAIR_STRATEGIES = [
  "patch_first",
  "full_rewrite",
] as const;

export type ChapterPatchRepairStrategy = typeof CHAPTER_PATCH_REPAIR_STRATEGIES[number];

/**
 * 单份补丁计划的上限。
 *
 * 修文 prompt（4b）明确允许机械硬伤「一处命中一条、最多 12 条」，schema 必须
 * 与之对齐：此前这里是 8，模型认真覆盖 11 处 sepia 命中时，`parse` 直接抛
 * ZodError，整份计划丢弃、正文一字未改，机械门于是永远清不零。
 * 上限只约束结构，超出部分由 `applyChapterPatchRepairPlan` 截断，不整单作废。
 */
export const CHAPTER_PATCH_MAX_PATCHES = 12;

export const chapterPatchOperationSchema = z.object({
  id: z.string().trim().min(1),
  targetExcerpt: z.string().trim().min(6),
  replacement: z.string().trim(),
  reason: z.string().trim().min(1),
  issueIds: z.array(z.string().trim().min(1)).max(CHAPTER_PATCH_MAX_PATCHES).default([]),
});

export const chapterPatchRepairPlanSchema = z.object({
  strategy: z.enum(CHAPTER_PATCH_REPAIR_STRATEGIES).default("patch_first"),
  summary: z.string().trim().min(1),
  patches: z.array(chapterPatchOperationSchema).max(CHAPTER_PATCH_MAX_PATCHES).default([]),
  requiresFullRewrite: z.boolean().default(false),
  escalationReason: z.string().trim().nullable().optional(),
});

export type ChapterPatchOperation = z.infer<typeof chapterPatchOperationSchema>;
export type ChapterPatchRepairPlan = z.infer<typeof chapterPatchRepairPlanSchema>;

export type ChapterPatchApplyFailureType =
  | "requires_full_rewrite"
  | "missing_target"
  | "ambiguous_target"
  | "overlapping_target"
  | "no_effect";

export type ChapterPatchMatchStrategy = "exact" | "normalized_whitespace";

export interface ChapterPatchApplyFailure {
  patchId: string;
  reason: string;
  failureType: ChapterPatchApplyFailureType;
  matchedBy?: ChapterPatchMatchStrategy;
  occurrenceCount?: number;
}

export interface ChapterPatchAppliedPatch {
  patchId: string;
  matchedBy: ChapterPatchMatchStrategy;
}

export interface ChapterPatchApplyResult {
  success: boolean;
  content: string;
  appliedPatchIds: string[];
  appliedPatches: ChapterPatchAppliedPatch[];
  failures: ChapterPatchApplyFailure[];
}

function countOccurrences(content: string, target: string): number {
  if (target.length === 0) {
    return 0;
  }
  let count = 0;
  let cursor = 0;
  while (cursor < content.length) {
    const index = content.indexOf(target, cursor);
    if (index < 0) {
      break;
    }
    count += 1;
    cursor = index + target.length;
  }
  return count;
}

interface PatchMatch {
  start: number;
  end: number;
  matchedBy: ChapterPatchMatchStrategy;
}

function buildWhitespaceNormalizedIndex(value: string): {
  text: string;
  originalIndices: number[];
} {
  const chars: string[] = [];
  const originalIndices: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (/\s/u.test(char)) {
      continue;
    }
    chars.push(char);
    originalIndices.push(index);
  }
  return {
    text: chars.join(""),
    originalIndices,
  };
}

function findWhitespaceNormalizedMatches(content: string, target: string): PatchMatch[] {
  const normalizedContent = buildWhitespaceNormalizedIndex(content);
  const normalizedTarget = buildWhitespaceNormalizedIndex(target);
  if (!normalizedTarget.text) {
    return [];
  }

  const matches: PatchMatch[] = [];
  let cursor = 0;
  while (cursor < normalizedContent.text.length) {
    const normalizedIndex = normalizedContent.text.indexOf(normalizedTarget.text, cursor);
    if (normalizedIndex < 0) {
      break;
    }
    const lastNormalizedIndex = normalizedIndex + normalizedTarget.text.length - 1;
    const start = normalizedContent.originalIndices[normalizedIndex];
    const endSourceIndex = normalizedContent.originalIndices[lastNormalizedIndex];
    if (typeof start === "number" && typeof endSourceIndex === "number") {
      matches.push({
        start,
        end: endSourceIndex + 1,
        matchedBy: "normalized_whitespace",
      });
    }
    cursor = normalizedIndex + normalizedTarget.text.length;
  }
  return matches;
}

function findSafePatchMatch(content: string, target: string): {
  match: PatchMatch | null;
  occurrenceCount: number;
  matchedBy?: ChapterPatchMatchStrategy;
} {
  const exactCount = countOccurrences(content, target);
  if (exactCount === 1) {
    const start = content.indexOf(target);
    return {
      match: {
        start,
        end: start + target.length,
        matchedBy: "exact",
      },
      occurrenceCount: exactCount,
      matchedBy: "exact",
    };
  }
  if (exactCount > 1) {
    return {
      match: null,
      occurrenceCount: exactCount,
      matchedBy: "exact",
    };
  }

  const normalizedMatches = findWhitespaceNormalizedMatches(content, target);
  if (normalizedMatches.length === 1) {
    return {
      match: normalizedMatches[0]!,
      occurrenceCount: normalizedMatches.length,
      matchedBy: "normalized_whitespace",
    };
  }
  return {
    match: null,
    occurrenceCount: normalizedMatches.length,
    matchedBy: normalizedMatches.length > 0 ? "normalized_whitespace" : undefined,
  };
}

export function applyChapterPatchRepairPlan(
  content: string,
  plan: ChapterPatchRepairPlan,
): ChapterPatchApplyResult {
  /**
   * 截断先于校验。
   *
   * 模型偶尔会多吐一两条（重复锚点、把同一处拆成两条）。若直接 parse，Zod 的
   * `too_big` 会让 11 条合法补丁一起消失——修文越完整，正文越不改。这里只取
   * 前 `CHAPTER_PATCH_MAX_PATCHES` 条，剩下的下一轮门还会重报，不会漏。
   */
  const rawPatches = Array.isArray((plan as { patches?: unknown }).patches)
    ? (plan as { patches: unknown[] }).patches
    : [];
  const truncatedCount = Math.max(0, rawPatches.length - CHAPTER_PATCH_MAX_PATCHES);
  const normalizedPlan = chapterPatchRepairPlanSchema.parse({
    ...plan,
    patches: rawPatches.slice(0, CHAPTER_PATCH_MAX_PATCHES),
  });
  if (truncatedCount > 0) {
    console.warn("[chapter-patch] 补丁条数超出上限已截断", {
      limit: CHAPTER_PATCH_MAX_PATCHES,
      dropped: truncatedCount,
    });
  }
  let nextContent = content;
  const appliedPatchIds: string[] = [];
  const appliedPatches: ChapterPatchAppliedPatch[] = [];
  const failures: ChapterPatchApplyFailure[] = [];

  if (normalizedPlan.strategy !== "patch_first" || normalizedPlan.requiresFullRewrite) {
    return {
      success: false,
      content,
      appliedPatchIds,
      appliedPatches,
      failures: [{
        patchId: "plan",
        reason: normalizedPlan.escalationReason?.trim() || "补丁计划要求整章重写。",
        failureType: "requires_full_rewrite",
      }],
    };
  }

  const located: { patch: ChapterPatchOperation; match: PatchMatch }[] = [];
  /**
   * 「保留原文」也是一种合法结论。
   *
   * sepia 的 [读上下文] 项要求模型先判断该处是否承担叙事功能，不承担才改；
   * 模型判断要保留时，会照格式输出一条 replacement 与 targetExcerpt 相同的补丁来说明。
   * 它的 issueIds 往往只写标签名，既不在白名单里，也不产生正文变化。
   * 若把它当成失败，整份计划连同同批合法的破折号、副词修复一起作废，
   * 机械硬伤永远清不了零——所以只在「全部补丁都没产生变化」时才判失败。
   */
  const noEffectPatchIds: string[] = [];
  for (const patch of normalizedPlan.patches) {
    const target = patch.targetExcerpt.trim();
    const replacement = patch.replacement.trim();
    const matchResult = findSafePatchMatch(content, target);
    if (!matchResult.match) {
      failures.push({
        patchId: patch.id,
        reason: matchResult.occurrenceCount === 0
          ? "目标片段不存在，不能安全应用局部补丁。"
          : "目标片段出现多次，不能确定局部补丁位置。",
        failureType: matchResult.occurrenceCount === 0 ? "missing_target" : "ambiguous_target",
        matchedBy: matchResult.matchedBy,
        occurrenceCount: matchResult.occurrenceCount,
      });
      continue;
    }

    if (content.slice(matchResult.match.start, matchResult.match.end) === replacement) {
      noEffectPatchIds.push(patch.id);
      continue;
    }
    located.push({ patch, match: matchResult.match });
  }

  // Resolve every range against the original text before changing any prose.
  // Nested targets cannot be composed safely: neither replacement may be discarded.
  // 重叠意味着模型对文本结构的理解本身有误，整单拒绝，避免交错改写。
  //
  // 但「锚点缺失」只丢那一条，不牵连同批。11 条机械项里一条锚点抄错就整单作废，
  // 下一轮门报的还是同一批——正文永远不动，这正是 sepia 硬伤清不零的原因之一。
  const conflictIds = new Set<string>();
  for (let i = 0; i < located.length; i += 1) {
    const current = located[i]!;
    if (conflictIds.has(current.patch.id)) continue;
    const group = located.filter((other, j) => j !== i
      && current.match.start < other.match.end && other.match.start < current.match.end);
    if (!group.length) continue;
    const groupIds = [current.patch.id, ...group.map(other => other.patch.id)];
    for (const id of groupIds) conflictIds.add(id);
    for (const member of [current, ...group]) {
      failures.push({
        patchId: member.patch.id,
        failureType: "overlapping_target",
        matchedBy: member.match.matchedBy,
        reason: `目标片段与补丁 ${groupIds.filter(id => id !== member.patch.id).join("、")} 重叠，需合并为一条补丁。`,
      });
    }
  }
  if (conflictIds.size > 0) {
    return { success: false, content, appliedPatchIds, appliedPatches, failures };
  }

  // 一条都落不了地时，保留原来的判定语义：no_effect 与真失败要分开报。
  if (!located.length) {
    if (failures.length) return { success: false, content, appliedPatchIds, appliedPatches, failures };
    return {
      success: false,
      content,
      appliedPatchIds,
      appliedPatches,
      failures: noEffectPatchIds.map(patchId => ({
        patchId,
        reason: "局部补丁没有产生有效正文变化。",
        failureType: "no_effect" as const,
      })),
    };
  }

  for (const { patch, match } of [...located].sort((a, b) => b.match.start - a.match.start)) {
    nextContent = nextContent.slice(0, match.start) + patch.replacement.trim() + nextContent.slice(match.end);
  }
  for (const { patch, match } of located) {
    appliedPatchIds.push(patch.id);
    appliedPatches.push({
      patchId: patch.id,
      matchedBy: match.matchedBy,
    });
  }

  const changed = nextContent.trim() !== content.trim();
  return {
    success: appliedPatchIds.length > 0 && changed,
    content: nextContent,
    appliedPatchIds,
    appliedPatches,
    failures,
  };
}
