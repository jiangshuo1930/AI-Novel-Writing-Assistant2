/**
 * 架构表 8 项校验（生成前门 · 结构层）
 *
 * 判据来源：sepia `references/narrative-pass.md` 第 9-21 行「架构表（写前必填，写完当自检清单）」。
 * 原文是一张人读表格（项 / 填什么 / 合格线），没有脚本实现。这里做的是**定性条款的机械近似**：
 * 只拦「明显没填」和「明显是空话」，不做语义判断，也不替作者补写。
 *
 * 因此本文件的词表全部是「原文合格线里点名的反面例子」的直译，不新增任何 sepia 没有的标准：
 *   - 想要什么：「不能是"变强""活下去"这种空话」
 *   - 阻碍：「必须有具体的人或规矩，不能只是"很难"」
 *   - 做了什么：「不能只"想了想"」
 *   - 结果：「必须有变化，不能原地踏步」
 *   - 实质变化：「位置/持有物/认知/关系，四选一」
 *   - 章末悬着：「不能是"未来会怎样"」
 *   - 信息给的时间点：「至少一条」→ warning
 *   - 出场人物关系：「不能人人对主角好」→ warning
 */

export type BlueprintField =
  | "want"
  | "obstacle"
  | "action"
  | "result"
  | "change"
  | "cliff"
  | "infoTiming"
  | "relations";

export interface BlueprintChange {
  position?: boolean;
  possession?: boolean;
  cognition?: boolean;
  relationship?: boolean;
}

export interface ChapterBlueprint {
  want: string;
  obstacle: string;
  action: string;
  result: string;
  change: BlueprintChange;
  cliff: string;
  infoTiming: string;
  relations: string;
}

export type BlueprintGapLevel = "blocked" | "warning";

export interface BlueprintGap {
  field: BlueprintField;
  level: BlueprintGapLevel;
  /** 不合格的原因，直接对应 narrative-pass.md 的合格线表述 */
  reason: string;
  /** 原文片段，供 UI 定位；空串表示该字段没填 */
  quote: string;
}

export interface BlueprintValidation {
  ok: boolean;
  gaps: BlueprintGap[];
  blockedCount: number;
  warningCount: number;
}

/** 「变强」「活下去」这类空话：整句去掉它们之后不剩实义，即视为空话 */
const VAGUE_WANTS = [
  "变强",
  "变厉害",
  "变更好",
  "变好",
  "活下去",
  "活下来",
  "成长",
  "突破",
  "报仇",
  "翻身",
  "成为最强",
  "成为天下第一",
  "得到力量",
];

/** 「很难」类空话；不含具体的人或规矩时不合格 */
const VAGUE_OBSTACLES = ["很难", "不容易", "太难", "很困难", "阻力很大", "环境恶劣", "运气不好", "对手很强"];

/** 连接词与虚词：去掉空话词后只剩这些，仍然算空话 */
const VAGUE_FILLERS = [
  "并且",
  "而且",
  "同时",
  "然后",
  "还要",
  "进而",
  "总之",
  "努力",
  "尽量",
  "一定要",
  "必须",
  "一定",
  "好好",
];

/** 具体阻碍的标志：一旦出现，就不再判为空话 */
const CONCRETE_OBSTACLE_MARKERS = [
  "规矩",
  "规定",
  "制度",
  "法律",
  "家法",
  "门规",
  "条约",
  "合同",
  "命令",
  "条例",
  "不许",
  "不准",
  "禁止",
  "拦",
  "挡",
  "盯",
  "守",
];

/** 整句只有一个心理动词 → 没有可见动作 */
const MENTAL_ONLY_PATTERN = /^(?:他|她|我|主角)?(?:只)?(?:想了想|想过|想了想办法|决定|打算|计划|考虑|犹豫|思考|琢磨)[。，,、\s]*$/;

/** 把悬念写成「未来会怎样」 */
const FUTURE_VAGUE_CLIFF = /未来(?:会|将)?(?:怎样|如何|怎么样)|以后(?:会|的事)|接下来(?:会|将)如何|后面(?:会|将)怎样|将会如何/;

/** 人人对主角好 = 没有旧账 */
const ALL_FRIENDLY_RELATIONS = /都很友好|人人都?对(?:主角|他|她)好|都对(?:主角|他|她)好|没有矛盾|关系融洽|人人友善|相处和睦|全员善意/;

