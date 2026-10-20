import type { PipelinePayload } from "../../novelCoreShared";
import { logPipelineError, logPipelineWarn } from "../../novelCoreShared";
import { createQualityReport } from "../../novelCoreReviewService";
import { chapterQualityLoopService } from "../../quality/ChapterQualityLoopService";
import type { ChapterRuntimeCoordinator } from "../../runtime/ChapterRuntimeCoordinator";
import type { DirectorIssueTaskContext } from "../../director/issues";
import { reportPipelineIssue } from "../issueGovernance/PipelineIssueGovernance";
import type { ReplanResult } from "@ai-novel/shared/types/novel";
import { resolveDirectorIssueDecision, type DirectorIssueDecision } from "@ai-novel/shared/types/directorIssue";

type ChapterPipelineResult = Awaited<ReturnType<ChapterRuntimeCoordinator["runPipelineChapter"]>>;
type ChapterQualityStopAction = Extract<DirectorIssueDecision["action"], "pause_for_manual" | "fail_task">;

const SEPIA_BLOCKING_TAG = "sepia_blocking";
const SEPIA_UNAVAILABLE_TAG = "sepia_gate_unavailable";
/** 与 `sepia/selfcheck/sepiaSelfCheck.ts` 同源；见 selection 层同名常量的说明 */
const SEPIA_SELFCHECK_FAIL_PREFIX = "sepia_selfcheck:fail";

/**
 * sepia 两级门的判定只看确定性标记，不看 LLM 验收结论：
 * `sepia_blocking:N` 是机械报告里的真实条数（数组会被截断/去重，不能数数组），
 * `sepia_selfcheck:fail:N` 是结构自检的未过项数，
 * `sepia_gate_unavailable` 表示机械门没跑成——没跑成不等于通过。
 *
 * 自检没跑成（`sepia_selfcheck_unavailable`）不在这里算阻断：它是额外一次 LLM 调用，
 * 网络抖动不该让整章停摆；但报告里要看得到"这章没跑自检"，所以单独返回一个标记。
 */
function readSepiaGateVerdict(
  runtimePackage: ChapterPipelineResult["runtimePackage"],
): {blocked: boolean; blocking: number; selfCheck: number; unavailable: boolean; selfCheckUnavailable: boolean; evidence: string} {
  let blocking = 0;
  let selfCheck = 0;
  let unavailable = false;
  let selfCheckUnavailable = false;
  const tags = runtimePackage?.meta?.riskTags ?? [];
  for (const tag of tags) {
    if (tag === SEPIA_UNAVAILABLE_TAG) {
      unavailable = true;
      continue;
    }
    if (tag === "sepia_selfcheck_unavailable") {
      selfCheckUnavailable = true;
      continue;
    }
    if (tag === SEPIA_BLOCKING_TAG) {
      blocking = Math.max(blocking, 1);
      continue;
    }
    if (!tag.startsWith(`${SEPIA_BLOCKING_TAG}:`)) {
      if (tag.startsWith(`${SEPIA_SELFCHECK_FAIL_PREFIX}:`)) {
        const parsed = Number.parseInt(tag.slice(SEPIA_SELFCHECK_FAIL_PREFIX.length + 1), 10);
        if (Number.isFinite(parsed)) selfCheck = Math.max(selfCheck, parsed);
      }
      continue;
    }
    const parsed = Number.parseInt(tag.slice(SEPIA_BLOCKING_TAG.length + 1), 10);
    if (Number.isFinite(parsed)) blocking = Math.max(blocking, parsed);
  }
  const evidence = [
    `sepia_blocking=${blocking}`,
    `sepia_selfcheck=${selfCheck}`,
    ...(unavailable ? ["sepia_gate_unavailable=true"] : []),
    ...(selfCheckUnavailable ? ["sepia_selfcheck_unavailable=true"] : []),
    ...tags.filter(tag => tag.startsWith(`${SEPIA_BLOCKING_TAG}:`) || tag.startsWith(`${SEPIA_SELFCHECK_FAIL_PREFIX}:`)),
  ].join(", ");
  return {
    blocked: blocking > 0 || unavailable || selfCheck > 0,
    blocking,
    selfCheck,
    unavailable,
    selfCheckUnavailable,
    evidence,
  };
}

