/**
 * 门的结论落库（对应 `Chapter.sepiaGateStatus`）
 *
 * 为什么单独存一份：门只在验收时跑一次，明细（findings）随报告走完就散了，
 * 章节刷新之后只剩 riskTags 里的 `sepia_blocking:N` 计数。这一列把
 * 「这章上次过没过门、几条硬伤、用的哪个包版本」留下来，供编辑器与排障读取。
 *
 * 只记结论，不记明细：明细在 gate 报告里，落库会让 Chapter 行膨胀；
 * 需要明细时按同一版本重跑门即可（同样内容 → 同样结果）。
 */

import { prisma } from "../../../db/prisma";
import type { SepiaStructuralSelfCheckRecord } from "@ai-novel/shared/types/sepia";
import type { SepiaGateReport } from "./SepiaGateService";

export type SepiaGateVerdict = "passed" | "blocked" | "unavailable";

export interface PersistedSepiaGateStatus {
  schemaVersion: 1;
  verdict: SepiaGateVerdict;
  blocking: number;
  advisory: number;
  deslop: string;
  packVersion: string;
  /** 正文指纹：与同章当前正文对比即可判断这条结论是否过期 */
  contentHash: string;
  checkedAt: string;
  /** 结构自检只存计数与结论；明细在自检报告里 */
  selfCheck?: {
    verdict: "pass" | "fail" | "unavailable";
    blocking: number;
    advisory: number;
    summary: string;
    checkedAt: string;
  };
}

export function buildSepiaGateStatus(
  report: SepiaGateReport | null,
  degraded: boolean,
  now: Date = new Date(),
  selfCheck?: SepiaStructuralSelfCheckRecord | null,
): PersistedSepiaGateStatus {
  const selfCheckRecord = selfCheck
    ? {
      verdict: selfCheck.verdict,
      blocking: selfCheck.blocking.length,
      advisory: selfCheck.advisory.length,
      summary: selfCheck.summary,
      checkedAt: selfCheck.checkedAt,
    }
    : undefined;
  if (!report) {
    return {
      schemaVersion: 1,
      verdict: "unavailable",
      blocking: 0,
      advisory: 0,
      deslop: "skipped",
      packVersion: "",
      contentHash: "",
      checkedAt: now.toISOString(),
      ...(selfCheckRecord ? { selfCheck: selfCheckRecord } : {}),
    };
  }
  return {
    schemaVersion: 1,
    verdict: degraded ? "unavailable" : report.blockingCount > 0 ? "blocked" : "passed",
    blocking: report.blockingCount,
    advisory: report.advisoryCount,
    deslop: report.deslop,
    packVersion: report.packVersion,
    contentHash: report.contentHash,
    checkedAt: now.toISOString(),
    ...(selfCheckRecord ? { selfCheck: selfCheckRecord } : {}),
  };
}

/** 坏数据按「没有结论」处理，不猜 */
export function parseSepiaGateStatus(raw: string | null | undefined): PersistedSepiaGateStatus | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSepiaGateStatus>;
    if (typeof parsed?.verdict !== "string" || typeof parsed?.blocking !== "number") return null;
    const selfCheck = parsed.selfCheck && typeof parsed.selfCheck.verdict === "string"
      ? {
        verdict: parsed.selfCheck.verdict,
        blocking: typeof parsed.selfCheck.blocking === "number" ? parsed.selfCheck.blocking : 0,
        advisory: typeof parsed.selfCheck.advisory === "number" ? parsed.selfCheck.advisory : 0,
        summary: typeof parsed.selfCheck.summary === "string" ? parsed.selfCheck.summary : "",
        checkedAt: typeof parsed.selfCheck.checkedAt === "string" ? parsed.selfCheck.checkedAt : "",
      }
      : undefined;
    return {
      schemaVersion: 1,
      verdict: parsed.verdict as SepiaGateVerdict,
      blocking: parsed.blocking,
      advisory: typeof parsed.advisory === "number" ? parsed.advisory : 0,
      deslop: typeof parsed.deslop === "string" ? parsed.deslop : "skipped",
      packVersion: typeof parsed.packVersion === "string" ? parsed.packVersion : "",
      contentHash: typeof parsed.contentHash === "string" ? parsed.contentHash : "",
      checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : "",
      ...(selfCheck ? { selfCheck } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 写库是**尽力而为**：门结论丢了不影响正文与验收结论，
 * 所以这里吞掉异常，只打一条 warn。
 */
export async function saveSepiaGateStatus(chapterId: string, status: PersistedSepiaGateStatus): Promise<void> {
  if (!chapterId) return;
  try {
    await prisma.chapter.update({
      where: { id: chapterId },
      data: { sepiaGateStatus: JSON.stringify(status) },
    });
  } catch (error) {
    console.warn("[sepia] 门结论落库失败（不影响本章结果）", {
      chapterId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
