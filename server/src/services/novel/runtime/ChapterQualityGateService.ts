import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { SepiaStructuralSelfCheckRecord } from "@ai-novel/shared/types/sepia";
import { prisma } from "../../../db/prisma";
import { applySepiaGate } from "../../sepia/acceptance/sepiaAcceptance";
import { buildSepiaGateStatus, saveSepiaGateStatus } from "../../sepia/gate/sepiaGateStatus";
import {
  SEPIA_SELFCHECK_UNAVAILABLE_TAG,
  mergeSelfCheckIntoAssessment,
} from "../../sepia/selfcheck/sepiaSelfCheck";
import { runSepiaStructuralSelfCheck } from "./SepiaStructuralSelfCheckService";
import {
  ChapterAcceptanceAssessmentService,
  type ChapterAcceptanceAssessmentInput,
  type ChapterAcceptanceAssessmentResult,
} from "./ChapterAcceptanceAssessmentService";
import type { ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import { hashContent, rememberCacheValue } from "./chapterRuntimePackageBuilders";

type AssessmentService = Pick<ChapterAcceptanceAssessmentService, "assess">
  & Partial<Pick<ChapterAcceptanceAssessmentService, "getCacheIdentity" | "persistAssessmentResult">>;

export interface ChapterQualityGateServiceDeps {
  acceptanceAssessmentService?: AssessmentService;
  /** 测试/排障用：替换结构自检的实现；返回 null 表示本次跳过 */
  structuralSelfCheck?: (input: SepiaStructuralSelfCheckInput) => Promise<SepiaStructuralSelfCheckRecord | null>;
}

type SepiaStructuralSelfCheckInput = Parameters<typeof runSepiaStructuralSelfCheck>[0];

export interface RunChapterQualityGatesInput {
  novelId: string;
  chapterId: string;
  contextPackage: GenerationContextPackage;
  content: string;
  request: ChapterRuntimeRequestInput;
  persistAssessment?: boolean;
  repairReviewBaseline?: ChapterAcceptanceAssessmentInput["repairReviewBaseline"];
  styleRewriteBaseline?: ChapterAcceptanceAssessmentInput["styleRewriteBaseline"];
}

interface CacheIdentity {
  contentHash: string;
  requestKey: string;
}

interface PersistedAcceptance {
  schemaVersion: 3;
  gate: "acceptance";
  contentHash: string;
  requestKey: string;
  result: ChapterAcceptanceAssessmentResult;
}

export class ChapterQualityGateService {
  private readonly service: AssessmentService;
  private readonly structuralSelfCheck: (input: SepiaStructuralSelfCheckInput) => Promise<SepiaStructuralSelfCheckRecord | null>;
  private readonly cache = new Map<string, ChapterAcceptanceAssessmentResult>();
  private readonly inFlight = new Map<string, Promise<ChapterAcceptanceAssessmentResult>>();
  /**
   * 结构自检按正文指纹缓存。
   *
   * 不缓存会让每次"重新审校"都重跑一次 LLM：同一段正文、同一个包、同一个模型，
   * 结论不会变。缓存键带上 packVersion 与 model——换包或换模型必须重判。
   */
  private readonly selfCheckCache = new Map<string, SepiaStructuralSelfCheckRecord>();

  constructor(deps: ChapterQualityGateServiceDeps) {
    this.service = deps.acceptanceAssessmentService ?? new ChapterAcceptanceAssessmentService();
    this.structuralSelfCheck = deps.structuralSelfCheck ?? runSepiaStructuralSelfCheck;
  }

  async runAcceptanceGate(input: RunChapterQualityGatesInput): Promise<ChapterAcceptanceAssessmentResult> {
    const startedAt = Date.now();
    const assessmentInput: ChapterAcceptanceAssessmentInput = {
      novelId: input.novelId, chapterId: input.chapterId,
      novelTitle: input.contextPackage.bookContract?.title ?? input.contextPackage.chapter.title,
      chapterTitle: input.contextPackage.chapter.title, chapterOrder: input.contextPackage.chapter.order,
      targetWordCount: input.contextPackage.chapterWriteContext?.chapterMission.targetWordCount
        ?? input.contextPackage.chapterReviewContext?.chapterMission.targetWordCount
        ?? input.contextPackage.chapter.targetWordCount ?? null,
      repairReviewBaseline: input.repairReviewBaseline,
      styleRewriteBaseline: input.styleRewriteBaseline,
      content: input.content, contextPackage: input.contextPackage,
      provider: input.request.provider, model: input.request.model, temperature: input.request.temperature,
      persist: input.persistAssessment !== false,
    };
    const contentHash = hashContent(input.content);
    try {
      const requestKey = await this.resolveIdentity(assessmentInput);
      const result = requestKey
        ? await this.loadAssessment(assessmentInput, { contentHash, requestKey })
        : await this.service.assess(assessmentInput);
      // sepia 机械门接在验收之后：LLM 验收给语义判定，机械门给确定性判定。
      // 必须放在缓存读取之后——缓存键是 contentHash，不含 packVersion。
      const gated = await applySepiaGate(result.assessment, input.content);
      // 结构自检（rubric 五组 + selfcheck L2–L4）：机械门清零后才跑。
      // 顺序不能反：机械项还在时先跑自检，模型会在满是破折号的正文上判结构，
      // 结论既不可用，又白花一次调用。
      const selfCheck = await this.runStructuralSelfCheck(input, gated.report, gated.degraded);
      const assessment = selfCheck
        ? mergeSelfCheckIntoAssessment(gated.assessment, selfCheck)
        : gated.assessment;
      const gatedResult: ChapterAcceptanceAssessmentResult = gated.degraded
        || gated.report !== null
        || selfCheck !== null
        ? { ...result, assessment }
        : result;
      // 结论落库（Chapter.sepiaGateStatus）：明细随报告散掉，这一列留给编辑器与排障。
      // 门没跑（SEPIA_DISABLED）时不写，避免把「没跑」记成「不可用」。
      if (gated.report || gated.degraded) {
        await saveSepiaGateStatus(
          input.chapterId,
          buildSepiaGateStatus(gated.report, gated.degraded, new Date(), selfCheck),
        );
      }
      console.info("[chapter-runtime-trace]", {
        novelId: input.novelId, chapterId: input.chapterId, chapterOrder: assessmentInput.chapterOrder,
        stage: "acceptance", blocking: true, attemptNo: 1, retryReason: null,
        contentHash, durationMs: Date.now() - startedAt,
        promptAssetKey: "novel.chapter.acceptance_assessment",
        status: gatedResult.assessment.riskTags.some(tag => tag === "acceptance_gate_unavailable" || tag === "style_review_unavailable" || tag === "sepia_gate_unavailable") ? "degraded" : "succeeded",
        sepia: {
          blocking: gated.report?.blockingCount ?? null,
          advisory: gated.report?.advisoryCount ?? null,
          deslop: gated.report?.deslop ?? null,
          degraded: gated.degraded,
          selfCheck: selfCheck?.verdict ?? null,
          selfCheckBlocking: selfCheck?.blocking.length ?? null,
        },
      });
      return gatedResult;
    } catch (error) {
      console.warn("[chapter-runtime-trace]", {
        novelId: input.novelId, chapterId: input.chapterId, chapterOrder: assessmentInput.chapterOrder,
        stage: "acceptance", blocking: true, attemptNo: 1, retryReason: null,
        promptAssetKey: "novel.chapter.acceptance_assessment", contentHash,
        durationMs: Date.now() - startedAt, status: "failed",
      });
      throw error;
    }
  }

  async persistAcceptanceResult(
    input: RunChapterQualityGatesInput,
    result: ChapterAcceptanceAssessmentResult,
  ): Promise<ChapterAcceptanceAssessmentResult> {
    if (!this.service.persistAssessmentResult) return result;
    const assessmentInput: ChapterAcceptanceAssessmentInput = {
      novelId: input.novelId,
      chapterId: input.chapterId,
      novelTitle: input.contextPackage.bookContract?.title ?? input.contextPackage.chapter.title,
      chapterTitle: input.contextPackage.chapter.title,
      chapterOrder: input.contextPackage.chapter.order,
      targetWordCount: input.contextPackage.chapterWriteContext?.chapterMission.targetWordCount
        ?? input.contextPackage.chapterReviewContext?.chapterMission.targetWordCount
        ?? input.contextPackage.chapter.targetWordCount ?? null,
      repairReviewBaseline: input.repairReviewBaseline,
      styleRewriteBaseline: input.styleRewriteBaseline,
      content: input.content,
      contextPackage: input.contextPackage,
      provider: input.request.provider,
      model: input.request.model,
      temperature: input.request.temperature,
      persist: true,
    };
    return this.service.persistAssessmentResult(assessmentInput, result);
  }

  /**
   * 只在机械门真的清零后才跑结构自检。
   *
   * 三种情况跳过：门没跑（SEPIA_DISABLED）、门不可用、门还有 hard 项。
   * 自检自身失败**不抛**：它是 LLM 调用，网络抖动不该让整章存不下来。
   * 失败时打 `sepia_selfcheck_unavailable`，让报告里看得见"这章没跑自检"，
   * 而不是伪装成"自检通过"。
   */
  private async runStructuralSelfCheck(
    input: RunChapterQualityGatesInput,
    report: Awaited<ReturnType<typeof applySepiaGate>>["report"],
    degraded: boolean,
  ): Promise<SepiaStructuralSelfCheckRecord | null> {
    if (degraded || !report || report.blockingCount > 0) return null;
    const cacheKey = [
      hashContent(input.content),
      report.packVersion,
      input.request.model ?? "",
      input.request.provider ?? "",
    ].join("|");
    const cached = this.selfCheckCache.get(cacheKey);
    if (cached) return cached;
    try {
      const record = await this.structuralSelfCheck({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: input.contextPackage.chapter.order,
        chapterTitle: input.contextPackage.chapter.title,
        targetWordCount: input.contextPackage.chapterWriteContext?.chapterMission.targetWordCount
          ?? input.contextPackage.chapterReviewContext?.chapterMission.targetWordCount
          ?? input.contextPackage.chapter.targetWordCount ?? null,
        content: input.content,
        provider: input.request.provider,
        model: input.request.model,
        temperature: input.request.temperature,
        mechanicalSummary: `L1 硬伤 0 条，advisory ${report.advisoryCount} 条，本次不重判 L1。`,
      });
      this.rememberSelfCheck(cacheKey, record);
      return record;
    } catch (error) {
      console.warn("[sepia] 结构自检不可用，本章按「未跑自检」处理", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        message: error instanceof Error ? error.message : String(error),
      });
      // 不可用的结论**不缓存**：下一次重试应当重新尝试，而不是沿用这次失败
      return {
        schemaVersion: 1,
        verdict: "unavailable",
        diagnosis: { groups: [], failed: 0, overCorrected: 0 },
        levels: { groups: [], failed: 0 },
        blocking: [],
        advisory: [],
        summary: `结构自检未跑成：${error instanceof Error ? error.message : String(error)}`,
        packVersion: report.packVersion,
        model: input.request.model ?? "",
        contentHash: "",
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /** 只缓存有结论的结果（pass / fail），且总量封顶，避免长跑进程把内存吃穿 */
  private rememberSelfCheck(key: string, record: SepiaStructuralSelfCheckRecord | null): void {
    if (!record || record.verdict === "unavailable") return;
    if (this.selfCheckCache.size >= 200) {
      const oldest = this.selfCheckCache.keys().next().value;
      if (oldest !== undefined) this.selfCheckCache.delete(oldest);
    }
    this.selfCheckCache.set(key, record);
  }

  private async resolveIdentity(input: ChapterAcceptanceAssessmentInput): Promise<string | null> {
    if (!this.service.getCacheIdentity) return null;
    try {
      return await this.service.getCacheIdentity(input);
    } catch {
      // Failure to verify configuration must never authorize an old cached result.
      console.warn("[chapter-runtime] acceptance cache identity unavailable", { chapterId: input.chapterId });
      return null;
    }
  }

  private cacheWhere(input: ChapterAcceptanceAssessmentInput, identity: CacheIdentity) {
    return { novelId_chapterId_contentHash_artifactType_syncMode: {
      novelId: input.novelId, chapterId: input.chapterId, contentHash: identity.contentHash,
      artifactType: "quality_gate_acceptance", syncMode: `request_v2_${identity.requestKey}`,
    } };
  }

  private isCacheable(result: ChapterAcceptanceAssessmentResult): boolean {
    return Boolean(result?.assessment?.riskTags && result.assessment.blockingIssues)
      && !result.assessment.riskTags.includes("acceptance_gate_unavailable")
      && !result.assessment.riskTags.includes("style_review_unavailable")
      && !result.assessment.blockingIssues.some((issue) => issue.code === "acceptance_gate_unavailable");
  }

  private async loadAssessment(input: ChapterAcceptanceAssessmentInput, identity: CacheIdentity) {
    const key = JSON.stringify([input.novelId, input.chapterId, identity.contentHash, identity.requestKey]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const running = this.inFlight.get(key);
    if (running) return running;
    // Claim before the first persisted-cache await to coalesce concurrent misses.
    const promise = this.readOrAssess(input, identity, key);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async readOrAssess(input: ChapterAcceptanceAssessmentInput, identity: CacheIdentity, key: string) {
    const where = this.cacheWhere(input, identity);
    try {
      const row = await prisma.chapterArtifactSyncCheckpoint.findUnique({ where, select: { status: true, metadataJson: true } });
      const exact = row?.status === "succeeded" && row.metadataJson ? JSON.parse(row.metadataJson) as PersistedAcceptance : null;
      if (exact?.schemaVersion === 3 && exact.gate === "acceptance"
        && exact.contentHash === identity.contentHash && exact.requestKey === identity.requestKey
        && this.isCacheable(exact.result)) {
        rememberCacheValue(this.cache, key, exact.result);
        return exact.result;
      }

      // Same prose is insufficient: prompt, contract, repair baseline and model must also match.
    } catch {
      console.warn("[chapter-runtime] acceptance cache read skipped", { chapterId: input.chapterId });
    }
    const result = await this.service.assess(input);
    if (!this.isCacheable(result)) return result;
    // Do not publish a result under an old identity if configuration changed during assessment.
    if (await this.resolveIdentity(input) !== identity.requestKey) return result;
    const payload: PersistedAcceptance = { schemaVersion: 3, gate: "acceptance", ...identity, result };
    try {
      await prisma.chapterArtifactSyncCheckpoint.upsert({
        where,
        create: {
          ...where.novelId_chapterId_contentHash_artifactType_syncMode,
          status: "succeeded", sourceType: "chapter_quality_gate", sourceStage: "acceptance",
          metadataJson: JSON.stringify(payload),
        },
        update: { status: "succeeded", metadataJson: JSON.stringify(payload) },
      });
    } catch {
      console.warn("[chapter-runtime] acceptance cache write skipped", { chapterId: input.chapterId });
    }
    rememberCacheValue(this.cache, key, result);
    return result;
  }
}
