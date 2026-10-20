/**
 * 结构自检服务（把 sepia 的两张表交给一次 LLM 判定）
 *
 * 为什么单独一层：`services/sepia/**` 是纯判定层，不 import prompting/llm——
 * 那样 sepia 的规则包就能被单测直接跑，不必起模型。真正调模型的动作放在
 * runtime 层，判定与合并仍在 `sepia/selfcheck/sepiaSelfCheck.ts`。
 *
 * 调用时机由 `ChapterQualityGateService` 决定：**机械门清零之后**才跑。
 * 顺序不能反——机械项没清时先跑自检，模型会在满是破折号的正文上判结构，
 * 结论既不可用，又白花一次调用。
 */

import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { SepiaStructuralSelfCheckRecord } from "@ai-novel/shared/types/sepia";
import { runStructuredPrompt } from "../../../prompting/core/promptRunner";
import {
  sepiaStructuralSelfCheckPrompt,
  type SepiaRubricGroup,
} from "../../../prompting/prompts/sepia/structuralSelfCheck.prompts";
import { getSepiaPack } from "../../sepia/pack";
import {
  buildSelfCheckRecord,
  parseLevelItems,
  type RawSelfCheckOutput,
} from "../../sepia/selfcheck/sepiaSelfCheck";
import { isSepiaSelfCheckDisabled } from "../../sepia/sepiaFlags";

export interface SepiaStructuralSelfCheckInput {
  novelId: string;
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  targetWordCount?: number | null;
  content: string;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  /** 机械门已经清零的事实，写进 prompt 让模型知道 L1 不必重判 */
  mechanicalSummary?: string;
  /** 上一轮自检未过的项，用于复跑对照 */
  previousFailures?: string[];
}

/** 未开启 / 已关闭 / 包缺这两段数据时返回 null：调用方据此跳过，不记"不可用" */
export async function runSepiaStructuralSelfCheck(
  input: SepiaStructuralSelfCheckInput,
): Promise<SepiaStructuralSelfCheckRecord | null> {
  if (isSepiaSelfCheckDisabled()) return null;
  const pack = getSepiaPack();
  const rubricGroups: SepiaRubricGroup[] = (pack.data.diagnosis?.groups ?? []).map((group) => ({
    key: group.key,
    title: group.title.replace(/\*\*/g, ""),
    items: group.items,
  }));
  const levels = (pack.data.selfCheck?.levels ?? [])
    .filter((level) => level.key !== "L1")
    .map((level) => ({
      key: level.key,
      title: level.title.replace(/\*\*/g, ""),
      items: parseLevelItems(level.items),
    }));
  if (rubricGroups.length === 0 && levels.length === 0) return null;

  const stripped = (value: string) => value.replace(/\*\*/g, "");
  const result = await runStructuredPrompt({
    asset: sepiaStructuralSelfCheckPrompt,
    promptInput: {
      chapterOrder: input.chapterOrder,
      chapterTitle: input.chapterTitle,
      targetWordCount: input.targetWordCount ?? null,
      content: input.content,
      rubricGroups,
      usageNotes: (pack.data.diagnosis?.usage ?? []).map(stripped),
      levels,
      falsePositiveWarnings: (pack.data.selfCheck?.falsePositiveWarnings ?? []).map((warning) => ({
        ...warning,
        feature: stripped(warning.feature),
      })),
      passCriteria: (pack.data.selfCheck?.passCriteria ?? []).map(stripped),
      mechanicalSummary: input.mechanicalSummary ?? "L1 硬伤已清零，本次不重判 L1。",
      previousFailures: input.previousFailures,
    },
    options: {
      provider: input.provider,
      model: input.model,
      // 自检要稳，不要创作性：温度压到 0.2 以下
      temperature: Math.min(input.temperature ?? 0.2, 0.3),
      maxTokens: 3200,
      novelId: input.novelId,
      chapterId: input.chapterId,
      stage: "chapter_acceptance",
      triggerReason: "sepia_structural_self_check",
    },
  });

  return buildSelfCheckRecord({
    raw: result.output as RawSelfCheckOutput,
    pack,
    content: input.content,
    model: input.model ?? "",
  });
}
