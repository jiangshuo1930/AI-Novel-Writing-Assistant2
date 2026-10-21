import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import type { ChapterRepairContext, ChapterRuntimePackage } from "@ai-novel/shared/types/chapterRuntime";
import {
  applyChapterPatchRepairPlan,
  type ChapterPatchApplyResult,
  type ChapterPatchRepairPlan,
} from "@ai-novel/shared/types/chapterPatchRepair";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { buildChapterPatchRepairContextBlocks } from "../../prompting/prompts/novel/chapterLayeredContext";
import { chapterPatchRepairPrompt } from "../../prompting/prompts/novel/chapterPatchRepair.prompts";
import { isStyleIssueRewritable, type StyleRewriteGuard, type StyleRewriteBaseline } from "@ai-novel/shared/types/styleEngine";
import { guardStylePatches, isStyleRewriteBlocked } from "../styleEngine/rewrite";
import { getSepiaPack } from "../sepia/pack";

/**
 * sepia 的禁用词是一张词表，不是几个孤立的词：`忽然`、`猛地`、`骤然` 都在里面。
 * 只告诉模型「删掉忽然」，它就会换成「猛地」，下一轮门照样报命中——两轮下来
 * 正文在几个同族副词之间来回搬，硬伤永远清不了零。
 *
 * 所以清 sepia 机械项时把整张表一起给模型，并说清「换同类词等于没改」。
 */
