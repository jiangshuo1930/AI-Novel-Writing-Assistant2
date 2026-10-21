import { manualChapterSyncService, MANUAL_CHAPTER_SYNC_TYPE } from "../chapterEditor/synchronization";
import { buildChapterArtifactContentHash } from "../runtime/artifactSync/ChapterArtifactContentVersion";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DIRECTOR_ISSUE_GOVERNANCE_VERSION,
  resolveChapterReviewRetryPolicy,
  type DirectorIssueAction,
  type DirectorIssueCode,
} from "@ai-novel/shared/types/directorIssue";
import { prisma } from "../../../db/prisma";
import { novelEventBus } from "../../../events/publisher";
import { runWithLlmUsageTracking } from "../../../llm/usageTracking";
import { buildDirectorCompletionProfile } from "@ai-novel/shared/types/directorCompletion";
import { ChapterRouteWindowService } from "../planning/ChapterRouteWindowService";
import { ChapterRuntimeCoordinator } from "../runtime/ChapterRuntimeCoordinator";
import { createPersistedChapterReviewRetryBudget, resetChapterReviewRetryBudget, withChapterReviewRetryBudget, ReviewRetryPersistenceError } from "../runtime/acceptance";
import { CHAPTER_ARTIFACT_BOUNDARY_TYPE, ChapterArtifactSyncBoundaryError } from "../runtime/artifactSync";
import { isChapterEmptyContentError } from "../runtime/chapterEmptyContentError";
import { ChapterContentPersistenceError } from "../runtime/lifecycle";
import {
  logPipelineError,
  logPipelineInfo,
  logPipelineWarn,
  type PipelinePayload,
  type PipelineRunOptions,
} from "../novelCoreShared";
import { plannerService } from "../../planner/PlannerService";
import { applyChapterQualityClosure } from "./qualityClosure/ChapterQualityClosure";
import { recoverSavedChapterQuality, SavedChapterQualityRecoveryError } from "./qualityClosure/SavedChapterQualityRecovery";
import {assertDirectorPipelineOwner} from "../../../modules/novel/director-routing";
import { ChapterAutomaticAttemptService } from "./attempts";
import { isCurrentChapterProductionCompleted, isCurrentV2ChapterProductionCompleted } from "./completion";
import {
  beginChapterUsage,
  DIRECTOR_CHAPTER_PREFLIGHT_RESERVE_TOKENS,
  readChapterUsageCounters,
  pauseChapterBudget,
  chapterBudgetView,
  observeChapterUsage,
  finalizeChapterUsage,
} from "./usage";
import type {DirectorChapterBudgetStage} from "@ai-novel/shared/types/director/chapterBudget";
import {
  loadDirectorIssueTaskContext,
} from "../director/issues";
import {
  reportPipelineIssue,
  resolvePipelineRuntimeIssueCode,
} from "./issueGovernance/PipelineIssueGovernance";
import {
  buildPipelineCurrentItemLabel,
  buildPipelineStageProgress,
  parsePipelinePayload as parsePipelineJobPayload,
  stringifyPipelinePayload as stringifyPipelineJobPayload,
  type PipelineActiveStage,
} from "../pipelineJobState";

const PIPELINE_HEARTBEAT_INTERVAL_MS = 15000;
/**
 * sepia 专项门在普通章节重试预算之外额外允许的轮数。
 *
 * 对应原版 SKILL.md 的「lint.py 复跑，FAIL 清零」：清洗机械项是收敛过程，
 * 不是一次重试。上限保持很小（2 轮，加上原预算通常共 3 轮），用尽即停。
 *
 * 结构自检（L2/L3-1/L3-2/L4）**共用**这份额度，不另开一份：
 * 两级门是同一条收敛链上的前后两段，各自 2 轮会变成 4 轮，而每轮都是一次
 * 验收 + 一次自检调用。共用额度才是原版「复跑到全过」的成本上限。
 */
const SEPIA_MECHANICAL_EXTRA_ROUNDS = 2;

class PipelineIssueAppliedError extends Error {
  constructor(
    message: string,
    readonly action: Exclude<DirectorIssueAction, "auto_retry">,
  ) {
    super(message);
    this.name = "PipelineIssueAppliedError";
  }
}

class PipelineIssueFailure extends Error {
  constructor(
    message: string,
    readonly issueCode: DirectorIssueCode,
    readonly stage: string,
    readonly chapterId?: string,
    readonly chapterOrder?: number,
  ) {
    super(message);
    this.name = "PipelineIssueFailure";
  }
}

class PipelineExecutionLeaseLostError extends Error {
  constructor() {
    super("PIPELINE_EXECUTION_LEASE_LOST");
    this.name = "PipelineExecutionLeaseLostError";
  }
}

function clampPipelineMaxRetries(value: number | null | undefined): number {
  return Math.max(0, Math.min(value ?? 1, 1));
}

function buildEmptyChapterDetail(chapter: { order: number; title: string }): string {
  return `第${chapter.order}章「${chapter.title}」正文生成失败：模型连续未返回可保存正文，已暂停继续。`;
}

export class NovelPipelineExecutor {
  private readonly executionOwnerStore = new AsyncLocalStorage<string | null>();

  constructor(
    private readonly chapterRuntimeCoordinator = new ChapterRuntimeCoordinator(),
    private readonly automaticAttempts = new ChapterAutomaticAttemptService(),
    private readonly assertOwner = assertDirectorPipelineOwner,
  ) {}

