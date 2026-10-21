import type { ChapterReviewRetryPolicy } from "@ai-novel/shared/types/directorIssue";
import { prisma } from "../../../../../db/prisma";
import { ChapterReviewRetryBudget, ReviewRetryPersistenceError, ReviewRetryExhaustedError, chapterReviewRetryStateSchema,
  type ChapterReviewRetryState } from "./ChapterReviewRetryBudget";

/**
 * 用户明确「从保存进度继续」时，为这一章重新发一次检查预算。
 *
 * 保存的检查结果已经不在（修文后中断、旧版本任务留下的正文），旧的重试计数
 * 代表的是上一版正文的修复机会；继续沿用它，这一章会永远停在 exhausted，
 * 连一次检查都跑不起来，只能靠人工改正文解锁。
 */
export async function resetChapterReviewRetryBudget(input: {
  novelId: string; chapterId: string; executionId: string;
}): Promise<void> {
  await prisma.chapterArtifactSyncCheckpoint.deleteMany({ where: {
    novelId: input.novelId, chapterId: input.chapterId,
    contentHash: input.executionId, artifactType: "chapter_review_retry_budget:v1", syncMode: "execution",
  } });
}

/** Lazily open the receipt: cached/finalized chapters do not create new attempts. */
export function createPersistedChapterReviewRetryBudget(input: {
  novelId: string; chapterId: string; executionId: string; policy: ChapterReviewRetryPolicy;
  beforeRequest?: () => Promise<void>;
}): ChapterReviewRetryBudget {
  const identity = { novelId: input.novelId, chapterId: input.chapterId,
    contentHash: input.executionId, artifactType: "chapter_review_retry_budget:v1", syncMode: "execution" };
  const where = { novelId_chapterId_contentHash_artifactType_syncMode: identity };
  const initial: ChapterReviewRetryState = { version: 1, policy: input.policy, used: 0, startedChecks: [], failedChecks: [] };
  return new ChapterReviewRetryBudget(initial, {
    read: async () => {
      try {
        const row = await prisma.chapterArtifactSyncCheckpoint.findUnique({ where, select: { metadataJson: true } });
        return row ? chapterReviewRetryStateSchema.parse(JSON.parse(row.metadataJson ?? "null")) : null;
      } catch (error) {
        throw new ReviewRetryPersistenceError("章节检查重试记录无法读取或核验，已停止继续。", { cause: error });
      }
    },
    update: async change => {
      try {
        await prisma.chapterArtifactSyncCheckpoint.upsert({ where, create: {
          ...identity, status: "succeeded", metadataJson: JSON.stringify(initial),
        }, update: {}, select: { metadataJson: true } });
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const current = await prisma.chapterArtifactSyncCheckpoint.findUniqueOrThrow({ where, select: { metadataJson: true } });
          const next = chapterReviewRetryStateSchema.parse(change(chapterReviewRetryStateSchema.parse(JSON.parse(current.metadataJson ?? "null"))));
          const updated = await prisma.chapterArtifactSyncCheckpoint.updateMany({
            where: { ...identity, metadataJson: current.metadataJson }, data: { metadataJson: JSON.stringify(next) },
          });
          if (updated.count === 1) return next;
        }
        throw new ReviewRetryPersistenceError("章节检查重试记录被并发修改，请从保存位置继续。");
      } catch (error) {
        if (error instanceof ReviewRetryExhaustedError) throw error;
        throw new ReviewRetryPersistenceError("章节检查重试记录无法保存或核验，已停止调用。", { cause: error });
      }
    },
  }, input.beforeRequest);
}
