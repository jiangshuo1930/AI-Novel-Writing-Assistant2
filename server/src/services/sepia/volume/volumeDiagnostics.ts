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
import { getSepiaPack } from "../pack";

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
  /** 第 2 层篇章：discourse-pass.md 位置表里两项可机械近似的指标 */
  discourse: {
    paragraphRhythm: DerivedValue<{ paragraphs: number; evenRun: number; shortRatio: number }>;
    dialoguePlacement: DerivedValue<{ dialogueParagraphs: number; tailRatio: number }>;
    notes: string[];
  };
  /** 体检表轮转：按最新章号取一组（rubric.md「一次只看一组」） */
  diagnosis: {
    groupKey: string;
    title: string;
    items: Array<{ item: string; detect: string; good: string; fix: string }>;
    note: string;
  } | null;
  /** 第 0 层台账：6 节字段在 ANA 里的落点，缺的明说 */
  stateLedger: {
    sections: Array<{ key: string; title: string; mappedTo: string | null }>;
    mapped: number;
    total: number;
    note: string;
  };
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

/** 段落参差：连续段长度差在 20% 以内算「一样长」，≥3 段就是 discourse-pass 说的「差不多长」 */
export function computeParagraphRhythm(contents: string[]): VolumeDiagnostics["discourse"]["paragraphRhythm"] {
  const lengths: number[] = [];
  for (const content of contents) {
    for (const para of (content ?? "").split(/\n\s*\n/)) {
      const text = para.trim();
      if (text) lengths.push(text.length);
    }
  }
  if (lengths.length < 3) {
    return { value: null, source: "unavailable", note: "正文段落不足 3 段，判不出参差。" };
  }
  let longest = 1;
  let run = 1;
  for (let index = 1; index < lengths.length; index += 1) {
    const prev = lengths[index - 1];
    const current = lengths[index];
    const base = Math.max(prev, current, 1);
    if (Math.abs(current - prev) / base <= 0.2) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }
  const shortRatio = lengths.filter((length) => length <= 40).length / lengths.length;
  return {
    value: { paragraphs: lengths.length, evenRun: longest, shortRatio: Number(shortRatio.toFixed(2)) },
    source: "derived",
    note: "evenRun ≥3 表示连着三段差不多长；shortRatio 是 40 字以内短段占比。",
  };
}

/** 对话位置：discourse-pass 说「总在段末」是机器习惯，真人段中也有 */
export function computeDialoguePlacement(contents: string[]): VolumeDiagnostics["discourse"]["dialoguePlacement"] {
  let dialogueParagraphs = 0;
  let tailDialogue = 0;
  for (const content of contents) {
    for (const para of (content ?? "").split(/\n\s*\n/)) {
      const text = para.trim();
      if (!text) continue;
      if (!/[“”「」"]/.test(text)) continue;
      dialogueParagraphs += 1;
      if (/[”」"]$/.test(text)) tailDialogue += 1;
    }
  }
  if (dialogueParagraphs < 3) {
    return { value: null, source: "unavailable", note: "含对话的段落不足 3 段，判不出位置分布。" };
  }
  return {
    value: { dialogueParagraphs, tailRatio: Number((tailDialogue / dialogueParagraphs).toFixed(2)) },
    source: "derived",
    note: "tailRatio 是「引号收在段尾」的对话段占比；接近 1 说明对话总压在段末。",
  };
}

/** 台账 6 节 → ANA 现有字段；没有对应字段的写 null，不假装已覆盖 */
const LEDGER_MAPPING: ReadonlyArray<readonly [string, string]> = [
  ["一、", "worldState.locations + timeline"],
  ["二、", "characters[].resources（欠/被欠无对应字段）"],
  ["三、", "characters[].currentState / emotion / knownFacts"],
  ["四、", "narrative.pendingPayoffs"],
  ["五、", "narrative.suspenseThreads"],
  ["六、", "无对应字段（正文细节未入 CanonicalState）"],
];

export function buildStateLedgerCoverage(pack: {
  stateLedger?: Array<{ key: string; title: string }>;
}): VolumeDiagnostics["stateLedger"] {
  const sections = (pack.stateLedger ?? []).map((section) => {
    const hit = LEDGER_MAPPING.find(([prefix]) => section.title.startsWith(prefix));
    const mappedTo = hit && !hit[1].startsWith("无对应字段") ? hit[1] : null;
    return { key: section.key, title: section.title, mappedTo };
  });
  const mapped = sections.filter((section) => section.mappedTo).length;
  return {
    sections,
    mapped,
    total: sections.length,
    note: "台账不另建表：能对应上的按 ANA 字段读，对应不上的标 null，避免两套台账互相打脸。",
  };
}

/** 体检表轮转：一次只看一组，按最新章号推进 */
export function pickDiagnosisGroup(
  pack: { diagnosis?: { groups: Array<{ key: string; title: string; items: Array<{ item: string; detect: string; good: string; fix: string }> }> } },
  latestOrder: number,
): VolumeDiagnostics["diagnosis"] {
  const groups = pack.diagnosis?.groups ?? [];
  if (groups.length === 0) return null;
  const index = Math.abs(Math.max(latestOrder, 1) - 1) % groups.length;
  const group = groups[index];
  return {
    groupKey: group.key,
    title: group.title,
    items: group.items,
    note: `按章号轮转（共 ${groups.length} 组，当前第 ${index + 1} 组）；rubric.md 要求一次只看一组。`,
  };
}

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
    "篇章指标来自 discourse-pass.md 的位置表，只做机械近似，不构成通过线。",
  ];

  // 规则包不可用时诊断照样要出：这两块是附加信息，不能把它们变成新的单点故障。
  let packData: ReturnType<typeof getSepiaPack>["data"] | null = null;
  try {
    packData = getSepiaPack().data;
  } catch {
    packData = null;
  }
  const contents = ordered.map((chapter) => chapter.content ?? "");

  return {
    novelId,
    lastN,
    chapters: signals,
    hookTypes: signals.map((item) => item.hookType),
    repeatedHook: findRepeatedHook(signals),
    intensityWave: signals.map((item) => item.intensity),
    intensityIssues: findIntensityIssues(signals.map((item) => item.intensity)),
    discourse: {
      paragraphRhythm: computeParagraphRhythm(contents),
      dialoguePlacement: computeDialoguePlacement(contents),
      notes: [
        "段落参差与对话位置都只在这几章的正文字面上算，不看语义。",
        "数值只作提示：discourse-pass.md 明确这是判断层，没有通过线。",
      ],
    },
    diagnosis: packData ? pickDiagnosisGroup(packData, maxOrder) : null,
    stateLedger: packData
      ? buildStateLedgerCoverage(packData)
      : { sections: [], mapped: 0, total: 0, note: "规则包不可用，读不到台账模板。" },
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