export async function applyChapterQualityClosure(input: {
  governance: DirectorIssueTaskContext | null;
  workflowTaskId?: string;
  novelId: string;
  jobId: string;
  chapter: { id: string; order: number };
  chapterResult: ChapterPipelineResult;
  /** A saved author revision also needs degraded closure if acceptance is unavailable. */
  authorRevision?: boolean;
  qualityThreshold: number;
  runtimePayload: PipelinePayload;
  qualityAlertDetails: string[];
  replanAlertDetails: string[];
  recoverableRepairDetails: string[];
  onIssueDecision?: (decision: DirectorIssueDecision) => void;
  beforeFuturePlanning?: () => Promise<void>;
  runLocalReplan: (input: {
    chapterId: string;
    triggerType: string;
    sourceIssueIds: string[];
    windowSize: number;
    reason: string;
  }) => Promise<ReplanResult>;
}): Promise<{
  shouldStopAfterCurrentChapter: boolean;
  stopAction: ChapterQualityStopAction | null;
}> {
  const { chapter, chapterResult, runtimePayload } = input;
  const final = { score: chapterResult.score, issues: chapterResult.issues };
  const replanRecommendation = chapterResult.runtimePackage?.replanRecommendation;
  // sepia 机械门是硬门：硬伤没清零、或门没能跑成，都不算「这章过了」。
  const sepiaGate = readSepiaGateVerdict(chapterResult.runtimePackage);
  // sepia 未过门时不留 defer_and_continue：否则质量闭环会把本章记成「已完成」，
  // 恢复创作时被 skipCompleted 跳过，等于绕过门。留空则本章停在 needs_repair，
  // 恢复后重新走验收与 sepia 门，过了才继续。
  const qualityDebtTerminalAction = chapterResult.pass || replanRecommendation?.scope === "global_book" || sepiaGate.blocked
    ? null
    : "defer_and_continue" as const;
  const exhaustedAttempt = input.governance?.policy.maxAutomaticRetries ?? 0;
  let shouldStopAfterCurrentChapter = false;
  let stopAction: ChapterQualityStopAction | null = null;
  const applyDecision = async (decision: DirectorIssueDecision) => {
    input.onIssueDecision?.(decision);
    if (decision.action === "auto_retry") {
      throw new Error("章节质量闭环已耗尽本章自动处理预算，不能登记未执行的自动重试。");
    }
    if (decision.action === "pause_for_manual" || decision.action === "fail_task") {
      shouldStopAfterCurrentChapter = true;
      stopAction = decision.action;
    }
  };

  // sepia 机械门是硬门：硬伤没清零、或门没能跑成，都不算「这章过了」。
  // 停在本章边界等待处理，而不是记成质量债继续写下一章。
  if (sepiaGate.blocked) {
    const detail = sepiaGate.unavailable
      ? `第${chapter.order}章 sepia 机械门未能跑完，按「未过门」处理；正文已保留，请先在本章处理后再继续。`
      : sepiaGate.blocking > 0
        ? `第${chapter.order}章 sepia 机械门仍有 ${sepiaGate.blocking} 条硬伤未清零；正文已保留，请先在本章处理后再继续。`
        : `第${chapter.order}章 sepia 结构自检仍有 ${sepiaGate.selfCheck} 项未过；正文已保留，请先在本章处理后再继续。`;
    if (!input.qualityAlertDetails.includes(detail)) input.qualityAlertDetails.push(detail);
    logPipelineWarn("sepia 门未通过，已在本章边界暂停", {
      jobId: input.jobId,
      order: chapter.order,
      blocking: sepiaGate.blocking,
      selfCheck: sepiaGate.selfCheck,
      unavailable: sepiaGate.unavailable,
    });
    if (input.governance) {
      await reportPipelineIssue({
        governance: input.governance,
        workflowTaskId: input.workflowTaskId,
        novelId: input.novelId,
        jobId: input.jobId,
        issueCode: sepiaGate.blocking > 0 || sepiaGate.unavailable
          ? "quality.sepia_gate_blocked"
          : "quality.sepia_selfcheck_failed",
        stage: "chapter_review",
        summary: detail,
        evidence: sepiaGate.evidence,
        chapterId: chapter.id,
        chapterOrder: chapter.order,
        attempt: exhaustedAttempt,
        hasUsableOutput: true,
        provider: runtimePayload.provider,
        model: runtimePayload.model,
        temperature: runtimePayload.temperature,
        applyAction: applyDecision,
      });
    } else {
      await applyDecision(resolveDirectorIssueDecision({
        policy: { maxAutomaticRetries: 0, issueActions: {} },
        occurrence: {
          issueCode: sepiaGate.blocking > 0 || sepiaGate.unavailable
            ? "quality.sepia_gate_blocked"
            : "quality.sepia_selfcheck_failed",
          attempt: exhaustedAttempt,
          maxAttempts: 0,
          hasUsableOutput: true,
        },
      }));
    }
  }

  if (runtimePayload.autoReview && !chapterResult.reviewExecuted && !chapterResult.reviewRetries?.exhausted) {
    const detail = `第${chapter.order}章接收检查未能执行，正文已保留并等待后续复查。`;
    if (!input.qualityAlertDetails.includes(detail)) input.qualityAlertDetails.push(detail);
    await reportPipelineIssue({
      governance: input.governance,
      workflowTaskId: input.workflowTaskId,
      novelId: input.novelId,
      jobId: input.jobId,
      issueCode: "quality.acceptance_unavailable",
      stage: "chapter_review",
      summary: detail,
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      attempt: exhaustedAttempt,
      hasUsableOutput: true,
      provider: runtimePayload.provider,
      model: runtimePayload.model,
      temperature: runtimePayload.temperature,
      applyAction: applyDecision,
    });
  }

  if (chapterResult.recoverableRepairFailure && !chapterResult.reviewRetries?.exhausted) {
    input.recoverableRepairDetails.push(
      `第${chapter.order}章需要后续修复：${chapterResult.recoverableRepairFailure.message}`,
    );
    logPipelineWarn("章节局部修复未安全应用，已记录并继续后续章节", {
      jobId: input.jobId,
      order: chapter.order,
      reason: chapterResult.recoverableRepairFailure.message,
      failureTypes: chapterResult.recoverableRepairFailure.failureTypes,
    });
    await reportPipelineIssue({
      governance: input.governance,
      workflowTaskId: input.workflowTaskId,
      novelId: input.novelId,
      jobId: input.jobId,
      issueCode: "quality.local_repair_failed",
      stage: "chapter_repair",
      summary: chapterResult.recoverableRepairFailure.message,
      evidence: chapterResult.recoverableRepairFailure.failureTypes.join(", "),
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      attempt: exhaustedAttempt,
      hasUsableOutput: true,
      provider: runtimePayload.provider,
      model: runtimePayload.model,
      temperature: runtimePayload.temperature,
      applyAction: applyDecision,
    });
  }

  if (chapterResult.reviewExecuted) {
    await createQualityReport(input.novelId, chapter.id, final.score, final.issues);
  }
  if (chapterResult.reviewExecuted || runtimePayload.autoReview || input.authorRevision) {
    await chapterQualityLoopService.recordAssessment({
      novelId: input.novelId,
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      score: final.score,
      issues: final.issues,
      runtimePackage: chapterResult.runtimePackage,
      source: chapterResult.retryCountUsed > 0 ? "repair_recheck" : "pipeline_review",
      terminalAction: qualityDebtTerminalAction,
      taskId: input.workflowTaskId,
      qualityDebtAttribution: chapterResult.qualityDebtAttribution ?? null,
      repairSelection: chapterResult.repairSelection ?? null,
    }).catch((error) => {
      logPipelineError("记录章节质量闭环状态失败", {
        jobId: input.jobId,
        novelId: input.novelId,
        chapterId: chapter.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const retries = chapterResult.reviewRetries;
  if (retries?.exhausted && !chapterResult.pass && replanRecommendation?.scope !== "global_book") {
    const detail = `第${chapter.order}章检查重试已用 ${retries.used}/${retries.maxRetries} 次，正文已保留，${retries.onExhausted === "pause_for_manual" ? "等待确认后继续" : "检查未完成，继续后续章节"}。`;
    if (!input.qualityAlertDetails.includes(detail)) input.qualityAlertDetails.push(detail);
    const policy = { ...(input.governance?.policy ?? { maxAutomaticRetries: 0, issueActions: {} }),
      issueActions: { ...input.governance?.policy.issueActions, "quality.loop_exhausted": retries.onExhausted } };
    if (input.governance) {
      await reportPipelineIssue({ governance: { ...input.governance, policy }, workflowTaskId: input.workflowTaskId,
        novelId: input.novelId, jobId: input.jobId, issueCode: "quality.loop_exhausted", stage: "chapter_review_retry_exhausted",
        summary: detail, chapterId: chapter.id, chapterOrder: chapter.order, attempt: retries.used, hasUsableOutput: true,
        applyAction: applyDecision });
    } else {
      await applyDecision(resolveDirectorIssueDecision({ policy, occurrence: { issueCode: "quality.loop_exhausted",
        attempt: retries.used, maxAttempts: retries.maxRetries, hasUsableOutput: true } }));
    }
    await input.beforeFuturePlanning?.();
    return { shouldStopAfterCurrentChapter, stopAction };
  }

  if (chapterResult.reviewExecuted && !chapterResult.pass && !sepiaGate.blocked) {
    input.qualityAlertDetails.push(
      `第${chapter.order}章（coherence=${final.score.coherence}, repetition=${final.score.repetition}, engagement=${final.score.engagement}）`,
    );
    logPipelineWarn("章节最终未达标", {
      jobId: input.jobId,
      order: chapter.order,
      score: final.score,
    });
    await reportPipelineIssue({
      governance: input.governance,
      workflowTaskId: input.workflowTaskId,
      novelId: input.novelId,
      jobId: input.jobId,
      issueCode: "quality.chapter_below_threshold",
      stage: "chapter_review",
      summary: `第${chapter.order}章质量分未达到 ${input.qualityThreshold} 分。`,
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      attempt: exhaustedAttempt,
      qualityScores: {
        coherence: final.score.coherence,
        repetition: final.score.repetition,
        engagement: final.score.engagement,
        overall: final.score.overall,
      },
      hasUsableOutput: true,
      provider: runtimePayload.provider,
      model: runtimePayload.model,
      temperature: runtimePayload.temperature,
      applyAction: applyDecision,
    });
  }

  // Quality facts must survive a saved-boundary safety pause. This callback may
  // stop execution, but must run before any future-chapter model invocation.
  await input.beforeFuturePlanning?.();

  if (shouldStopAfterCurrentChapter) {
    return { shouldStopAfterCurrentChapter: true, stopAction };
  }

  if (!replanRecommendation?.recommended) {
    return { shouldStopAfterCurrentChapter: false, stopAction: null };
  }
  const impactedOrders = replanRecommendation.affectedChapterOrders?.length
    ? `影响章节=${replanRecommendation.affectedChapterOrders.join(",")}`
    : `锚点章节=${replanRecommendation.anchorChapterOrder ?? chapter.order}`;
  const detail = `第${chapter.order}章${replanRecommendation.scope === "global_book" ? "需要书级重规划" : "正在调整后续章节安排"}（${impactedOrders}；原因=${replanRecommendation.triggerReason ?? replanRecommendation.reason}）`;
  if (replanRecommendation.scope !== "global_book") {
    try {
      const result = await input.runLocalReplan({
        chapterId: chapter.id,
        triggerType: "chapter_quality_local_replan",
        sourceIssueIds: replanRecommendation.blockingIssueIds,
        windowSize: Math.max(1, replanRecommendation.affectedChapterOrders?.length ?? 3),
        reason: replanRecommendation.triggerReason ?? replanRecommendation.reason,
      });
      const plannedOrders = result.affectedChapterOrders.join(",") || "后续未完成章节";
      const completedDetail = `第${chapter.order}章已调整后续章节安排（已刷新=${plannedOrders}）。`;
      if (!input.qualityAlertDetails.includes(completedDetail)) input.qualityAlertDetails.push(completedDetail);
      return { shouldStopAfterCurrentChapter: false, stopAction: null };
    } catch (error) {
      const failureDetail = `第${chapter.order}章后续章节调整失败，已保留正文并继续：${error instanceof Error ? error.message : String(error)}`;
      if (!input.recoverableRepairDetails.includes(failureDetail)) input.recoverableRepairDetails.push(failureDetail);
      await reportPipelineIssue({
        governance: input.governance,
        workflowTaskId: input.workflowTaskId,
        novelId: input.novelId,
        jobId: input.jobId,
        issueCode: "quality.local_replan_failed",
        stage: "chapter_review",
        summary: failureDetail,
        evidence: replanRecommendation.reason,
        chapterId: chapter.id,
        chapterOrder: chapter.order,
        attempt: exhaustedAttempt,
        hasUsableOutput: true,
        provider: runtimePayload.provider,
        model: runtimePayload.model,
        temperature: runtimePayload.temperature,
        applyAction: applyDecision,
      });
      return { shouldStopAfterCurrentChapter, stopAction };
    }
  }
  if (replanRecommendation.action !== "stop_for_replan") {
    if (!input.qualityAlertDetails.includes(detail)) input.qualityAlertDetails.push(detail);
    return { shouldStopAfterCurrentChapter: false, stopAction: null };
  }
  await reportPipelineIssue({
    governance: input.governance,
    workflowTaskId: input.workflowTaskId,
    novelId: input.novelId,
    jobId: input.jobId,
    issueCode: "quality.replan_required",
    stage: "chapter_review",
    summary: detail,
    evidence: replanRecommendation.reason,
    chapterId: chapter.id,
    chapterOrder: chapter.order,
    attempt: exhaustedAttempt,
    hasUsableOutput: true,
    provider: runtimePayload.provider,
    model: runtimePayload.model,
    temperature: runtimePayload.temperature,
    applyAction: async decision => {
      input.onIssueDecision?.(decision);
      if (!input.replanAlertDetails.includes(detail)) input.replanAlertDetails.push(detail);
    },
  });
  if (!input.replanAlertDetails.includes(detail)) input.replanAlertDetails.push(detail);
  return { shouldStopAfterCurrentChapter: true, stopAction: "pause_for_manual" };
}
