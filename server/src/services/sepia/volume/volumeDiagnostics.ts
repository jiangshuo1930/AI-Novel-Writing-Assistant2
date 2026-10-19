/**
 * 卷级诊断（只读，对应合并方案 §7.6 / arc-pass.md）
 *
 * 三件必须说清楚的事：
 *   1. 只输出建议，不阻断写作，不设通过线（方案 §13：blocked 次数只记录）
 *   2. 能推的推，推不出的明说「没有数据源」，不编数字
 *   3. 钩子分类是从 `Chapter.hook` 文本做的**机械近似**（arc-pass.md 只给了「长什么样」的例子，
 *      没有给判定脚本），命中不了就是 unknown，不硬猜
 */

import { prisma } from "../../../db/prisma";

export type HookType = "危" | "疑" | "变" | "求" | "断" | "静" | "unknown";

export interface VolumeChapterSignal {
  order: number;
  title: string;
  hook: string;
  hookType: HookType;
  conflictLevel: number | null;
  intensity: 1 | 2 | 3 | null;
}

export interface DerivedValue<T> {
  value: T | null;
  /** derived = 有数据源并已算出；unavailable = 缺数据源，不编 */
  source: "derived" | "unavailable";
  note: string;
}

export interface VolumeDiagnostics {
  novelId: string;
  lastN: number;
  chapters: VolumeChapterSignal[];
  hookTypes: HookType[];
  repeatedHook: { type: HookType; run: number; startOrder: number; endOrder: number } | null;
  intensityWave: Array<1 | 2 | 3 | null>;
  intensityIssues: string[];
  peakPositions: DerivedValue<number[]>;
  repeatedSkeleton: DerivedValue<string[]>;
  orphanForeshadows: { count: number; items: Array<{ title: string; status: string; lastTouchedOrder: number | null }> };
  notes: string[];
}

/** arc-pass.md 第 14-21 行六类钩子的「长什么样」直译成关键词 */
const HOOK_PATTERNS: Array<{ type: HookType; words: string[] }> = [
  { type: "危", words: ["有人", "蹲", "追", "刀", "血", "死", "杀", "危险", "威胁", "债主", "来人", "堵"] },
  { type: "疑", words: ["不对", "说不通", "明明", "为什么", "奇怪", "异常", "数了", "数到", "不可能", "怎么会"] },
  { type: "变", words: ["改口", "叫了", "认了", "身份", "变成", "原来是", "竟然是他", "称呼"] },
  { type: "求", words: ["必须", "要去找", "查清", "天亮之前", "今晚", "快去", "答应", "任务"] },
  { type: "断", words: ["愣住", "停住", "没说完", "半句", "忽然停", "门开了", "话没说完", "一声"] },
  { type: "静", words: ["安静", "灭了", "都平了", "太平", "没人说话", "影子", "很静"] },
];

export function classifyHook(hook: string | null | undefined): HookType {
  const text = (hook ?? "").trim();
  if (!text) return "unknown";
  let best: HookType = "unknown";
  let bestScore = 0;
  for (const pattern of HOOK_PATTERNS) {
    const score = pattern.words.reduce((sum, word) => (text.includes(word) ? sum + 1 : sum), 0);
    if (score > bestScore) {
      bestScore = score;
      best = pattern.type;
    }
  }
  return best;
}

function toIntensity(conflictLevel: number | null): 1 | 2 | 3 | null {
  if (conflictLevel === null || conflictLevel === undefined) return null;
  if (conflictLevel <= 2) return 1;
  if (conflictLevel === 3) return 2;
  return 3;
}

export function findRepeatedHook(chapters: VolumeChapterSignal[]): VolumeDiagnostics["repeatedHook"] {
  let run = 1;
  for (let index = 1; index < chapters.length; index += 1) {
    const current = chapters[index];
    const previous = chapters[index - 1];
    if (current.hookType !== "unknown" && current.hookType === previous.hookType) {
      run += 1;
      if (run >= 3) {
        return {
          type: current.hookType,
          run,
          startOrder: chapters[index - run + 1].order,
          endOrder: current.order,
        };
      }
    } else {
      run = 1;
    }
  }
  return null;
}

export function findIntensityIssues(wave: Array<1 | 2 | 3 | null>): string[] {
  const issues: string[] = [];
  const values = wave.filter((value): value is 1 | 2 | 3 => value !== null);
  if (values.length >= 4 && values.every((value) => value === 2)) {
    issues.push("全是二星：读者没有起伏感，也没有持续追读的理由。");
  }
  let run = 1;
  for (let index = 1; index < values.length; index += 1) {
    run = values[index] === 3 && values[index - 1] === 3 ? run + 1 : 1;
    if (run >= 4) {
      issues.push("连炸四章：第五个「爆炸」就不炸了。");
      break;
    }
  }
  if (values.length >= 6) {
    const period2 = values.every((value, index) => index < 2 || value === values[index - 2]);
    if (period2) {
      issues.push("规律得像钟摆：读者能算出来下一章强不强。");
    }
  }
  return issues;
}

