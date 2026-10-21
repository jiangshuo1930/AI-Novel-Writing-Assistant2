import type { ChapterRuntimePackage, GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { ContentProvenance } from "@ai-novel/shared/types/canonicalState";
import type {DirectorChapterBudgetStage} from "@ai-novel/shared/types/director/chapterBudget";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import type { StyleRewriteBaseline, StyleRewriteGuard } from "@ai-novel/shared/types/styleEngine";
import type { ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import type { ChapterAcceptanceAssessmentResult } from "./ChapterAcceptanceAssessmentService";
import { currentChapterReviewRetryBudget, type ChapterReviewRetrySummary } from "./acceptance";
import {
  ChapterArtifactSyncBoundaryError,
  type ChapterArtifactSyncResult,
} from "./artifactSync/ChapterArtifactSyncResult";
import { detectForbiddenStyleEntities } from "../../styleEngine/styleGenerationSanitizer";
import {
  assertBlueprintGate,
  BlueprintGateBlockedError,
} from "../../sepia/blueprint/sepiaBlueprintGate";
import { ensureChapterTechniques } from "../../sepia/techniques/ensureChapterTechniques";
import {
  assertChapterContentNotEmpty,
  isChapterEmptyContentError,
  type ChapterEmptyContentError,
} from "./chapterEmptyContentError";
import { runChapterRepairText } from "./repair/chapterRepairRuntime";
import { shouldAttemptAutomaticRepair } from "./repair/ChapterRepairEligibility";
import { detectNewSevereProseFindings } from "./proseQuality";
import { ChapterPatchRepairFailedError } from "../chapterPatchRepairService";
import { SEPIA_ADVISORY_REPAIR_TAG } from "../../sepia/acceptance/sepiaAcceptance";
import {
  hasSepiaSelfCheckUnavailable,
  readSepiaAdvisoryCount,
  readSepiaBlockingCount,
  readSepiaSelfCheckFailCount,
  selectChapterRepairCandidate,
  type ChapterRepairSelectionRecord,
} from "./selection/ChapterRepairCandidateSelection";

// Keep a small headroom before each internal AI call so the outer usage counter
// can stop the pipeline before a large next response crosses the chapter limit.
const DIRECTOR_CHAPTER_PREFLIGHT_RESERVE_TOKENS = 16_000;

export type { ChapterRepairSelectionRecord } from "./selection/ChapterRepairCandidateSelection";

export interface PipelineRuntimeHooks {
  onCheckCancelled?: () => Promise<void>;
  /** Check the chapter budget before an internal AI step starts. */
  onCheckBudget?: (reserveTokens?: number, stage?: DirectorChapterBudgetStage) => Promise<void>;
  onStageChange?: (stage: "generating_chapters" | "reviewing" | "repairing") => Promise<void>;
  onEmptyContent?: (event: PipelineEmptyContentEvent) => Promise<void>;
  /**
   * 领取一次修文额度。返回 false 表示预算已用完。
   *
   * `mechanicalOnly` 表示这一轮只是为了清 sepia 机械项（破折号、禁用词、句式套子）。
   * 它不占用普通的章节重试预算——sepia 的纪律是「FAIL 必须清零」，
   * 预算为 1 时第二轮会被直接拒掉，机械项就永远清不干净。
   */
  onRetryConsumed?: (
    kind: "quality_repair",
    details?: { mechanicalOnly?: boolean },
  ) => Promise<void | boolean>;
}

export interface PipelineEmptyContentEvent {
  attempt: number;
  willRetry: boolean;
  error: ChapterEmptyContentError;
  contentLength: number;
  rawContentLength: number;
}

export interface PipelineRuntimeInput extends ChapterRuntimeRequestInput {
  /** Internal production policy, selected only by the V2 job owner. */
  artifactSyncPolicy?: "director_v2";
  directorRunId?: string;
  finalizedResultScope?: string;
  maxRetries?: number;
  autoReview?: boolean;
  autoRepair?: boolean;
  qualityThreshold?: number;
  repairMode?: "detect_only" | "light_repair" | "heavy_repair" | "continuity_only" | "character_only" | "ending_only";
}

/**
 * 质量债务根因归因数据，在章节以 defer_and_continue 结束时收集。
 * 用于 analyze_quality_debt_attribution 工具聚合根因占比。
 */
export interface QualityDebtAttribution {
  /** 本章实际发起的自动修复次数；修复返回可恢复失败也计入。 */
  repairAttemptsUsed: number;
  /** 本次章节执行允许的自动修复次数，当前合同只允许 0 或 1。 */
  repairAttemptsAllowed: number;
  /** 首次验收失败的 issue code 列表（来自 runtimePackage.audit.openIssues） */
  firstFailureIssueCodes: string[];
  /** 二次验收失败的 issue code 列表（修复后再次失败时才有值） */
  secondFailureIssueCodes: string[];
  /** 首次失败的 failureClassification.code（判定根因 D） */
  firstFailureClassificationCode: string | null;
  /** 历史 patch 锚点失配兼容字段；当前运行固定为 false。 */
  patchAnchorFailed: boolean;
  /** 首次与二次的 openIssue codes 完全一致（判定根因 A：义务未传达给修复器） */
  sameObligationRepeated: boolean;
  /** firstFailureClassificationCode === "draft_obligation_unmet" → 义务不可达（判定根因 D） */
  planMisaligned: boolean;
  /** 首次为 length 类 issue、二次为 content 类（判定根因 E：签名漂移） */
  lengthVsContentDrift: boolean;
  /** 首次失败缺失的义务种类（来自 obligationCoverage.missing[].kind） */
  missingObligationKinds: string[];
}

export interface PipelineRuntimeResult {
  reviewRetries?: ChapterReviewRetrySummary;
  reviewExecuted: boolean;
  pass: boolean;
  score: QualityScore;
  issues: ReviewIssue[];
  runtimePackage: ChapterRuntimePackage | null;
  retryCountUsed: number;
  recoverableRepairFailure?: PipelineRecoverableRepairFailure | null;
  repairSelection?: ChapterRepairSelectionRecord | null;
  artifactSyncResult?: ChapterArtifactSyncResult | null;
  /** 仅在章节最终未通过时填充，供 defer_and_continue 路径记录根因 */
  qualityDebtAttribution?: QualityDebtAttribution | null;
}

export interface FinalizedRuntimeResult {
  finalContent: string;
  runtimePackage: ChapterRuntimePackage;
  needsRepair: boolean;
  acceptanceResult?: ChapterAcceptanceAssessmentResult;
  acceptancePersistenceDeferred?: boolean;
}

export interface PipelineRecoverableRepairFailure {
  chapterId: string;
  message: string;
  repairMode: NonNullable<PipelineRuntimeInput["repairMode"]>;
  failureTypes: string[];
  occurredAt: string;
}

export interface AssembledRuntimeChapter {
  novel: { id: string; title: string };
  chapter: { id: string; title: string; order: number; content: string | null; expectation: string | null };
  contextPackage: GenerationContextPackage;
}

interface RunPipelineChapterDeps {
  loadFinalizedChapterResult?: (novelId: string, chapterId: string) => Promise<{content: string; result: PipelineRuntimeResult} | null>;
  persistFinalizedChapterResult?: (novelId: string, chapterId: string, content: string, result: PipelineRuntimeResult) => Promise<void>;
  validateRequest: (input: ChapterRuntimeRequestInput) => ChapterRuntimeRequestInput;
  ensureNovelCharacters: (novelId: string, actionName: string, minCount?: number) => Promise<void>;
  assemble: (novelId: string, chapterId: string, request: ChapterRuntimeRequestInput) => Promise<AssembledRuntimeChapter>;
  generateDraftFromWriter: (input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    assembled: AssembledRuntimeChapter;
  }) => Promise<{
    content: string;
    lengthControl?: ChapterRuntimePackage["lengthControl"];
    artifactsAlreadySynced?: boolean;
  }>;
  saveDraftAndArtifacts: (
    novelId: string,
    chapterId: string,
    content: string,
    generationState: "drafted" | "repaired",
    options?: { scheduleBackgroundSync?: boolean; artifactSyncMode?: PipelineRuntimeInput["artifactSyncMode"]; syncArtifacts?: boolean },
  ) => Promise<void>;
  syncFinalChapterArtifacts: (
    novelId: string,
    chapterId: string,
    content: string,
    options?: {
      artifactSyncMode?: PipelineRuntimeInput["artifactSyncMode"];
      contentProvenance?: ContentProvenance;
      artifactSyncPolicy?: "director_v2";
    },
  ) => Promise<ChapterArtifactSyncResult>;
  finalizeChapterContent: (input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    contextPackage: GenerationContextPackage;
    content: string;
    repairReviewBaseline?: Pick<ChapterAcceptanceAssessmentResult["assessment"],
      "blockingIssues" | "missingObligations" | "repairDirectives">;
    styleRewriteBaseline?: StyleRewriteBaseline;
    lengthControl?: ChapterRuntimePackage["lengthControl"];
    runId: string | null;
    startMs: number | null;
    assertExecutionOwnership?: () => Promise<void>;
  }) => Promise<FinalizedRuntimeResult>;
  commitFinalizedChapterContent: (input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    contextPackage: GenerationContextPackage;
    evaluation: FinalizedRuntimeResult;
    assertExecutionOwnership?: () => Promise<void>;
  }) => Promise<void>;
  markChapterGenerationState: (
    chapterId: string,
    generationState: "reviewed" | "approved",
  ) => Promise<void>;
  markChapterNeedsRepair: (chapterId: string) => Promise<void>;
}