  private async ensurePipelineNotCancelled(jobId: string): Promise<void> {
    const executionOwner = this.executionOwnerStore.getStore();
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        status: true,
        pendingManualRecovery: true,
        cancelRequestedAt: true,
        executionOwner: true,
        executionLeaseExpiresAt: true,
      },
    });
    if (!job || job.status === "cancelled" || job.cancelRequestedAt) {
      throw new Error("PIPELINE_CANCELLED");
    }
    if (
      executionOwner
      && (
        job.pendingManualRecovery
        || job.executionOwner !== executionOwner
        || !job.executionLeaseExpiresAt
        || job.executionLeaseExpiresAt.getTime() <= Date.now()
      )
    ) {
      throw new PipelineExecutionLeaseLostError();
    }
  }

  private async updateJobSafe(jobId: string, data: {
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    progress?: number;
    completedCount?: number;
    totalCount?: number;
    endOrder?: number;
    retryCount?: number;
    pendingManualRecovery?: boolean;
    heartbeatAt?: Date | null;
    currentStage?: string | null;
    currentItemKey?: string | null;
    currentItemLabel?: string | null;
    cancelRequestedAt?: Date | null;
    error?: string | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    payload?: string | null;
  }, writeMode: "runnable" | "cancelled" = "runnable") {
    const executionOwner = this.executionOwnerStore.getStore();
    try {
      if (executionOwner) {
        const updated = await prisma.generationJob.updateMany({
          where: {
            id: jobId,
            executionOwner,
            executionLeaseExpiresAt: { gt: new Date() },
            ...(writeMode === "runnable"
              ? {
                  status: { in: ["queued", "running"] as const },
                  pendingManualRecovery: false,
                  cancelRequestedAt: null,
                }
              : {
                  OR: [
                    { status: "cancelled" as const },
                    { cancelRequestedAt: { not: null } },
                  ],
                }),
          },
          data,
        });
        if (updated.count !== 1) throw new PipelineExecutionLeaseLostError();
      } else {
        await prisma.generationJob.update({ where: { id: jobId }, data });
      }
    } catch (error) {
      if (error instanceof PipelineExecutionLeaseLostError) throw error;
      // 后台任务状态更新失败不应影响主服务稳定
    }
  }

  private async updateJobRequired(
    jobId: string,
    data: Parameters<NovelPipelineExecutor["updateJobSafe"]>[1],
  ): Promise<void> {
    const executionOwner = this.executionOwnerStore.getStore();
    if (!executionOwner) {
      await prisma.generationJob.update({ where: { id: jobId }, data });
      return;
    }
    const updated = await prisma.generationJob.updateMany({
      where: {
        id: jobId,
        executionOwner,
        executionLeaseExpiresAt: { gt: new Date() },
        status: { in: ["queued", "running"] },
        pendingManualRecovery: false,
        cancelRequestedAt: null,
      },
      data,
    });
    if (updated.count !== 1) throw new PipelineExecutionLeaseLostError();
  }

  private stringifyPipelinePayload(input: PipelinePayload) {
    return stringifyPipelineJobPayload(input);
  }

  private parsePipelinePayload(payload: string | null | undefined) {
    return parsePipelineJobPayload(payload);
  }

  execute(jobId: string, novelId: string, options: PipelineRunOptions, executionOwner?: string): Promise<void> {
    return this.executionOwnerStore.run(
      executionOwner?.trim() || null,
      () => this.executeWithOwnership(jobId, novelId, options),
    );
  }

  private async executeWithOwnership(jobId: string, novelId: string, options: PipelineRunOptions) {
    const maxRetries = clampPipelineMaxRetries(options.maxRetries);
    const qualityThreshold = options.qualityThreshold ?? 75;
    const existingJob = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        startedAt: true,
        completedCount: true,
        totalCount: true,
        retryCount: true,
        payload: true,
      },
    });
    const persistedPayload = this.parsePipelinePayload(existingJob?.payload);
    const runtimePayload: PipelinePayload = {
      provider: persistedPayload.provider ?? options.provider ?? "deepseek",
      model: persistedPayload.model ?? options.model ?? "",
      temperature: persistedPayload.temperature ?? options.temperature ?? 0.8,
      controlPolicy: persistedPayload.controlPolicy ?? options.controlPolicy,
      issueGovernanceVersion: persistedPayload.issueGovernanceVersion ?? options.issueGovernanceVersion,
      issuePolicySnapshot: persistedPayload.issuePolicySnapshot ?? options.issuePolicySnapshot,
      workflowTaskId: persistedPayload.workflowTaskId ?? options.workflowTaskId,
      directorNext: persistedPayload.directorNext ?? options.directorNext,
      taskStyleProfileId: persistedPayload.taskStyleProfileId ?? options.taskStyleProfileId,
      // Missing historical snapshots stay missing; never read new defaults on resume.
      styleSignalPolicy: persistedPayload.styleSignalPolicy,
      maxRetries: clampPipelineMaxRetries(persistedPayload.maxRetries ?? options.maxRetries),
      runMode: persistedPayload.runMode ?? options.runMode ?? "fast",
      autoReview: persistedPayload.autoReview ?? options.autoReview ?? true,
      autoRepair: persistedPayload.autoRepair ?? options.autoRepair ?? true,
      skipCompleted: persistedPayload.skipCompleted ?? options.skipCompleted ?? true,
      qualityThreshold: persistedPayload.qualityThreshold ?? options.qualityThreshold,
      repairMode: persistedPayload.repairMode ?? options.repairMode ?? "light_repair",
      artifactSyncMode: persistedPayload.artifactSyncMode ?? options.artifactSyncMode ?? "adaptive",
    };
    await this.assertOwner(novelId, runtimePayload);
    const checkCancelled = async () => {
      await this.ensurePipelineNotCancelled(jobId);
      await this.assertOwner(novelId, runtimePayload);
    };
    const directorTelemetryTask = runtimePayload.workflowTaskId
      ? await prisma.novelWorkflowTask.findUnique({
        where: { id: runtimePayload.workflowTaskId },
        select: {
          lane: true,
          directorRun: {
            select: { id: true },
          },
        },
      }).catch(() => null)
      : null;
    const shouldRecordDirectorTelemetry = directorTelemetryTask?.lane === "auto_director";
    const snapshottedIssueGovernance = runtimePayload.issueGovernanceVersion === DIRECTOR_ISSUE_GOVERNANCE_VERSION
      && runtimePayload.issuePolicySnapshot
      ? {
        novelId,
        issueGovernanceVersion: DIRECTOR_ISSUE_GOVERNANCE_VERSION,
        policy: runtimePayload.issuePolicySnapshot,
        runMode: runtimePayload.controlPolicy?.advanceMode ?? runtimePayload.runMode,
        policySource: "task_snapshot" as const,
      }
      : null;
    const issueGovernance = snapshottedIssueGovernance ?? (shouldRecordDirectorTelemetry
      ? await loadDirectorIssueTaskContext(runtimePayload.workflowTaskId)
      : null);
    let totalRetryCount = Math.max(existingJob?.retryCount ?? 0, 0);
    const qualityAlertDetails = [...(persistedPayload.qualityAlertDetails ?? [])];
    const replanAlertDetails = [...(persistedPayload.replanAlertDetails ?? [])];
    const recoverableRepairDetails = [...(persistedPayload.recoverableRepairDetails ?? [])];
    const applyGovernedIssue = async (input: {
      issueCode: DirectorIssueCode;
      stage: string;
      summary: string;
      evidence?: string;
      chapterId?: string;
      chapterOrder?: number;
      attempt: number;
      onRetry?: () => Promise<void>;
    }): Promise<DirectorIssueAction | null> => {
      let appliedAction: DirectorIssueAction | null = null;
      const result = await reportPipelineIssue({
        governance: issueGovernance,
        workflowTaskId: runtimePayload.workflowTaskId,
        novelId,
        jobId,
        issueCode: input.issueCode,
        stage: input.stage,
        summary: input.summary,
        evidence: input.evidence,
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        attempt: input.attempt,
        hasUsableOutput: false,
        provider: runtimePayload.provider,
        model: runtimePayload.model,
        temperature: runtimePayload.temperature,
        applyAction: async (decision) => {
          runtimePayload.directorNext?.decisions.push({...decision, ...(input.chapterOrder ? {chapterOrder: input.chapterOrder} : {})});
          appliedAction = decision.action;
          if (decision.action === "auto_retry") {
            if (!input.onRetry) {
              throw new Error("问题策略要求自动重试，但当前执行边界没有安全的重试入口。");
            }
            await input.onRetry();
            return;
          }
          const payload = this.stringifyPipelinePayload({
            ...runtimePayload,
            qualityAlertDetails,
            replanAlertDetails,
            recoverableRepairDetails,
          });
          if (decision.action === "pause_for_manual") {
            await this.updateJobRequired(jobId, {
              status: "queued",
              pendingManualRecovery: true,
              error: input.summary,
              heartbeatAt: null,
              currentStage: "queued",
              currentItemKey: null,
              currentItemLabel: null,
              cancelRequestedAt: null,
              finishedAt: null,
              payload,
            });
            return;
          }
          await this.updateJobRequired(jobId, {
            status: "failed",
            pendingManualRecovery: false,
            error: input.summary,
            heartbeatAt: null,
            currentStage: null,
            currentItemKey: null,
            currentItemLabel: null,
            cancelRequestedAt: null,
            finishedAt: new Date(),
            payload,
          });
        },
      });
      return result ? appliedAction ?? result.decision.action : null;
    };

    try {
      await runWithLlmUsageTracking({
        generationJobId: jobId,
        workflowTaskId: runtimePayload.workflowTaskId,
        directorTelemetry: shouldRecordDirectorTelemetry,
        novelId,
        directorNextRunId: runtimePayload.directorNext?.runId ?? null,
        directorRunId: shouldRecordDirectorTelemetry
          ? directorTelemetryTask?.directorRun?.id ?? runtimePayload.workflowTaskId ?? null
          : null,
      }, async () => {
        await checkCancelled();
        await this.updateJobSafe(jobId, {
          status: "running",
          pendingManualRecovery: false,
          startedAt: existingJob?.startedAt ?? new Date(),
          heartbeatAt: new Date(),
          currentStage: "generating_chapters",
        });
        logPipelineInfo("任务开始执行", {
          jobId,
          novelId,
          range: `${options.startOrder}-${options.endOrder}`,
          maxRetries,
        });

        if (options.startOrder > 1) await manualChapterSyncService.ensurePrevious(novelId, options.startOrder, checkCancelled);
        const [novel, chapterCandidates] = await Promise.all([
          prisma.novel.findUnique({ where: { id: novelId } }),
          prisma.chapter.findMany({
            where: {
              novelId,
              order: { gte: options.startOrder, lte: options.endOrder },
            },
            orderBy: { order: "asc" },
            include: {
              artifactSyncCheckpoints: {
                where: { OR: [{artifactType: CHAPTER_ARTIFACT_BOUNDARY_TYPE, status: "succeeded"}, {artifactType: MANUAL_CHAPTER_SYNC_TYPE}] },
                select: { contentHash: true, metadataJson: true, artifactType: true },
                orderBy: { updatedAt: "desc" },
              },
            },
          }),
        ]);
        const manuallyEditedChapterIds = new Set<string>();
        for (const chapter of chapterCandidates) {
          const edited = chapter.artifactSyncCheckpoints.some(row => row.artifactType === MANUAL_CHAPTER_SYNC_TYPE
            && row.contentHash === buildChapterArtifactContentHash(chapter.content ?? ""));
          if (edited) manuallyEditedChapterIds.add(chapter.id);
          const terminal = chapter.generationState === "approved" || chapter.generationState === "published" || chapter.chapterStatus === "completed";
          if (!chapter.content?.trim() || isCurrentV2ChapterProductionCompleted(chapter) || (!edited && !terminal)) continue;
          await checkCancelled();
          await this.updateJobSafe(jobId, {currentStage: "reviewing", currentItemKey: chapter.id,
            currentItemLabel: "正在同步第" + chapter.order + "章修订后的资料"});
          try { await manualChapterSyncService.ensureCurrent(novelId, chapter.id, checkCancelled); }
          catch (error) {
            if (error instanceof PipelineExecutionLeaseLostError || (error instanceof Error && error.message === "PIPELINE_CANCELLED")) throw error;
            if (runtimePayload.directorNext && error instanceof ChapterArtifactSyncBoundaryError && error.result.characterReviewId) {
              runtimePayload.directorNext.pendingCharacterReviewId = error.result.characterReviewId;
              await this.updateJobRequired(jobId, {status: "queued", pendingManualRecovery: true,
                error: error.message, payload: this.stringifyPipelinePayload(runtimePayload)});
              throw new PipelineIssueAppliedError(error.message, "pause_for_manual");
            }
            throw new PipelineIssueFailure(error instanceof Error ? error.message : "修订正文资料同步失败。",
              "runtime.data_integrity", "chapter_artifact_sync", chapter.id, chapter.order);
          }
          const refreshed = await prisma.chapter.findFirstOrThrow({where: {id: chapter.id, novelId}, include: {
            artifactSyncCheckpoints: {where: {artifactType: CHAPTER_ARTIFACT_BOUNDARY_TYPE, status: "succeeded"},
              select: {contentHash: true, metadataJson: true, artifactType: true}, orderBy: {updatedAt: "desc"}, take: 6},
          }});
          Object.assign(chapter, refreshed);
        }
        const chapters = options.skipCompleted
          ? chapterCandidates.filter((chapter) => !(runtimePayload.directorNext ? isCurrentV2ChapterProductionCompleted(chapter) : isCurrentChapterProductionCompleted(chapter)))
          : chapterCandidates;
        if (!novel) {
          throw new Error("任务执行失败：小说或章节不存在");
        }

        logPipelineInfo("任务加载完成", {
          jobId,
          novelId,
          title: novel.title,
          chapterCount: chapters.length,
        });

        const isAutopilotMode = Boolean(runtimePayload.directorNext)
          || runtimePayload.controlPolicy?.advanceMode === "full_book_autopilot";
        const autopilotTargetEndOrder = isAutopilotMode
          ? runtimePayload.directorNext ? options.endOrder : Math.max(options.endOrder, novel.estimatedChapterCount ?? options.endOrder)
          : options.endOrder;
        let totalCount = runtimePayload.directorNext
          ? options.endOrder - options.startOrder + 1
          : isAutopilotMode
          ? Math.max(1, autopilotTargetEndOrder - options.startOrder + 1)
          : Math.max(existingJob?.totalCount ?? 0, chapterCandidates.length, 1);
        const storedCompleted = runtimePayload.directorNext && runtimePayload.skipCompleted
          ? 0
          : Math.min(Math.max(existingJob?.completedCount ?? 0, 0), totalCount);
        const filteredCompletedCount = runtimePayload.skipCompleted
          ? chapterCandidates.length - chapters.length
          : 0;
        const remainingStartIndex = Math.min(
          Math.max(0, storedCompleted - filteredCompletedCount),
          chapters.length,
        );
        let completed = Math.max(storedCompleted, filteredCompletedCount);
        const chaptersToProcess = chapters.slice(remainingStartIndex);
        const closedOrders = new Set(chapterCandidates.filter(chapter => runtimePayload.directorNext ? isCurrentV2ChapterProductionCompleted(chapter) : isCurrentChapterProductionCompleted(chapter)).map(chapter => chapter.order));
        let pendingManualRecovery = false;
        let pendingManualRecoveryReason = "章节需要人工确认，后续生成已暂停。";

        if (runtimePayload.directorNext) {
          await this.updateJobRequired(jobId, {
            totalCount, completedCount: completed,
            progress: Number((completed / totalCount).toFixed(4)),
          });
        }

        const routeWindowService = new ChapterRouteWindowService();
        const prepareRollingChapter = async (order: number, previous?: { id: string; order: number }, cached?: (typeof chapterCandidates)[number]) => {
          await checkCancelled();
          try {
            await routeWindowService.ensureRouteWindow(novelId, order, {
              min: 3, target: 5,
              provider: runtimePayload.provider, model: runtimePayload.model, temperature: runtimePayload.temperature,
              taskId: runtimePayload.workflowTaskId ?? jobId,
              completionProfile: buildDirectorCompletionProfile(novel.estimatedChapterCount ?? autopilotTargetEndOrder),
            });
          } catch (error) {
            throw new PipelineIssueFailure(`滚动规划未能准备第 ${order} 章，已保存正文会保留，请检查后继续。`,
              "planning.route_window_unavailable", "route_window", previous?.id, previous?.order);
          }
          if (cached) return cached;
          const prepared = await prisma.chapter.findFirst({
            where: { novelId, order }, orderBy: { order: "asc" },
            include: { artifactSyncCheckpoints: {
              where: { artifactType: CHAPTER_ARTIFACT_BOUNDARY_TYPE, status: "succeeded" },
              select: { contentHash: true, metadataJson: true, artifactType: true }, orderBy: { updatedAt: "desc" }, take: 6,
            } },
          });
          if (!prepared) {
            throw new PipelineIssueFailure(`滚动规划未能准备第 ${order} 章，已保存正文会保留，请检查后继续。`,
              "planning.route_window_unavailable", "route_window", previous?.id, previous?.order);
          }
          return prepared;
        };
        if (isAutopilotMode && runtimePayload.directorNext) {
          let nextOrder = options.startOrder;
          while (closedOrders.has(nextOrder)) nextOrder++;
          if (nextOrder <= autopilotTargetEndOrder && chaptersToProcess[0]?.order !== nextOrder) {
            chaptersToProcess.unshift(await prepareRollingChapter(nextOrder));
          }
        }
        if (isAutopilotMode) {
          await this.updateJobSafe(jobId, {
            endOrder: autopilotTargetEndOrder,
            totalCount,
          });
        }

        for (let chapterIndex = 0; chapterIndex < chaptersToProcess.length; chapterIndex++) {
          const chapter = chaptersToProcess[chapterIndex];
          await checkCancelled();

          let chapterResult: Awaited<ReturnType<ChapterRuntimeCoordinator["runPipelineChapter"]>> | null = null;
          const savedUsage = runtimePayload.directorNext?.chapterUsage?.find(row => row.chapterId === chapter.id);
          const manualRevision = manuallyEditedChapterIds.has(chapter.id);
          let recoveringSavedQuality = savedUsage?.endJobTokens !== undefined || manualRevision;
          if (recoveringSavedQuality) {
            try {
              if (savedUsage?.endJobTokens !== undefined) {
                if (savedUsage.chapterOrder !== chapter.order) throw new Error("章节用量检查点身份不一致。");
                const usage = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId }, select: { totalTokens: true } });
                observeChapterUsage(runtimePayload.directorNext!, chapter.id, usage.totalTokens);
              }
              chapterResult = await recoverSavedChapterQuality(novelId, chapter, {manualRevision, provider: runtimePayload.provider, model: runtimePayload.model, temperature: runtimePayload.temperature});
            } catch (error) {
              /**
               * 正文在、检查结果不在（修文后中断、旧任务留下的正文）时，继续的语义是
               * 「重跑这一章的检查」，不是把用户挡在「请核对章节内容后继续」上——
               * 否则这一章永远拿不到检查结果，只能靠人工改正文解锁。
               * 顺带重置本章的检查重试预算：旧计数属于上一版正文，沿用会让重跑连一次检查都跑不起来。
               */
              if (runtimePayload.directorNext
                && error instanceof SavedChapterQualityRecoveryError
                && error.issueCode === "runtime.data_integrity") {
                await resetChapterReviewRetryBudget({ novelId, chapterId: chapter.id, executionId: jobId });
                /**
                 * 本章要在本作业里重新检查，旧用量检查点必须一起退役：
                 * 它已闭合（endJobTokens 有值），beginChapterUsage 会以「用量已闭合」直接拒绝，
                 * 于是「继续」最后还是停在同一条报错上。清掉后从当前作业用量重新开一段。
                 */
                runtimePayload.directorNext.chapterUsage = (runtimePayload.directorNext.chapterUsage ?? [])
                  .filter(row => row.chapterId !== chapter.id);
                recoveringSavedQuality = false;
                logPipelineWarn("保存进度缺少可复用的检查结果，改为重跑本章检查", {
                  jobId,
                  order: chapter.order,
                  reason: error.message,
                });
                chapterResult = null;
              } else {
                throw new PipelineIssueFailure(error instanceof Error ? error.message : "章节保存进度无法核验。",
                  error instanceof SavedChapterQualityRecoveryError ? error.issueCode : "runtime.data_integrity",
                  "chapter_usage", chapter.id, chapter.order);
              }
            }
          }

          const checkChapterBudget = async (closed = false, reserveTokens = 0, stage: DirectorChapterBudgetStage | null = null) => {
            if (!runtimePayload.directorNext) return;
            const usage = await readChapterUsageCounters(jobId);
            let initialized: boolean;
            let observed: ReturnType<typeof observeChapterUsage>;
            try {
              initialized = beginChapterUsage(runtimePayload.directorNext, chapter.id, chapter.order, usage.job, usage.batch);
              observed = closed
                ? finalizeChapterUsage(runtimePayload.directorNext, chapter.id, usage.job, usage.batch)
                : observeChapterUsage(runtimePayload.directorNext, chapter.id, usage.job, usage.batch);
            } catch (error) {
              throw new PipelineIssueFailure(error instanceof Error ? error.message : "章节用量记录异常，不能继续生成。",
                "runtime.data_integrity", "chapter_usage", chapter.id, chapter.order);
            }
            const row = runtimePayload.directorNext.chapterUsage!.find(item => item.chapterId === chapter.id)!;
            const normalizedReserve = Math.max(0, Math.floor(reserveTokens));
            const paused = pauseChapterBudget(row, normalizedReserve, stage);
            if (initialized || closed || paused) {
              try {
                await this.updateJobRequired(jobId, {
                  ...(closed ? { completedCount: completed + 1, progress: Number(((completed + 1) / totalCount).toFixed(4)) } : {}),
                  payload: this.stringifyPipelinePayload({ ...runtimePayload, qualityAlertDetails, replanAlertDetails, recoverableRepairDetails }),
                });
              } catch (error) {
                if (error instanceof PipelineExecutionLeaseLostError) throw error;
                throw new PipelineIssueFailure("章节用量检查点无法确认已保存，生成已停止。",
                  "runtime.persistence_failed", "chapter_usage", chapter.id, chapter.order);
              }
            }
            if (paused) {
              const budget = chapterBudgetView(jobId, row);
              const unit = budget.metric === "uncached_tokens_v1" ? "有效 Tokens" : "Tokens";
              const message = observed.exceeded
                ? `第${chapter.order}章累计 AI 用量达到 ${budget.usedTokens} ${unit}，本章上限 ${budget.tokenLimit}，${closed ? "正文已保存，" : ""}请从导演台调整本章额度后继续。`
                : `第${chapter.order}章当前已用 ${budget.usedTokens} ${unit}，下一步预留 ${normalizedReserve} Tokens 后将接近本章上限 ${budget.tokenLimit}，${closed ? "正文已保存，" : ""}请从导演台调整本章额度后继续。`;
              throw new PipelineIssueFailure(message,
                "runtime.token_budget_exceeded", "chapter_usage", chapter.id, chapter.order);
            }
          };
          if (!recoveringSavedQuality) await checkChapterBudget();

          let shouldStopAfterCurrentChapter = false;
          let chapterStopAction: "pause_for_manual" | "fail_task" | null = null;
          const currentItemLabel = buildPipelineCurrentItemLabel({
            completedCount: completed,
            totalCount,
            chapterOrder: chapter.order,
            title: chapter.title,
          });
          let activeStage: PipelineActiveStage = "generating_chapters";
          const applyChapterStage = async (stage: PipelineActiveStage) => {
            activeStage = stage;
            await this.updateJobSafe(jobId, {
              heartbeatAt: new Date(),
              currentStage: stage,
              currentItemKey: chapter.id,
              currentItemLabel,
              progress: buildPipelineStageProgress({
                completedCount: completed,
                totalCount,
                stage,
              }),
            });
          };

          await applyChapterStage(recoveringSavedQuality ? "reviewing" : "generating_chapters");
          logPipelineInfo("开始处理章节", {
            jobId,
            chapterId: chapter.id,
            order: chapter.order,
            hasDraft: Boolean((chapter.content ?? "").trim()),
          });

          const heartbeatTimer = setInterval(() => {
            void this.updateJobSafe(jobId, {
              heartbeatAt: new Date(),
              currentStage: activeStage,
              currentItemKey: chapter.id,
              currentItemLabel,
              progress: buildPipelineStageProgress({
                completedCount: completed,
                totalCount,
                stage: activeStage,
              }),
            }).catch(() => undefined);
          }, PIPELINE_HEARTBEAT_INTERVAL_MS);
          heartbeatTimer.unref?.();

          const chapterRetryBudget = Math.min(runtimePayload.maxRetries ?? maxRetries,
            issueGovernance?.policy.maxAutomaticRetries ?? maxRetries);
          let chapterRetryCountUsed = 0;
          let previouslyConsumed = 0;
          /**
           * 机械项清算轮次。
           *
           * sepia 的「FAIL 必须清零」需要复跑到清零，而普通章节重试预算通常只有 1。
           * 这里给机械项单独 2 轮额度（合计最多 3 轮修文），不挤占其他质量修复的预算；
           * 用尽后照样停，不会无限追。
           */
          let sepiaMechanicalRoundsUsed = 0;
          const claimAttempt = async (
            kind: "quality_repair" | "runtime_retry",
            details?: { mechanicalOnly?: boolean },
          ) => {
            await checkCancelled();
            if (chapterRetryCountUsed >= chapterRetryBudget) {
              if (details?.mechanicalOnly && sepiaMechanicalRoundsUsed < SEPIA_MECHANICAL_EXTRA_ROUNDS) {
                sepiaMechanicalRoundsUsed += 1;
                return true;
              }
              return false;
            }
            const claimed = await this.automaticAttempts.claim(jobId, chapter.id, kind);
            chapterRetryCountUsed = 1;
            if (claimed) {
              await this.updateJobRequired(jobId, { retryCount: totalRetryCount + 1 });
            }
            return claimed;
          };
          try {
            previouslyConsumed = chapterRetryCountUsed = await this.automaticAttempts.used(jobId, chapter.id);
            /**
             * 人工恢复要重新拿回额度。
             *
             * resume 复用同一个 jobId，而自动处理额度按 jobId+chapterId 唯一：上次用尽后，
             * 继续时 `maxRetries` 恒为 0，只评一次、不修文，用户看到的就是「点继续没反应」。
             * 只有「上次确实消耗过、且这一章仍停在待修」才重置——正常首次执行不受影响。
             */
            if (previouslyConsumed > 0) {
              const pending = await prisma.chapter.findFirst({
                where: { id: chapter.id, novelId },
                select: { chapterStatus: true, generationState: true },
              });
              const needsRepair = pending?.chapterStatus === "needs_repair"
                || pending?.generationState === "reviewed";
              if (needsRepair) {
                await this.automaticAttempts.reset(jobId, chapter.id);
                await resetChapterReviewRetryBudget({ novelId, chapterId: chapter.id, executionId: jobId });
                chapterRetryCountUsed = 0;
                previouslyConsumed = 0;
                logPipelineInfo("人工恢复：已重置本章自动处理额度", {
                  jobId, chapterId: chapter.id, order: chapter.order,
                });
              }
            }
            const reviewRetryBudget = createPersistedChapterReviewRetryBudget({ novelId, chapterId: chapter.id,
              executionId: jobId, policy: resolveChapterReviewRetryPolicy(issueGovernance?.policy),
              beforeRequest: async () => { await checkCancelled(); await checkChapterBudget(false, DIRECTOR_CHAPTER_PREFLIGHT_RESERVE_TOKENS, "review"); } });
            while (!chapterResult) {
              try {
                await checkCancelled();
                await checkChapterBudget();
                chapterResult = await withChapterReviewRetryBudget(reviewRetryBudget, () => this.chapterRuntimeCoordinator.runPipelineChapter(
                  novelId,
                  chapter.id,
                  {
                    provider: runtimePayload.provider,
                    model: runtimePayload.model,
                    temperature: runtimePayload.temperature,
                    workflowTaskId: runtimePayload.workflowTaskId,
                    taskStyleProfileId: runtimePayload.taskStyleProfileId,
                    styleSignalPolicy: runtimePayload.styleSignalPolicy,
                    controlPolicy: runtimePayload.controlPolicy,
                    maxRetries: Math.max(0, chapterRetryBudget - chapterRetryCountUsed),
                    autoReview: runtimePayload.autoReview,
                    autoRepair: runtimePayload.autoRepair,
                    qualityThreshold,
                    repairMode: runtimePayload.repairMode,
                    artifactSyncMode: runtimePayload.artifactSyncMode,
                    ...(runtimePayload.directorNext ? {artifactSyncPolicy: "director_v2" as const, finalizedResultScope: jobId, directorRunId: runtimePayload.directorNext.runId} : {}),
                  },
                  {
                  onCheckCancelled: checkCancelled,
                  onCheckBudget: (reserveTokens = DIRECTOR_CHAPTER_PREFLIGHT_RESERVE_TOKENS, stage) => checkChapterBudget(false, reserveTokens, stage),
                  onStageChange: async (stage) => {
                    await applyChapterStage(stage);
                  },
                  onRetryConsumed: (_kind, details) => claimAttempt("quality_repair", details),
                  onEmptyContent: async (event) => {
                    const willRetry = event.willRetry || (isAutopilotMode && chapterRetryCountUsed < chapterRetryBudget);
                    const detail = buildEmptyChapterDetail(chapter);
                    const meta = {
                      jobId,
                      workflowTaskId: runtimePayload.workflowTaskId,
                      novelId,
                      chapterId: chapter.id,
                      chapterOrder: chapter.order,
                      provider: runtimePayload.provider,
                      model: runtimePayload.model,
                      runMode: runtimePayload.runMode,
                      emptyAttempt: event.attempt,
                      willRetry,
                      contentLength: event.contentLength,
                      rawContentLength: event.rawContentLength,
                      source: event.error.details.source,
                    };
                    if (willRetry) {
                      logPipelineWarn("章节生成未返回正文，正在重试当前章", meta);
                      return;
                    }
                    if (!qualityAlertDetails.includes(detail)) {
                      qualityAlertDetails.push(detail);
                    }
                    logPipelineError("章节生成连续未返回正文，准备自动重试当前章", meta);
                  },
                  },
                ));
                break;
              } catch (error) {
                if (error instanceof ReviewRetryPersistenceError) {
                  throw new PipelineIssueFailure(error.message, "runtime.data_integrity", "chapter_review", chapter.id, chapter.order);
                }
                if (runtimePayload.directorNext && error instanceof ChapterArtifactSyncBoundaryError && error.result.characterReviewId) {
                  await checkCancelled();
                  runtimePayload.directorNext.pendingCharacterReviewId = error.result.characterReviewId;
                  await this.updateJobRequired(jobId, {status: "queued", pendingManualRecovery: true,
                    error: error.message, payload: this.stringifyPipelinePayload(runtimePayload)});
                  throw new PipelineIssueAppliedError(error.message, "pause_for_manual");
                }
                if (runtimePayload.directorNext && error instanceof ChapterArtifactSyncBoundaryError) {
                  throw new PipelineIssueFailure(error.message, "runtime.data_integrity", "chapter_artifact_sync", chapter.id, chapter.order);
                }
                if (error instanceof PipelineIssueFailure && error.stage === "chapter_usage") throw error;
                if (error instanceof PipelineExecutionLeaseLostError) {
                  throw error;
                }
                if (error instanceof Error && error.message === "PIPELINE_CANCELLED") {
                  throw error;
                }
                const message = error instanceof Error ? error.message : `第${chapter.order}章运行失败。`;
                const canOfferGovernedRetry = !(error instanceof ChapterContentPersistenceError)
                  && isAutopilotMode
                  && chapterRetryCountUsed < chapterRetryBudget;
                const action = await applyGovernedIssue({
                  issueCode: error instanceof ChapterContentPersistenceError
                    ? "runtime.persistence_failed"
                    : isChapterEmptyContentError(error)
                      ? "generation.empty_content"
                      : resolvePipelineRuntimeIssueCode(error),
                  stage: error instanceof ChapterContentPersistenceError
                    ? "chapter_persistence"
                    : "chapter_generation",
                  summary: error instanceof ChapterContentPersistenceError
                    ? `第${chapter.order}章正文无法确认已保存，已停止自动重试。`
                    : message,
                  evidence: error instanceof Error ? error.stack : undefined,
                  chapterId: chapter.id,
                  chapterOrder: chapter.order,
                  attempt: canOfferGovernedRetry
                    ? chapterRetryCountUsed
                    : issueGovernance?.policy.maxAutomaticRetries ?? chapterRetryCountUsed,
                  onRetry: canOfferGovernedRetry
                    ? async () => {
                        if (!(await claimAttempt("runtime_retry"))) {
                          throw new Error("本章自动处理额度已被使用，请从保存位置继续处理。");
                        }
                        const retryLabel = `第${chapter.order}章遇到临时问题，AI 正在自动修复并重试（${chapterRetryCountUsed}/${chapterRetryBudget}）`;
                        await this.updateJobRequired(jobId, {
                          heartbeatAt: new Date(),
                          currentStage: "generating_chapters",
                          currentItemKey: chapter.id,
                          currentItemLabel: retryLabel,
                        });
                      }
                    : undefined,
                });
                if (action && action !== "auto_retry") {
                  throw new PipelineIssueAppliedError(message, action);
                }
                const canRetry = action === "auto_retry"
                  || (
                    !issueGovernance
                    && !(error instanceof ChapterContentPersistenceError)
                    && isAutopilotMode
                    && chapterRetryCountUsed < chapterRetryBudget
                  );
                if (!canRetry) {
                  throw error;
                }
                if (!action) {
                  if (!(await claimAttempt("runtime_retry"))) throw error;
                }
                const retryLabel = `第${chapter.order}章遇到临时问题，AI 正在自动修复并重试（${chapterRetryCountUsed}/${chapterRetryBudget}）`;
                if (!action) {
                  await this.updateJobSafe(jobId, {
                    heartbeatAt: new Date(),
                    currentStage: "generating_chapters",
                    currentItemKey: chapter.id,
                    currentItemLabel: retryLabel,
                  });
                }
                logPipelineWarn("章节运行时失败，自动重试当前章", {
                  jobId,
                  novelId,
                  chapterId: chapter.id,
                  chapterOrder: chapter.order,
                  retry: chapterRetryCountUsed,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          } finally {
            clearInterval(heartbeatTimer);
          }
          if (!chapterResult) {
            throw new Error(`第${chapter.order}章在自动重试后仍未生成可用结果。`);
          }

          totalRetryCount += Math.max(0, chapterRetryCountUsed - previouslyConsumed);
          const closure = await applyChapterQualityClosure({
            governance: issueGovernance,
            workflowTaskId: runtimePayload.workflowTaskId,
            novelId,
            jobId,
            chapter: { id: chapter.id, order: chapter.order },
            chapterResult,
            authorRevision: manualRevision,
            qualityThreshold,
            runtimePayload,
            qualityAlertDetails,
            replanAlertDetails,
            recoverableRepairDetails,
            runLocalReplan: (replan) => plannerService.replan(novelId, {
              ...replan,
              provider: runtimePayload.provider,
              model: runtimePayload.model,
              temperature: runtimePayload.temperature,
            }),
            onIssueDecision: decision => {runtimePayload.directorNext?.decisions.push({...decision, chapterOrder: chapter.order});},
            // Persist local quality facts before freezing/pausing, while future
            // planning remains outside the saved chapter's token boundary.
            beforeFuturePlanning: recoveringSavedQuality ? undefined : () => checkChapterBudget(true),
          });
          shouldStopAfterCurrentChapter = closure.shouldStopAfterCurrentChapter;
          chapterStopAction = closure.stopAction;

          // Phase 3：同步补齐下一段章节路线；正文执行合同仍由下一章 JIT 独立生成。
          if (!shouldStopAfterCurrentChapter && isAutopilotMode && chapter.order < autopilotTargetEndOrder) {
            let nextOrder = chapter.order + 1;
            if (runtimePayload.skipCompleted) while (closedOrders.has(nextOrder)) nextOrder++;
            if (nextOrder <= autopilotTargetEndOrder) {
              const cached = chaptersToProcess[chapterIndex + 1];
              const prepared = await prepareRollingChapter(nextOrder, chapter, cached?.order === nextOrder ? cached : undefined);
              if (cached?.order !== prepared.order) {
                chaptersToProcess.splice(chapterIndex + 1, 0, prepared);
              }
            }
          }

          completed += 1;
          await this.updateJobSafe(jobId, {
            completedCount: completed,
            progress: Number((completed / totalCount).toFixed(4)),
            retryCount: totalRetryCount,
            heartbeatAt: new Date(),
            payload: this.stringifyPipelinePayload({
              ...runtimePayload,
              qualityAlertDetails,
              replanAlertDetails,
              recoverableRepairDetails,
            }),
          });
          logPipelineInfo("任务进度更新", {
            jobId,
            completed,
            total: totalCount,
            progress: Number((completed / totalCount).toFixed(4)),
            retryCount: totalRetryCount,
          });
          if (chapterStopAction === "fail_task") {
            const failureMessage = `第${chapter.order}章质量问题已按任务规则结束本次流水线。`;
            await this.updateJobRequired(jobId, {
              status: "failed",
              pendingManualRecovery: false,
              error: failureMessage,
              heartbeatAt: null,
              currentStage: null,
              currentItemKey: chapter.id,
              currentItemLabel: currentItemLabel,
              cancelRequestedAt: null,
              finishedAt: new Date(),
              payload: this.stringifyPipelinePayload({
                ...runtimePayload,
                qualityAlertDetails,
                replanAlertDetails,
                recoverableRepairDetails,
              }),
            });
            throw new PipelineIssueAppliedError(failureMessage, "fail_task");
          }
          if (shouldStopAfterCurrentChapter) {
            pendingManualRecovery = true;
            if (chapterResult.reviewRetries?.exhausted) pendingManualRecoveryReason = `第${chapter.order}章检查重试已用 ${chapterResult.reviewRetries.used}/${chapterResult.reviewRetries.maxRetries} 次，正文已保留，请从小说工作台确认后继续。`;
            logPipelineWarn("章节需要人工处理，已暂停后续章节流水线", {
              jobId,
              order: chapter.order,
              remaining: Math.max(0, totalCount - completed),
            });
            break;
          }
        }

        if (pendingManualRecovery) {
          await this.updateJobSafe(jobId, {
            status: "queued",
            pendingManualRecovery: true,
            error: pendingManualRecoveryReason,
            heartbeatAt: null,
            currentStage: "queued",
            currentItemKey: null,
            currentItemLabel: null,
            cancelRequestedAt: null,
            finishedAt: null,
            payload: this.stringifyPipelinePayload({
              ...runtimePayload,
              qualityAlertDetails,
              replanAlertDetails,
              recoverableRepairDetails,
            }),
          });
          return;
        }

        const finalStatus: "succeeded" = "succeeded";
        await this.updateJobSafe(jobId, {
          heartbeatAt: new Date(),
          currentStage: "finalizing",
          currentItemKey: null,
          currentItemLabel: "正在收尾章节流水线任务",
          progress: buildPipelineStageProgress({
            completedCount: completed,
            totalCount,
            stage: "finalizing",
          }),
        });
        await this.updateJobSafe(jobId, {
          status: finalStatus,
          progress: 1,
          error: null,
          heartbeatAt: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          cancelRequestedAt: null,
          finishedAt: new Date(),
          payload: this.stringifyPipelinePayload({
            ...runtimePayload,
            qualityAlertDetails,
            replanAlertDetails,
            recoverableRepairDetails,
          }),
        });
        logPipelineInfo("任务执行结束", {
          jobId,
          status: finalStatus,
          qualityAlertCount: qualityAlertDetails.length,
        });
        void novelEventBus.emit({
          type: "pipeline:completed",
          payload: { novelId, jobId, status: finalStatus },
        }).catch(() => {});
      });
    } catch (error) {
      if (error instanceof PipelineExecutionLeaseLostError) {
        logPipelineWarn("任务执行租约已转移，旧执行者停止写入", { jobId, novelId });
        return;
      }
      if (error instanceof PipelineIssueAppliedError) {
        const log = runtimePayload.directorNext?.pendingCharacterReviewId ? logPipelineInfo : logPipelineError;
        log(runtimePayload.directorNext?.pendingCharacterReviewId ? "等待用户确认本章人物" : "任务已按问题策略结束当前执行", {
          jobId,
          novelId,
          action: error.action,
          message: error.message,
        });
        if (error.action === "fail_task") {
          void novelEventBus.emit({
            type: "pipeline:completed",
            payload: { novelId, jobId, status: "failed" },
          }).catch(() => {});
        }
        return;
      }
      if (error instanceof Error && error.message === "PIPELINE_CANCELLED") {
        await this.updateJobSafe(jobId, {
          status: "cancelled",
          heartbeatAt: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          cancelRequestedAt: null,
          finishedAt: new Date(),
          payload: this.stringifyPipelinePayload({
            ...runtimePayload,
            qualityAlertDetails,
            replanAlertDetails,
            recoverableRepairDetails,
          }),
        }, "cancelled");
        void novelEventBus.emit({
          type: "pipeline:completed",
          payload: { novelId, jobId, status: "cancelled" },
        }).catch(() => {});
        return;
      }

      if (runtimePayload.directorNext && error instanceof ChapterArtifactSyncBoundaryError && error.result.characterReviewId) {
        runtimePayload.directorNext.pendingCharacterReviewId = error.result.characterReviewId;
        await this.updateJobRequired(jobId, {status: "queued", pendingManualRecovery: true,
          error: error.message, payload: this.stringifyPipelinePayload(runtimePayload)});
        return;
      }
      const message = error instanceof Error ? error.message : "流水线执行失败";
      if (isChapterEmptyContentError(error)) {
        logPipelineError("任务因章节空正文失败", {
          jobId,
          novelId,
          provider: runtimePayload.provider,
          model: runtimePayload.model,
          runMode: runtimePayload.runMode,
          workflowTaskId: runtimePayload.workflowTaskId,
          source: error.details.source,
          contentLength: error.details.trimmedLength,
          rawContentLength: error.details.rawLength,
        });
      }
      const governedAction = await applyGovernedIssue({
        issueCode: error instanceof PipelineIssueFailure
          ? error.issueCode
          : error instanceof ChapterArtifactSyncBoundaryError
            ? "runtime.data_integrity"
          : error instanceof ChapterContentPersistenceError
            ? "runtime.persistence_failed"
            : isChapterEmptyContentError(error)
              ? "generation.empty_content"
              : resolvePipelineRuntimeIssueCode(error),
        stage: error instanceof PipelineIssueFailure
          ? error.stage
          : error instanceof ChapterContentPersistenceError
            ? "chapter_persistence"
            : "chapter_execution",
        summary: message,
        evidence: error instanceof Error ? error.stack : undefined,
        chapterId: error instanceof PipelineIssueFailure ? error.chapterId : undefined,
        chapterOrder: error instanceof PipelineIssueFailure ? error.chapterOrder : undefined,
        attempt: issueGovernance?.policy.maxAutomaticRetries ?? maxRetries,
      });
      if (governedAction) {
        logPipelineError("任务已按问题策略收束", {
          jobId,
          novelId,
          action: governedAction,
          message,
        });
        if (governedAction === "fail_task") {
          void novelEventBus.emit({
            type: "pipeline:completed",
            payload: { novelId, jobId, status: "failed" },
          }).catch(() => {});
        }
        return;
      }
      await this.updateJobSafe(jobId, {
        status: "failed",
        error: message,
        finishedAt: new Date(),
        payload: this.stringifyPipelinePayload({
          ...runtimePayload,
          qualityAlertDetails,
          replanAlertDetails,
          recoverableRepairDetails,
        }),
      });
      logPipelineError("任务执行异常", {
        jobId,
        novelId,
        message,
      });
      void novelEventBus.emit({
        type: "pipeline:completed",
        payload: { novelId, jobId, status: "failed" },
      }).catch(() => {});
    }
  }
}