const CHANGE_KEYS: Array<keyof BlueprintChange> = ["position", "possession", "cognition", "relationship"];
const CHANGE_LABELS: Record<keyof BlueprintChange, string> = {
  position: "位置",
  possession: "持有物",
  cognition: "认知",
  relationship: "关系",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 去掉标点与空白，用于「原地踏步」比较 */
function normalizeForCompare(value: string): string {
  return value.replace(/[\s，。！？、；：""''（）()【】…—\-·,.!?;:'"]/g, "");
}

function stripWords(value: string, words: string[]): string {
  let rest = value;
  for (const word of words) {
    rest = rest.split(word).join("");
  }
  return normalizeForCompare(rest);
}

function gap(field: BlueprintField, level: BlueprintGapLevel, reason: string, quote: string): BlueprintGap {
  return { field, level, reason, quote };
}

export interface ValidateBlueprintOptions {
  /** 上一章的结果，用于判断「原地踏步」；没有上一章时该判定退化为只查空 */
  previousResult?: string | null;
}

/**
 * 校验 8 项架构表。纯函数，不碰 DB、不调模型。
 *
 * blocked 由调用方决定怎么处置：
 *   - write 模式：不生成
 *   - continue / 批量导演：按方案降级为 warning 并补全，避免卡住自动流水线
 */
export function validateBlueprint(
  input: Partial<ChapterBlueprint> | null | undefined,
  options: ValidateBlueprintOptions = {},
): BlueprintValidation {
  const gaps: BlueprintGap[] = [];
  const bp = input ?? {};

  const want = text(bp.want);
  if (!want) {
    gaps.push(gap("want", "blocked", "未填「本章主角想要什么」。", ""));
  } else if (stripWords(want, [...VAGUE_WANTS, ...VAGUE_FILLERS]).length < 2) {
    gaps.push(gap("want", "blocked", "是空话（如「变强」「活下去」），不是这一章能动手去争的具体东西。", want));
  }

  const obstacle = text(bp.obstacle);
  if (!obstacle) {
    gaps.push(gap("obstacle", "blocked", "未填「阻碍」。", ""));
  } else if (
    VAGUE_OBSTACLES.some((word) => obstacle.includes(word))
    && !CONCRETE_OBSTACLE_MARKERS.some((word) => obstacle.includes(word))
  ) {
    gaps.push(gap("obstacle", "blocked", "只有「很难」这类空话，没有具体的人或规矩挡着。", obstacle));
  }

  const action = text(bp.action);
  if (!action) {
    gaps.push(gap("action", "blocked", "未填「他做了什么」。", ""));
  } else if (MENTAL_ONLY_PATTERN.test(action.replace(/\s+/g, ""))) {
    gaps.push(gap("action", "blocked", "只有心理活动，没有可见动作。", action));
  }

  const result = text(bp.result);
  if (!result) {
    gaps.push(gap("result", "blocked", "未填「结果」。", ""));
  } else {
    const previous = text(options.previousResult);
    if (previous && normalizeForCompare(previous) === normalizeForCompare(result)) {
      gaps.push(gap("result", "blocked", "结果与上一章相同，原地踏步。", result));
    }
  }

  const change = bp.change ?? {};
  const touched = CHANGE_KEYS.filter((key) => change[key] === true);
  if (touched.length === 0) {
    gaps.push(gap("change", "blocked", "位置 / 持有物 / 认知 / 关系 四项都没变。", ""));
  }

  const cliff = text(bp.cliff);
  if (!cliff) {
    gaps.push(gap("cliff", "blocked", "未填「章末悬着的事」。", ""));
  } else if (FUTURE_VAGUE_CLIFF.test(cliff)) {
    gaps.push(gap("cliff", "blocked", "写成了「未来会怎样」，不是一件具体没解决的事。", cliff));
  }

  const infoTiming = text(bp.infoTiming);
  if (!infoTiming) {
    gaps.push(gap("infoTiming", "warning", "没有指定压到后面给的信息（至少一条）。", ""));
  }

  const relations = text(bp.relations);
  if (!relations) {
    gaps.push(gap("relations", "warning", "未填「出场人物之间的关系」。", ""));
  } else if (ALL_FRIENDLY_RELATIONS.test(relations)) {
    gaps.push(gap("relations", "warning", "人人对主角好，没有旧账和矛盾。", relations));
  }

  const blockedCount = gaps.filter((item) => item.level === "blocked").length;
  const warningCount = gaps.filter((item) => item.level === "warning").length;
  return { ok: blockedCount === 0, gaps, blockedCount, warningCount };
}

/** 把变更项拼成一句人话，给 prompt / UI 复用 */
export function describeChange(change: BlueprintChange | null | undefined): string {
  const touched = CHANGE_KEYS.filter((key) => change?.[key] === true).map((key) => CHANGE_LABELS[key]);
  return touched.length > 0 ? touched.join("、") : "无";
}

/** 把 8 项渲染成 injectable 的短文本（生成期 sepia_contract 用，控制字数） */
export function renderBlueprintContract(blueprint: ChapterBlueprint | null | undefined): string {
  if (!blueprint) return "";
  const lines = [
    `想要什么：${text(blueprint.want) || "（未定）"}`,
    `阻碍：${text(blueprint.obstacle) || "（未定）"}`,
    `做了什么：${text(blueprint.action) || "（未定）"}`,
    `结果：${text(blueprint.result) || "（未定）"}`,
    `实质变化：${describeChange(blueprint.change)}`,
    `章末悬着：${text(blueprint.cliff) || "（未定）"}`,
  ];
  return lines.join("\n");
}

/** 把任意输入规整成 8 项结构（缺项补空串），不校验、不抛错 */
export function normalizeBlueprint(value: unknown): ChapterBlueprint {
  const source = value && typeof value === "object" ? (value as Partial<ChapterBlueprint>) : {};
  const change = source.change && typeof source.change === "object" ? source.change : {};
  return {
    want: text(source.want),
    obstacle: text(source.obstacle),
    action: text(source.action),
    result: text(source.result),
    change: {
      position: change.position === true,
      possession: change.possession === true,
      cognition: change.cognition === true,
      relationship: change.relationship === true,
    },
    cliff: text(source.cliff),
    infoTiming: text(source.infoTiming),
    relations: text(source.relations),
  };
}

/** 解析落库的 JSON，坏数据不抛错，按「没有架构表」处理 */
export function parseBlueprint(raw: string | null | undefined): ChapterBlueprint | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChapterBlueprint> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return normalizeBlueprint(parsed);
  } catch {
    return null;
  }
}