export interface DiagnoseVolumeInput {
  novelId: string;
  lastN?: number;
  /**
   * 只诊断这些章节号（卷详情页用）。
   *
   * 为什么不用 volumeId：`Chapter` 上没有卷字段，卷与章的关联在
   * `VolumeChapterPlan` 里，而卷详情页本来就有本卷的章节号列表。
   * 直接传章节号比再写一遍关联查询更不容易错，也不会把别卷的章算进来。
   * 传了就完全按这个集合取，不再叠加 lastN 的"最近 N 章"语义。
   */
  chapterOrders?: number[];
}

export async function diagnoseVolume(input: DiagnoseVolumeInput): Promise<VolumeDiagnostics> {
  const pickedOrders = Array.isArray(input.chapterOrders)
    ? input.chapterOrders.filter((order) => Number.isInteger(order) && order > 0)
    : [];
  if (pickedOrders.length > 0) {
    return diagnoseByOrders(input.novelId, pickedOrders);
  }
  const lastN = Math.max(3, Math.min(input.lastN ?? 5, 12));
  const chapters = await prisma.chapter.findMany({
    where: { novelId: input.novelId },
    orderBy: { order: "desc" },
    take: lastN,
    select: CHAPTER_SIGNAL_SELECT,
  });
  return buildDiagnostics(input.novelId, chapters, lastN);
}

const CHAPTER_SIGNAL_SELECT = {
  order: true,
  title: true,
  hook: true,
  conflictLevel: true,
  content: true,
} as const;

type ChapterSignalRow = {
  order: number;
  title: string;
  hook: string | null;
  conflictLevel: number | null;
  content: string | null;
};

async function diagnoseByOrders(novelId: string, orders: number[]): Promise<VolumeDiagnostics> {
  const chapters = await prisma.chapter.findMany({
    where: { novelId, order: { in: orders } },
    select: CHAPTER_SIGNAL_SELECT,
  });
  return buildDiagnostics(novelId, chapters, chapters.length);
}

async function buildDiagnostics(
  novelId: string,
  chapters: ChapterSignalRow[],
  lastN: number,
): Promise<VolumeDiagnostics> {
  const ordered = [...chapters].sort((left, right) => left.order - right.order);
  const signals: VolumeChapterSignal[] = ordered.map((chapter) => ({
    order: chapter.order,
    title: chapter.title,
    hook: chapter.hook ?? "",
    hookType: classifyHook(chapter.hook),
    conflictLevel: chapter.conflictLevel ?? null,
    intensity: toIntensity(chapter.conflictLevel ?? null),
  }));

  const maxOrder = ordered.length > 0 ? ordered[ordered.length - 1].order : 0;
  const orphanRows = await prisma.payoffLedgerItem.findMany({
    where: {
      novelId,
      currentStatus: { in: ["setup", "hinted", "pending_payoff"] },
    },
    select: { title: true, currentStatus: true, lastTouchedChapterOrder: true },
    orderBy: { lastTouchedChapterOrder: "asc" },
    take: 50,
  });
  const orphanThreshold = maxOrder - 5;
  const orphans = orphanRows.filter((row) => (row.lastTouchedChapterOrder ?? 0) < orphanThreshold);

  const notes = [
    "钩子标签由 Chapter.hook 文本按 arc-pass.md 的例子做关键词近似，命中不了记 unknown，不硬猜。",
    "强度由 Chapter.conflictLevel 映射（≤2→一星、3→二星、≥4→三星），不是人工标注。",
  ];

  return {
    novelId,
    lastN,
    chapters: signals,
    hookTypes: signals.map((item) => item.hookType),
    repeatedHook: findRepeatedHook(signals),
    intensityWave: signals.map((item) => item.intensity),
    intensityIssues: findIntensityIssues(signals.map((item) => item.intensity)),
    peakPositions: {
      value: null,
      source: "unavailable",
      note: "章节内峰值位置需要正文段落级标注，当前没有数据源；不给估算值。",
    },
    repeatedSkeleton: {
      value: null,
      source: "unavailable",
      note: "场景骨架需要每章一句结构化摘要，当前 ChapterSummary 是自然语言，无法可靠归类。",
    },
    orphanForeshadows: {
      count: orphans.length,
      items: orphans.map((row) => ({
        title: row.title,
        status: row.currentStatus,
        lastTouchedOrder: row.lastTouchedChapterOrder ?? null,
      })),
    },
    notes,
  };
}