function buildSepiaBannedWordHint(issuesJson: string, runtimePackage?: ChapterRuntimePackage | null): string | null {
  /**
   * 只给**硬伤**轮注入禁用词表。
   *
   * advisory 的清理（冒号、句号密度、超长句、同长句、对话占比、引号强调）全是
   * 形态问题，塞 153 个禁用词进去只会让模型顺手改词，把没坏的地方改坏；
   * 而且 advisory 指令本身带 `[sepia …]` 前缀，按文本匹配会误触发。
   */
  const tags = runtimePackage?.meta?.riskTags ?? [];
  const hasSepiaBlockingWork = tags.some(tag => tag.startsWith("sepia_blocking"));
  const hasSepiaWork = runtimePackage ? hasSepiaBlockingWork : /\[sepia\b/i.test(issuesJson);
  if (!hasSepiaWork) return null;
  let words: string[] = [];
  try {
    words = getSepiaPack().data.bannedWords ?? [];
  } catch {
    return null;
  }
  if (!words.length) return null;
  return [
    "本轮要清零 sepia 机械项，额外遵守：",
    `1. 下列禁用词只要在 replacement 里再出现一次，这一轮仍然算没修完：${words.map(word => `「${word}」`).join("")}`,
    "2. 不要把一个禁用词换成同族副词。忽然→猛地、忽然→骤然、轻轻→微微 都还在这张表里，换一个等于没改。",
    "   要么直接删掉这个副词，要么改成具体动作、句读或名词性描写。",
    "3. 只改命中的那几处，不要顺手润色别处。",
  ].join("\n");
}

export type PatchRepairMode =
  | "detect_only"
  | "light_repair"
  | "heavy_repair"
  | "continuity_only"
  | "character_only"
  | "ending_only";

export interface ChapterPatchRepairInput {
  novelId?: string;
  chapterId?: string;
  novelTitle: string;
  chapterTitle: string;
  content: string;
  issues: ReviewIssue[];
  issuesJson?: string;
  modeHint?: string;
  repairContext?: ChapterRepairContext | null;
  runtimePackage?: ChapterRuntimePackage | null;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  repairMode?: PatchRepairMode;
}

export interface ChapterPatchRepairResult {
  content: string;
  plan: ChapterPatchRepairPlan;
  appliedPatchIds: string[];
  rewriteGuard?: StyleRewriteGuard;
  styleRewriteBaseline?: StyleRewriteBaseline;
}

export class ChapterPatchRepairFailedError extends Error {
  constructor(
    message: string,
    readonly plan?: ChapterPatchRepairPlan,
    readonly applyResult?: ChapterPatchApplyResult,
    readonly rewriteGuard?: StyleRewriteGuard,
  ) {
    super(message);
    this.name = "ChapterPatchRepairFailedError";
  }
}

export class ChapterPatchRepairService {
  async repair(input: ChapterPatchRepairInput): Promise<ChapterPatchRepairResult> {
    if (!input.content.trim()) {
      throw new ChapterPatchRepairFailedError("章节正文为空，不能执行局部补丁修复。");
    }
    if (input.repairMode === "detect_only") {
      throw new ChapterPatchRepairFailedError("当前为只检测模式，未执行章节修复。");
    }
    if (input.repairMode === "heavy_repair") {
      throw new ChapterPatchRepairFailedError("当前修复模式允许整章重写，跳过局部补丁。");
    }

    const repairContext = input.repairContext ?? input.runtimePackage?.context.chapterRepairContext;
    const issuesJson = input.issuesJson ?? JSON.stringify(input.issues);
    const styleIssues = input.runtimePackage?.styleReview?.report?.violations ?? [];
    const styleIds = new Set(styleIssues.map(issue => issue.issueCode).filter((id): id is string => Boolean(id)));
    const allowedStyleIds = styleIssues.filter(issue => isStyleIssueRewritable(issue))
      .map(issue => issue.issueCode).filter((id): id is string => Boolean(id));
    const nonStyleIds = (input.runtimePackage?.audit.openIssues ?? [])
      .filter(issue => !styleIds.has(issue.code ?? ""))
      .flatMap(issue => [issue.id, issue.code].filter((id): id is string => Boolean(id)));
    const obligationIds = (input.runtimePackage?.obligationCoverage?.missing ?? [])
      .map(item => `${item.kind}:${item.summary}`);
    /**
     * 修文清单里还有管线自己注入的条目，模型会照抄它们的编号：
     *   - `repairDirectives`：证据写成 `acceptance_directive:<target>`；
     *   - sepia 机械项：指令前缀写成 `[sepia L1-1]`。
     * 白名单若只认 `audit.openIssues`，这几类会被判「越权」，**整份补丁计划**作废——
     * 连合法的破折号修复也一起丢掉，sepia 的「FAIL 清零」就永远走不完。
     * 这里让许可清单与模型实际看到的清单对齐。
     */
    const directiveIds = (input.runtimePackage?.meta?.repairDirectives ?? [])
      .map(directive => `acceptance_directive:${directive.target}`);
    const allowedIssueIds = [...new Set([...allowedStyleIds, ...nonStyleIds, ...obligationIds, ...directiveIds])];
    const protectedTerms = repairContext?.writeContext.characterHardFacts?.map(item => item.name) ?? [];
    const contextBlocks = repairContext
      ? buildChapterPatchRepairContextBlocks(repairContext, issuesJson)
      : undefined;
    let generated: { output: ChapterPatchRepairPlan };
    const modeHint = [input.modeHint, buildSepiaBannedWordHint(issuesJson, input.runtimePackage)]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n");
    try {
      generated = await runStructuredPrompt({
        asset: chapterPatchRepairPrompt,
        promptInput: {
          novelTitle: input.novelTitle,
          chapterTitle: input.chapterTitle,
          chapterContent: input.content,
          issuesJson,
          modeHint: modeHint || undefined,
          styleProtection: styleIssues.length ? JSON.stringify({ allowedIssueIds, styleIssueIds: allowedStyleIds,
            reportOnly: styleIssues.filter(issue => !isStyleIssueRewritable(issue)), protectedTerms,
            wholeChapterTouchedRatioMax: 0.3, wholeChapterAddedRatioMax: 0.05 }) : undefined,
        },
        contextBlocks,
        options: {
          provider: input.provider,
          model: input.model,
          temperature: Math.min(input.temperature ?? 0.35, 0.45),
          maxTokens: 4200,
          novelId: input.novelId,
          chapterId: input.chapterId,
          stage: "chapter_patch",
          triggerReason: input.repairMode ?? "patch_first",
        },
      });
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : String(error);
      throw new ChapterPatchRepairFailedError(`局部补丁计划未通过结构校验：${message}`);
    }

    let applied: ChapterPatchApplyResult;
    try {
      applied = applyChapterPatchRepairPlan(input.content, generated.output);
    } catch (error) {
      const message = formatPatchRepairApplyError(error);
      throw new ChapterPatchRepairFailedError(
        `局部补丁计划不可安全应用：${message}`,
        generated.output,
      );
    }
    if (!applied.success) {
      const reason = applied.failures.map((failure) => `${failure.patchId}: ${failure.reason}`).join("；")
        || generated.output.escalationReason
        || "局部补丁没有产生有效正文变化。";
      throw new ChapterPatchRepairFailedError(reason, generated.output, applied);
    }

    // A shared repair can carry both factual and expression fixes. Once style
    // issues are present, bind every patch to the server's actual issue set.
    const protection = styleIssues.length ? guardStylePatches({ original: input.content,
      plan: generated.output, allowedIssueIds, styleIssueIds: allowedStyleIds, protectedTerms,
      acceptIssueId: isSepiaIssueId }) : undefined;
    if (protection && isStyleRewriteBlocked(protection.guard)) {
      throw new ChapterPatchRepairFailedError("表达修文超出许可或保护范围，保留原稿。",
        generated.output, applied, protection.guard);
    }

    return {
      content: applied.content,
      plan: generated.output,
      appliedPatchIds: applied.appliedPatchIds,
      rewriteGuard: protection?.guard,
      styleRewriteBaseline: protection?.baseline,
    };
  }
}

/**
 * sepia 编号的两种写法：`SEPIA_em_dash`（转译层的 code）与 `sepia L1-1`（指令前缀）。
 * 两者都指向本章必须清零的硬伤，允许作为补丁的 issueIds 引用。
 */
const SEPIA_ISSUE_ID_PATTERN = /^sepia[\s:_-]/i;

function isSepiaIssueId(issueId: string): boolean {
  return SEPIA_ISSUE_ID_PATTERN.test(issueId.trim());
}

function formatPatchRepairApplyError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}