const QUALITY_THRESHOLD = { coherence: 80, repetition: 75, engagement: 75 };
// Pipeline execution owns the single automatic retry budget. Keeping the
// writer attempt at zero avoids stacking a hidden empty-content retry on top.
const EMPTY_CONTENT_GENERATION_RETRY_LIMIT = 0;
const NON_PATCHABLE_REVIEW_ISSUE_CODES = new Set(["acceptance_gate_unavailable", "style_review_unavailable"]);
/**
 * sepia 机械门最多修几轮。
 *
 * 对应原版 SKILL.md：「跑校验，把 FAIL 项清零」「lint.py 复跑，FAIL 清零」。
 * 三轮是收敛上限，不是目标值——每轮都要求比上一轮少，没变少就停并保留最好的一版。
 */
const SEPIA_CONVERGENCE_MAX_ROUNDS = 3;
/** advisory 清理轮数上限（见循环内 `advisoryOnlyRounds` 的实测说明） */
const ADVISORY_ONLY_MAX_ROUNDS = 2;

/** 一版正文及其验收结果；多轮收敛时按这个粒度比较与回滚 */
interface ChapterEvaluationSnapshot {
  content: string;
  result: FinalizedRuntimeResult;
  issues: ReviewIssue[];
  pass: boolean;
}

const AUDIT_CATEGORY_MAP: Record<"continuity" | "character" | "plot" | "mode_fit", ReviewIssue["category"]> = {
  continuity: "coherence",
  character: "logic",
  plot: "pacing",
  mode_fit: "coherence",
};

