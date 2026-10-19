/**
 * 生成前门（结构层）
 *
 * 语义（对应合并方案 §7.1）：
 *   - write 模式：架构表 blocked 就不生成，省钱省返工
 *   - continue / 批量导演：降级为 warning，避免卡住自动流水线
 *   - 书级开关 Novel.sepiaBlueprintGate：null/"write" 按上面两条；"all" 所有模式都拦；"off" 不拦
 *
 * 一条纪律：**章上没有架构表 == 不拦**。存量书都没有架构表，
 * 拿「未填」去拦会让所有老书一章都写不出来；填了但不合格才拦。
 */

import { prisma } from "../../../db/prisma";
import { isSepiaDisabled } from "../sepiaFlags";
import { parseBlueprint, validateBlueprint } from "./sepiaBlueprint";
import type { BlueprintGap } from "./sepiaBlueprint";

export type BlueprintGateMode = "off" | "write" | "all";

export type BlueprintRuntimeMode = "single" | "autopilot";

export interface BlueprintGateResult {
  blocked: boolean;
  mode: BlueprintGateMode;
  runtimeMode: BlueprintRuntimeMode;
  /** 章上有没有架构表 */
  blueprintMissing: boolean;
  blockedCount: number;
  warningCount: number;
  gaps: BlueprintGap[];
  /** 用于日志/问题摘要的一句话 */
  reason: string;
}

export class BlueprintGateBlockedError extends Error {
  readonly gaps: BlueprintGap[];

  constructor(message: string, gaps: BlueprintGap[]) {
    super(message);
    this.name = "BlueprintGateBlockedError";
    this.gaps = gaps;
  }
}

function normalizeMode(raw: string | null | undefined): BlueprintGateMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "off" || value === "all" || value === "write") return value;
  return "write";
}

export interface EvaluateBlueprintGateInput {
  novelId: string;
  chapterId: string;
  runtimeMode: BlueprintRuntimeMode;
}

export interface BlueprintGateDecisionInput {
  mode: BlueprintGateMode;
  runtimeMode: BlueprintRuntimeMode;
  blueprintMissing: boolean;
  blockedCount: number;
  warningCount: number;
  gaps: BlueprintGap[];
}

/**
 * 纯决策：谁该被拦。取数在 evaluateBlueprintGate，判定在这里，方便单测。
 *
 * 规则只有四条，按顺序：
 *   1. 没填架构表 → 不拦（存量书）
 *   2. 没有 blocked → 不拦
 *   3. off → 不拦（只记录）
 *   4. all 或 单章模式 → 拦；其余（批量/续写）降级
 */
export function decideBlueprintGate(input: BlueprintGateDecisionInput): BlueprintGateResult {
  const { mode, runtimeMode, blueprintMissing, blockedCount, warningCount, gaps } = input;
  const base: BlueprintGateResult = {
    blocked: false,
    mode,
    runtimeMode,
    blueprintMissing,
    blockedCount,
    warningCount,
    gaps,
    reason: "",
  };
  if (blueprintMissing) {
    return { ...base, reason: "本章未填架构表，不拦生成" };
  }
  if (blockedCount === 0) {
    return { ...base, reason: "架构表合格" };
  }
  const suffix = `架构表 ${blockedCount} 项不合格`;
  if (mode === "off") {
    return { ...base, reason: `${suffix}（书级开关 off，只记录）` };
  }
  if (mode === "all" || runtimeMode === "single") {
    return { ...base, blocked: true, reason: suffix };
  }
  return { ...base, reason: `${suffix}（批量模式降级为 warning）` };
}

/**
 * 读库 + 判定。
 */
export async function evaluateBlueprintGate(input: EvaluateBlueprintGateInput): Promise<BlueprintGateResult> {
  if (isSepiaDisabled()) {
    return decideBlueprintGate({
      mode: "off",
      runtimeMode: input.runtimeMode,
      blueprintMissing: true,
      blockedCount: 0,
      warningCount: 0,
      gaps: [],
    });
  }

  const [novel, chapter] = await Promise.all([
    prisma.novel.findUnique({
      where: { id: input.novelId },
      select: { sepiaBlueprintGate: true },
    }),
    prisma.chapter.findFirst({
      where: { id: input.chapterId, novelId: input.novelId },
      select: { id: true, order: true, sepiaBlueprintJson: true },
    }),
  ]);

  const mode = normalizeMode(novel?.sepiaBlueprintGate);
  if (!chapter) {
    return decideBlueprintGate({
      mode,
      runtimeMode: input.runtimeMode,
      blueprintMissing: true,
      blockedCount: 0,
      warningCount: 0,
      gaps: [],
    });
  }

  const blueprint = parseBlueprint(chapter.sepiaBlueprintJson);
  if (!blueprint) {
    return decideBlueprintGate({
      mode,
      runtimeMode: input.runtimeMode,
      blueprintMissing: true,
      blockedCount: 0,
      warningCount: 0,
      gaps: [],
    });
  }

  const validation = validateBlueprint(blueprint);
  return decideBlueprintGate({
    mode,
    runtimeMode: input.runtimeMode,
    blueprintMissing: false,
    blockedCount: validation.blockedCount,
    warningCount: validation.warningCount,
    gaps: validation.gaps,
  });
}

/** 校验并把不合格项抛出去；调用方拿到的是可直接进问题治理的错误 */
export async function assertBlueprintGate(input: EvaluateBlueprintGateInput): Promise<BlueprintGateResult> {
  const result = await evaluateBlueprintGate(input);
  if (result.blocked) {
    const detail = result.gaps
      .filter((item) => item.level === "blocked")
      .map((item) => item.reason)
      .join("；");
    throw new BlueprintGateBlockedError(`架构表 ${result.blockedCount} 项不合格：${detail}`, result.gaps);
  }
  return result;
}