export async function runPipelineChapterWithRuntime(
  deps: RunPipelineChapterDeps,
  novelId: string,
  chapterId: string,
  options: PipelineRuntimeInput = {},
  hooks: PipelineRuntimeHooks = {},
): Promise<PipelineRuntimeResult> {
  const {
    maxRetries = 1,
    autoReview = true,
    autoRepair = true,
    qualityThreshold = 75,
    repairMode = "light_repair",
    artifactSyncMode = "adaptive",
    artifactSyncPolicy,
    finalizedResultScope: _finalizedResultScope,
    ...requestInput
  } = options;
  const effectiveMaxRetries = Math.max(0, Math.min(maxRetries, 1));
  const repairAttemptsAllowed = autoRepair && repairMode !== "detect_only" ? effectiveMaxRetries : 0;
  /**
   * sepia 机械项的额外收敛轮数。
   *
   * 原版 sepia-webnovel 的 write 第 7 步与 refactor 第 3 步都是同一句话：
   * 「跑 lint.py，把 FAIL 项清零」「复跑，FAIL 清零」——它是**循环**，不是修一次就收工。
   * 而 ANA 的 `maxRetries` 被夹在 1，机械项常常剩两三条尾巴就停在 needs_repair。
   *
   * 这里只对「还剩 sepia 机械硬伤」放行额外轮次；一旦机械项清零，预算立刻回到
   * `effectiveMaxRetries`，其他质量问题不会因此多烧 token。
   */
  const sepiaConvergenceRounds = autoRepair && repairMode !== "detect_only"
    ? SEPIA_CONVERGENCE_MAX_ROUNDS
    : 0;
  const attemptLimit = Math.max(effectiveMaxRetries, sepiaConvergenceRounds);
  if (artifactSyncPolicy === "director_v2") {
    await hooks.onCheckCancelled?.();
    const saved = await deps.loadFinalizedChapterResult?.(novelId, chapterId);
    /**
     * 保存的定稿回执只复用「已通过」的结论。
     * 未通过的章继续时必须重跑检查与修文：否则一次失败会把这一章锁死在旧结论上，
     * 用户点「从保存进度继续」看到的只是同一份失败结果被重放一遍。
     */
    if (saved?.result.pass) return resumeFinalizedPipelineChapter(deps, novelId, chapterId, saved, options, hooks);
  }
  const request = deps.validateRequest(requestInput);
  await deps.ensureNovelCharacters(novelId, "run chapter pipeline");

  const assembled = await deps.assemble(novelId, chapterId, request);
  let content = assembled.chapter.content?.trim() ? assembled.chapter.content : "";

  // sepia 生成前门：只在「这一章还没正文、要新写」时拦。已有正文走验收/修文，不受架构表约束。
  if (!content.trim()) {
    try {
      await assertBlueprintGate({
        novelId,
        chapterId,
        runtimeMode: artifactSyncPolicy === "director_v2" ? "autopilot" : "single",
      });
    } catch (error) {
      if (error instanceof BlueprintGateBlockedError) throw error;
      // 门自身出错（读库失败等）不阻断生成——门是加法，不能让主链路陪葬
      console.warn("[sepia] blueprint gate unavailable", {
        novelId,
        chapterId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // 技法选择落库（每章只写一次）；写不进去也不影响本次生成
    try {
      await ensureChapterTechniques({ novelId, chapterId, chapterOrder: assembled.chapter.order });
    } catch (error) {
      console.warn("[sepia] ensure techniques failed", {
        novelId,
        chapterId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let retryCountUsed = 0;
  /**
   * advisory 清理的收敛状态。
   *
   * 实测：给一轮只能清掉一半（L1-2 的 8 处吃完一整份补丁预算），
   * 冒号/句号密度这类要第二轮才动。但也不能无限要——第 4 轮开始
   * 句号密度只从 4.1 挪到 4.2，相邻同长句反而从 3 句变回 4 句。
   * 所以上限 2 轮，且每轮必须比上轮少，否则停。
   */
  let advisoryOnlyRounds = 0;
  let advisoryCountBeforeRepair: number | null = null;
  let latestResult: FinalizedRuntimeResult | null = null;
  let latestIssues: ReviewIssue[] = [];
  let pass = false;
  let latestLengthControl: ChapterRuntimePackage["lengthControl"] | undefined;
  let recoverableRepairFailure: PipelineRecoverableRepairFailure | null = null;
  let styleRewriteBaseline: StyleRewriteBaseline | undefined;
  let rewriteGuard: StyleRewriteGuard | undefined;
  let originalEvaluation: ChapterEvaluationSnapshot | null = null;
  /**
   * 目前最好的一版（含原稿）。多轮收敛时用它做回滚基线：
   * 第 2 轮修文改坏了，回到的是第 1 轮的结果，而不是一路退回原稿。
   */
  let bestEvaluation: ChapterEvaluationSnapshot | null = null;
  let repairSelection: ChapterRepairSelectionRecord | null = null;

  // 归因追踪变量
  let firstFailureIssueCodes: string[] = [];
  let firstFailureClassificationCode: string | null = null;
  let firstMissingObligationKinds: string[] = [];
  let secondFailureIssueCodes: string[] = [];

  for (let attempt = 0; attempt <= attemptLimit; attempt += 1) {
    await hooks.onCheckCancelled?.();
    if (!content.trim()) {
      const generatedDraft = await generateNonEmptyDraftFromWriter({
        deps,
        novelId,
        chapterId,
        request,
        assembled,
        hooks,
      });
      content = generatedDraft.content;
      latestLengthControl = generatedDraft.lengthControl;
      if (!generatedDraft.artifactsAlreadySynced) {
        await deps.saveDraftAndArtifacts(novelId, chapterId, content, "drafted", {
          scheduleBackgroundSync: false,
          artifactSyncMode,
          syncArtifacts: false,
        });
      }
    }

    if (!autoReview) {
      await hooks.onCheckCancelled?.();
      const finalResult: PipelineRuntimeResult = {
        reviewExecuted: false,
        pass: true,
        score: {
          coherence: 100,
          pacing: 100,
          repetition: 100,
          engagement: 100,
          voice: 100,
          overall: 100,
        },
        issues: [],
        runtimePackage: null,
        retryCountUsed,
        recoverableRepairFailure: null,
        repairSelection: null,
      };
      if (artifactSyncPolicy === "director_v2") await deps.persistFinalizedChapterResult?.(novelId, chapterId, content, finalResult);
      return resumeFinalizedPipelineChapter(deps, novelId, chapterId, {content, result: finalResult}, options, hooks);
    }

    await hooks.onStageChange?.("reviewing");
    await hooks.onCheckBudget?.(DIRECTOR_CHAPTER_PREFLIGHT_RESERVE_TOKENS, "review");
    const priorAssessment = attempt > 0
      ? (bestEvaluation ?? originalEvaluation)?.result.acceptanceResult?.assessment
      : undefined;
    latestResult = await deps.finalizeChapterContent({
      novelId,
      chapterId,
      request,
      contextPackage: assembled.contextPackage,
      content,
      repairReviewBaseline: priorAssessment ? {
        blockingIssues: priorAssessment.blockingIssues.filter(issue => !NON_PATCHABLE_REVIEW_ISSUE_CODES.has(issue.code)),
        missingObligations: priorAssessment.missingObligations,
        repairDirectives: priorAssessment.repairDirectives,
      } : undefined,
      styleRewriteBaseline,
      lengthControl: latestLengthControl,
      runId: null,
      startMs: null,
      assertExecutionOwnership: hooks.onCheckCancelled,
    });
    await hooks.onCheckCancelled?.();
    content = latestResult.finalContent;
    if (rewriteGuard && attempt > 0) {
      const facts = latestResult.acceptanceResult?.assessment.repairVerification?.factPreservation;
      const valid = facts?.sourceContentHash === rewriteGuard.sourceContentHash
        && (facts.status === "preserved" || facts.status === "authorized_correction")
        && !latestResult.acceptanceResult?.assessment.riskTags.includes("acceptance_gate_unavailable");
      rewriteGuard = { ...rewriteGuard, checks: rewriteGuard.checks.map(check => check.code === "semantic_facts"
        ? { ...check, status: valid ? "passed" : "blocked", reason: valid ? facts!.reason : "候选未通过事实复验，保留原稿。" } : check) };
      latestResult.runtimePackage.styleReview = { ...latestResult.runtimePackage.styleReview!, rewriteGuard };
    }
    const styleLeakageIssues = detectStyleReferenceLeakageIssues(content, latestResult.runtimePackage);
    latestIssues = [
      ...toReviewIssues(latestResult.runtimePackage),
      ...toAcceptanceDirectiveIssues(latestResult.runtimePackage),
      ...styleLeakageIssues,
    ];
    const acceptanceStatus = latestResult.runtimePackage.meta?.acceptanceStatus;
    const continuePolicy = latestResult.runtimePackage.meta?.continuePolicy;
    const shouldPauseForAcceptance = continuePolicy === "pause" || acceptanceStatus === "needs_manual_review";
    const shouldRepairFromAcceptance = continuePolicy === "repair_once" || acceptanceStatus === "repairable";
    /**
     * sepia 两级门：
     *   1. 机械门（脚本）—— 硬伤必须清零；
     *   2. 结构自检（LLM）—— L2 / L3-1 / L3-2 / L4 未过项必须清零。
     * 只有两级都过，本章才算过。自检没跑成（模型/网络故障）不阻断：
     * 它是额外一次 LLM 调用，抖动不该让整章停摆，所以只打
     * `sepia_selfcheck_unavailable` 让人看得见"这章没跑自检"。
     */
    const sepiaMechanical = readSepiaBlockingCount(latestResult.runtimePackage);
    const sepiaSelfCheck = readSepiaSelfCheckFailCount(latestResult.runtimePackage);
    const sepiaSelfCheckUnavailable = hasSepiaSelfCheckUnavailable(latestResult.runtimePackage);
    /**
     * 「只差 advisory」的一轮修文：机械门没有硬伤，开修文只为清 advisory。
     *
     * 两个后果必须一起处理，否则会把好好的章判死：
     *   1. `pass` 不能因它变 false——advisory 在 sepia 里不阻塞；
     *   2. 只跑一轮，第二轮不再为 advisory 重复索取（清不干净就如实留在报告里）。
     */
    const advisoryOnlyRepair = latestResult.runtimePackage.meta?.riskTags
      ?.includes(SEPIA_ADVISORY_REPAIR_TAG) === true;
    pass = !shouldPauseForAcceptance
      && !latestResult.runtimePackage.meta?.riskTags?.includes("style_review_unavailable")
      && sepiaMechanical === 0
      && !latestResult.runtimePackage.meta?.riskTags?.includes("sepia_gate_unavailable")
      && sepiaSelfCheck === 0
      && !(shouldRepairFromAcceptance && !advisoryOnlyRepair)
      && !latestResult.runtimePackage.audit.hasBlockingIssues
      && latestResult.runtimePackage.timelineCheck?.status !== "failed"
      && isQualityPass(latestResult.runtimePackage.audit.score, qualityThreshold)
      && styleLeakageIssues.length === 0;
    if (sepiaSelfCheckUnavailable && sepiaMechanical === 0) {
      console.warn("[sepia] 本章结构自检未跑成，按「未过自检」记录但不阻断", {
        novelId, chapterId, order: assembled.chapter.order,
      });
    }

    if (attempt === 0) {
      originalEvaluation = {
        content,
        result: latestResult,
        issues: latestIssues,
        pass,
      };
      bestEvaluation = originalEvaluation;
    } else {
      const baseline = bestEvaluation ?? originalEvaluation;
      if (!baseline) {
        throw new Error("Pipeline repair selection is missing the original evaluation.");
      }
      secondFailureIssueCodes = pass ? [] : extractIssueCodes(latestResult.runtimePackage);
      repairSelection = selectChapterRepairCandidate({
        original: {
          content: baseline.content,
          pass: baseline.pass,
          runtimePackage: baseline.result.runtimePackage,
          issues: baseline.issues,
        },
        candidate: {
          content,
          pass,
          runtimePackage: latestResult.runtimePackage,
          issues: latestIssues,
          assessmentVerified: !latestResult.acceptanceResult?.assessment.riskTags?.includes("acceptance_gate_unavailable")
            && !(rewriteGuard && latestResult.acceptanceResult?.assessment.riskTags?.includes("style_review_unavailable")),
          rewriteGuard,
        },
      });
      if (repairSelection.selected === "candidate") {
        if (rewriteGuard && latestResult.runtimePackage.styleReview) {
          latestResult.runtimePackage.styleReview.autoRewritten = true;
          latestResult.runtimePackage.styleReview.originalContent = baseline.content;
        }
        await hooks.onCheckCancelled?.();
        await deps.saveDraftAndArtifacts(novelId, chapterId, content, "repaired", {
          scheduleBackgroundSync: false,
          artifactSyncMode,
          syncArtifacts: false,
        });
        bestEvaluation = {
          content,
          result: latestResult,
          issues: latestIssues,
          pass,
        };
        if (pass) break;
        // sepia 的收敛只由两级门驱动：机械项或自检项还没清零才继续下一轮，
        // 且不许空转（没变少就停，保留最好的一版）。
        const remainingSepia = readSepiaBlockingCount(latestResult.runtimePackage);
        const remainingSelfCheck = readSepiaSelfCheckFailCount(latestResult.runtimePackage);
        if ((remainingSepia === 0 && remainingSelfCheck === 0) || attempt >= attemptLimit) break;
      } else {
        content = baseline.content;
        latestResult = baseline.result;
        latestIssues = baseline.issues;
        pass = baseline.pass;
        if (rewriteGuard && latestResult.runtimePackage.styleReview) latestResult.runtimePackage.styleReview.rewriteGuard = rewriteGuard;
        break;
      }
    }

    if (pass) {
      break;
    }

    // 收集首次失败的归因信息（只在第一次失败时记录）
    if (attempt === 0) {
      firstFailureIssueCodes = extractIssueCodes(latestResult.runtimePackage);
      firstFailureClassificationCode = latestResult.runtimePackage.failureClassification?.code ?? null;
      firstMissingObligationKinds = (latestResult.runtimePackage.obligationCoverage?.missing ?? [])
        .map((m) => String(m.kind))
        .filter((kind) => kind.trim().length > 0);
    }

    if (shouldPauseForAcceptance || !autoRepair || repairMode === "detect_only") {
      break;
    }
    // sepia 专项项没清零时可以多跑几轮（原版的「复跑，FAIL 清零」）；其余失败守着原预算。
    const hasSepiaWork = readSepiaBlockingCount(latestResult.runtimePackage) > 0
      || readSepiaSelfCheckFailCount(latestResult.runtimePackage) > 0;
    if (!hasSepiaWork && attempt >= effectiveMaxRetries) {
      break;
    }
    if (attempt >= attemptLimit) {
      break;
    }
    // advisory 清理：最多两轮，且必须比上一轮少；没变少就停，把当前版本留作结果。
    if (advisoryOnlyRepair) {
      const advisoryNow = readSepiaAdvisoryCount(latestResult.runtimePackage);
      if (advisoryOnlyRounds >= ADVISORY_ONLY_MAX_ROUNDS) break;
      if (advisoryCountBeforeRepair !== null && advisoryNow >= advisoryCountBeforeRepair) break;
      advisoryCountBeforeRepair = advisoryNow;
      advisoryOnlyRounds += 1;
    }
    /**
     * 验收门没跑成时默认不进自动修文（判不了好坏就不该写）。
     *
     * 但 sepia 机械项是**确定性**判定，跟那次失败的 LLM 验收没有关系：
     * 禁用词、冒号、破折号在正文里数得出来，验收挂了也照样该清。
     * 原先这里无条件 defer，导致第 4 章验收因 `current_quote_invalid` 失败后
     * 直接跳人工，8 处禁用词一处没改。所以有 sepia 活要干时继续走修文。
     */
    if (shouldDeferNonPatchableReviewRisk(latestResult.runtimePackage) && !hasSepiaWork) {
      recoverableRepairFailure = {
        chapterId,
        message: "本章部分检查未完成，正文已保留，请从章节页面重新审校。",
        repairMode,
        failureTypes: ["review_gate_unavailable"],
        occurredAt: new Date().toISOString(),
      };
      await hooks.onCheckCancelled?.();
      await deps.markChapterNeedsRepair(chapterId);
      break;
    }
    if (styleLeakageIssues.length === 0 && !shouldAttemptAutomaticRepair(latestResult.runtimePackage, repairMode)) {
      break;
    }

    await hooks.onStageChange?.("repairing");
    await hooks.onCheckCancelled?.();
    await hooks.onCheckBudget?.(DIRECTOR_CHAPTER_PREFLIGHT_RESERVE_TOKENS, "repair");
    if (await hooks.onRetryConsumed?.("quality_repair", {
      // `mechanicalOnly` 的语义是「这一轮只为 sepia 的专项门服务」：
      // 机械项（脚本）与自检项（模型）都不占普通重试预算，否则预算为 1 时第二轮被拒，
      // 结构问题永远修不到第二轮。
      mechanicalOnly: hasSepiaWork,
    }) === false) break;
    retryCountUsed += 1;
    await hooks.onCheckCancelled?.();
    const repairResult = await repairWithResubmit({
      novelTitle: assembled.novel.title,
      chapterTitle: assembled.chapter.title,
      content,
      issues: latestIssues,
      runtimePackage: latestResult.runtimePackage,
      options: {
        provider: request.provider,
        model: request.model,
        temperature: request.temperature,
        repairMode,
      },
      // 补丁被程序拒绝（编号越权、锚点失效）说明「这一版补丁不合格」，不是「这章修不动」。
      // sepia 的复跑纪律要求清不干净就再来一遍，所以带着拒绝原因重出一次；
      // 其余失败模式保持原来的「一次即停」，不额外烧钱。
      resubmitOnRejection: hasSepiaWork ? 1 : 0,
    });
    rewriteGuard = repairResult.rewriteGuard;
    styleRewriteBaseline = repairResult.styleRewriteBaseline;
    if (repairResult.recoverableFailure) {
      /**
       * 只为 advisory 开的那一轮修文，失败不能把章节判成待修。
       *
       * advisory 在 sepia 里本来就不阻塞：这一轮成功是加分，失败就该回到
       * 「正文原样 + 报告里如实挂着 advisory」——原先就是这个状态。
       * 若照常走 recoverableRepairFailure，一个冒号密度没修成反而会把已经
       * 能过的章打成 needs_repair，比不开这一轮更差。
       */
      if (advisoryOnlyRepair) {
        console.warn("[sepia] advisory 清理未成功，保留原稿并继续", {
          novelId, chapterId, order: assembled.chapter.order,
          reason: repairResult.recoverableFailure.message,
        });
        break;
      }
      if (rewriteGuard && latestResult.runtimePackage.styleReview) latestResult.runtimePackage.styleReview.rewriteGuard = rewriteGuard;
      recoverableRepairFailure = repairResult.recoverableFailure;
      await deps.markChapterNeedsRepair(chapterId);
      break;
    }
    // The issued repair still counts, but unchanged prose needs no paid re-acceptance.
    if (repairResult.content === content) break;
    const newProseFindings = detectNewSevereProseFindings(content, repairResult.content);
    if (newProseFindings.length > 0) {
      // 同一条纪律：只为 advisory 的修文把正文改坏时，弃用这一版、留原稿，
      // 不把章节打回待修——它不是被修坏的，只是没被修好。
      if (advisoryOnlyRepair) {
        console.warn("[sepia] advisory 清理引入了新的表达问题，弃用该版本并保留原稿", {
          novelId, chapterId, order: assembled.chapter.order,
          findings: [...new Set(newProseFindings.map(finding => finding.message))],
        });
        break;
      }
      recoverableRepairFailure = {
        chapterId,
        message: `修文新增严重表达问题，保留原稿：${[...new Set(newProseFindings.map(finding => finding.message))].join("；")}`,
        repairMode,
        failureTypes: ["prose_quality_regression"],
        occurredAt: new Date().toISOString(),
      };
      await deps.markChapterNeedsRepair(chapterId);
      break;
    }
    content = repairResult.content;
  }

  if (!latestResult) {
    throw new Error("Pipeline chapter runtime did not produce a result.");
  }

  await deps.commitFinalizedChapterContent({
    novelId,
    chapterId,
    request,
    contextPackage: assembled.contextPackage,
    evaluation: latestResult,
    assertExecutionOwnership: hooks.onCheckCancelled,
  });
  // 章节未通过时构建归因对象
  const qualityDebtAttribution: QualityDebtAttribution | null = !pass
    ? buildQualityDebtAttribution({
        repairAttemptsUsed: retryCountUsed,
        repairAttemptsAllowed,
        firstFailureIssueCodes,
        secondFailureIssueCodes,
        firstFailureClassificationCode,
        firstMissingObligationKinds,
      })
    : null;

  const reviewRetries = await currentChapterReviewRetryBudget()?.loadSummary();
  if (reviewRetries) reviewRetries.exhausted = reviewRetries.exhausted && !pass && (
    latestResult.runtimePackage.meta.riskTags?.some(tag => tag === "acceptance_gate_unavailable" || tag === "style_review_unavailable") === true
    || repairSelection?.reasonCode === "original_retained_unverified_review");
  const finalResult: PipelineRuntimeResult = {
    reviewRetries,
    reviewExecuted: !latestResult.runtimePackage.meta?.riskTags?.includes("acceptance_gate_unavailable"),
    pass,
    score: latestResult.runtimePackage.audit.score,
    issues: latestIssues,
    runtimePackage: latestResult.runtimePackage,
    retryCountUsed,
    recoverableRepairFailure,
    repairSelection,
    qualityDebtAttribution,
  };
  if (finalResult.reviewRetries) latestResult.runtimePackage.meta.reviewRetries = finalResult.reviewRetries;
  await hooks.onCheckCancelled?.();
  if (artifactSyncPolicy === "director_v2") {
    await deps.persistFinalizedChapterResult?.(novelId, chapterId, latestResult.finalContent, finalResult);
  }
  return resumeFinalizedPipelineChapter(deps, novelId, chapterId, {content: latestResult.finalContent, result: finalResult}, options, hooks);
}

/** Resumes only the saved final version: generation and acceptance never run here. */
export async function resumeFinalizedPipelineChapter(
  deps: Pick<RunPipelineChapterDeps, "syncFinalChapterArtifacts" | "markChapterGenerationState">,
  novelId: string,
  chapterId: string,
  saved: {content: string; result: PipelineRuntimeResult},
  options: PipelineRuntimeInput,
  hooks: PipelineRuntimeHooks,
): Promise<PipelineRuntimeResult> {
  await hooks.onCheckCancelled?.();
  await hooks.onCheckBudget?.(DIRECTOR_CHAPTER_PREFLIGHT_RESERVE_TOKENS, "artifact_sync");
  const artifactSyncResult = await syncFinalRetainedChapterArtifacts(
    deps, novelId, chapterId, saved.content, options.artifactSyncMode ?? "adaptive",
    saved.result.pass ? "confirmed" : "debt", options.artifactSyncPolicy,
  );
  assertArtifactSyncCanContinue(artifactSyncResult, options.artifactSyncPolicy);
  await hooks.onCheckCancelled?.();
  await deps.markChapterGenerationState(chapterId, saved.result.pass ? "approved" : "reviewed");
  return {...saved.result, artifactSyncResult};
}

async function generateNonEmptyDraftFromWriter(input: {
  deps: RunPipelineChapterDeps;
  novelId: string;
  chapterId: string;
  request: ChapterRuntimeRequestInput;
  assembled: AssembledRuntimeChapter;
  hooks: PipelineRuntimeHooks;
}): Promise<{
  content: string;
  lengthControl?: ChapterRuntimePackage["lengthControl"];
  artifactsAlreadySynced?: boolean;
}> {
  let emptyAttempt = 0;
  while (true) {
    await input.hooks.onCheckCancelled?.();
    await input.hooks.onStageChange?.("generating_chapters");
    await input.hooks.onCheckBudget?.(DIRECTOR_CHAPTER_PREFLIGHT_RESERVE_TOKENS, "draft");
    try {
      const generatedDraft = await input.deps.generateDraftFromWriter({
        novelId: input.novelId,
        chapterId: input.chapterId,
        request: input.request,
        assembled: input.assembled,
      });
      const content = assertChapterContentNotEmpty(generatedDraft.content, {
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: input.assembled.chapter.order,
        source: "pipeline_chapter_writer",
        attempt: emptyAttempt + 1,
        maxEmptyRetries: EMPTY_CONTENT_GENERATION_RETRY_LIMIT,
      });
      return {
        ...generatedDraft,
        content,
      };
    } catch (error) {
      if (!isChapterEmptyContentError(error)) {
        throw error;
      }
      emptyAttempt += 1;
      const willRetry = emptyAttempt <= EMPTY_CONTENT_GENERATION_RETRY_LIMIT;
      await input.hooks.onEmptyContent?.({
        attempt: emptyAttempt,
        willRetry,
        error,
        contentLength: error.details.trimmedLength,
        rawContentLength: error.details.rawLength,
      });
      if (willRetry) {
        continue;
      }
      throw error;
    }
  }
}

async function syncFinalRetainedChapterArtifacts(
  deps: Pick<RunPipelineChapterDeps, "syncFinalChapterArtifacts">,
  novelId: string,
  chapterId: string,
  content: string,
  artifactSyncMode: PipelineRuntimeInput["artifactSyncMode"],
  contentProvenance: ContentProvenance,
  artifactSyncPolicy?: "director_v2",
): Promise<ChapterArtifactSyncResult> {
  if (!content.trim()) {
    return {
      status: "failed",
      contentHash: "",
      completedArtifacts: [],
      reason: "章节正文为空，无法提交连续性资产。",
    };
  }
  return deps.syncFinalChapterArtifacts(novelId, chapterId, content, {
    artifactSyncMode,
    contentProvenance,
    ...(artifactSyncPolicy ? {artifactSyncPolicy} : {}),
  });
}

function assertArtifactSyncCanContinue(result: ChapterArtifactSyncResult, policy?: "director_v2"): void {
  if ((result.status === "completed" || result.status === "degraded")
    && (policy !== "director_v2" || result.completedArtifacts.includes("artifact_delta"))) {
    return;
  }
  throw new ChapterArtifactSyncBoundaryError(result);
}

function isQualityPass(score: QualityScore, qualityThreshold: number): boolean {
  return score.coherence >= QUALITY_THRESHOLD.coherence
    && score.repetition >= QUALITY_THRESHOLD.repetition
    && score.engagement >= QUALITY_THRESHOLD.engagement
    && score.overall >= qualityThreshold;
}

function toReviewIssues(runtimePackage: ChapterRuntimePackage): ReviewIssue[] {
  const issues = runtimePackage.audit.openIssues.map((issue) => ({
    severity: issue.severity,
    category: AUDIT_CATEGORY_MAP[issue.auditType],
    evidence: issue.evidence,
    fixSuggestion: issue.fixSuggestion,
  }));
  return issues.length > 0
    ? issues
    : runtimePackage.audit.reports.flatMap((report) => report.issues.map((issue) => ({
      severity: issue.severity,
      category: AUDIT_CATEGORY_MAP[report.auditType],
      evidence: issue.evidence,
      fixSuggestion: issue.fixSuggestion,
    })));
}

function toAcceptanceDirectiveIssues(runtimePackage: ChapterRuntimePackage): ReviewIssue[] {
  const directives = runtimePackage.meta?.repairDirectives ?? [];
  return directives.map((directive) => ({
    severity: directive.mode === "manual" || directive.mode === "rewrite" ? "high" : "medium",
    category: directive.target === "character"
      ? "logic"
      : directive.target === "plot" || directive.target === "ending"
        ? "pacing"
        : directive.target === "voice"
          ? "voice"
          : "coherence",
    evidence: `acceptance_directive:${directive.target}`,
    fixSuggestion: directive.instruction,
  }));
}

function detectStyleReferenceLeakageIssues(
  content: string,
  runtimePackage: ChapterRuntimePackage,
): ReviewIssue[] {
  const leakedEntities = detectForbiddenStyleEntities(
    content,
    runtimePackage.context.styleContext,
  );
  if (leakedEntities.length === 0) {
    return [];
  }
  return [{
    severity: "critical",
    category: "voice",
    evidence: "Generated chapter contains source-reference entities from the bound style profile.",
    fixSuggestion: "Rewrite the chapter with transferable style guidance only; remove source-work names, places, titles, catchphrases, and iconic plot references.",
  }];
}

type ChapterRepairOptions = {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  repairMode?: "detect_only" | "light_repair" | "heavy_repair" | "continuity_only" | "character_only" | "ending_only";
  modeHintSuffix?: string;
};

async function repairDraftContent(input: {
  novelTitle: string;
  chapterTitle: string;
  content: string;
  issues: ReviewIssue[];
  runtimePackage: ChapterRuntimePackage;
  options: ChapterRepairOptions;
}): Promise<{
  content: string;
  recoverableFailure?: PipelineRecoverableRepairFailure | null;
  rewriteGuard?: StyleRewriteGuard;
  styleRewriteBaseline?: StyleRewriteBaseline;
}> {
  let repaired: Awaited<ReturnType<typeof runChapterRepairText>>;
  try {
    repaired = await runChapterRepairText({
      novelId: input.runtimePackage.novelId,
      chapterId: input.runtimePackage.chapterId,
      novelTitle: input.novelTitle,
      chapterTitle: input.chapterTitle,
      content: input.content,
      issues: input.issues,
      runtimePackage: input.runtimePackage,
      options: {
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature,
        repairMode: input.options.repairMode,
        modeHintSuffix: input.options.modeHintSuffix,
      },
    });
  } catch (error) {
    if (!(error instanceof ChapterPatchRepairFailedError)) {
      throw error;
    }
    return {
      content: input.content,
      rewriteGuard: error.rewriteGuard,
      recoverableFailure: {
        chapterId: input.runtimePackage.chapterId,
        message: error.message,
        repairMode: input.options.repairMode ?? "light_repair",
        failureTypes: error.applyResult?.failures.map((failure) => failure.failureType)
          ?? [error.plan?.requiresFullRewrite ? "full_rewrite_requested" : "patch_plan_invalid"],
        occurredAt: new Date().toISOString(),
      },
    };
  }
  return {
    content: repaired.content.trim() ? repaired.content : input.content,
    recoverableFailure: null,
    rewriteGuard: repaired.rewriteGuard,
    styleRewriteBaseline: repaired.styleRewriteBaseline,
  };
}

/**
 * 补丁计划被程序拒绝时，带着拒绝原因重出一版。
 *
 * 只在 sepia 还有活要干时启用：补丁不合格（编号越权、锚点失效、改动过大）是
 * 「这一版没写对」，重出一版通常就能过；把它当成「这章修不动」会直接落到
 * needs_repair，机械项永远清不了零。上限由调用方给，用尽即按原逻辑收尾。
 */
async function repairWithResubmit(input: {
  novelTitle: string;
  chapterTitle: string;
  content: string;
  issues: ReviewIssue[];
  runtimePackage: ChapterRuntimePackage;
  options: ChapterRepairOptions;
  resubmitOnRejection: number;
}): Promise<Awaited<ReturnType<typeof repairDraftContent>>> {
  let result = await repairDraftContent(input);
  for (let used = 0; used < input.resubmitOnRejection && result.recoverableFailure; used += 1) {
    result = await repairDraftContent({
      ...input,
      options: {
        ...input.options,
        modeHintSuffix: buildResubmitHint(result.recoverableFailure.message),
      },
    });
  }
  return result;
}

function buildResubmitHint(rejection: string): string {
  const reason = rejection.trim().replace(/\s+/g, " ").slice(0, 160);
  return [
    `上一版补丁被程序拒绝：${reason}`,
    "重新输出补丁，逐条核对下面三条硬约束：",
    "1. issueIds 只能引用问题清单里出现过的编号（blockingIssueCodes、repairDirectives 的 [sepia …] 标签或 allowedIssueIds），不得自造编号；",
    "2. targetExcerpt 必须逐字摘自当前正文、全章唯一出现，且不得互相重叠；",
    "3. 不改动与问题无关的段落，不扩大修改范围。",
  ].join("\n");
}

function shouldDeferNonPatchableReviewRisk(
  runtimePackage: ChapterRuntimePackage,
): boolean {
  const openIssues = runtimePackage.audit.openIssues ?? [];
  return openIssues.length > 0
    && openIssues.every((issue) => typeof issue.code === "string"
      && NON_PATCHABLE_REVIEW_ISSUE_CODES.has(issue.code));
}

/** 从 runtimePackage 提取 openIssues 的 code 列表（过滤空值） */
function extractIssueCodes(runtimePackage: ChapterRuntimePackage): string[] {
  return (runtimePackage.audit.openIssues ?? [])
    .map((issue) => issue.code)
    .filter((code): code is string => typeof code === "string" && code.trim().length > 0);
}

const LENGTH_ISSUE_CODE_PREFIXES = ["LENGTH_", "length_"];

function isLengthIssueCode(code: string): boolean {
  return LENGTH_ISSUE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/** 根据收集到的埋点数据构建结构化归因 */
function buildQualityDebtAttribution(input: {
  repairAttemptsUsed: number;
  repairAttemptsAllowed: number;
  firstFailureIssueCodes: string[];
  secondFailureIssueCodes: string[];
  firstFailureClassificationCode: string | null;
  firstMissingObligationKinds: string[];
}): QualityDebtAttribution {
  const {
    repairAttemptsUsed,
    repairAttemptsAllowed,
    firstFailureIssueCodes,
    secondFailureIssueCodes,
    firstFailureClassificationCode,
    firstMissingObligationKinds,
  } = input;

  // 根因 A：首次和二次 codes 完全一致（修复未解决义务问题）
  const hasBothFailures = secondFailureIssueCodes.length > 0;
  const firstSet = new Set(firstFailureIssueCodes);
  const secondSet = new Set(secondFailureIssueCodes);
  const sameObligationRepeated = hasBothFailures
    && firstSet.size > 0
    && firstSet.size === secondSet.size
    && [...firstSet].every((code) => secondSet.has(code));

  // 根因 D：义务分类 = 义务不可达
  const planMisaligned = firstFailureClassificationCode === "draft_obligation_unmet"
    || firstFailureClassificationCode === "replan_required";

  // 根因 E：首次 length 类、二次 content 类（签名漂移）
  const firstHasLengthOnly = firstFailureIssueCodes.length > 0
    && firstFailureIssueCodes.every(isLengthIssueCode);
  const secondHasContentIssue = secondFailureIssueCodes.some((code) => !isLengthIssueCode(code));
  const lengthVsContentDrift = hasBothFailures && firstHasLengthOnly && secondHasContentIssue;

  return {
    repairAttemptsUsed,
    repairAttemptsAllowed,
    firstFailureIssueCodes,
    secondFailureIssueCodes,
    firstFailureClassificationCode,
    patchAnchorFailed: false,
    sameObligationRepeated,
    planMisaligned,
    lengthVsContentDrift,
    missingObligationKinds: firstMissingObligationKinds,
  };
}

