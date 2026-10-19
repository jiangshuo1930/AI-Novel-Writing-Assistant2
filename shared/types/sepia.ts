/**
 * sepia 合并层的前后端线协议（wire contract）
 *
 * 这里是**客户端唯一可引用的 sepia 类型来源**。服务端各 service 仍持有自己的
 * 定义（那些定义附带判定逻辑的上下文注释），两边靠
 * `server/src/services/sepia/wireConformance.ts` 做双向赋值检查：
 * 任何一边偷偷加字段/改可选性，`tsc` 会当场报错。
 *
 * 纪律：本文件只放"长什么样"，不放任何阈值、白名单或判定规则。
 */

/* ------------------------------------------------------------------ *
 * 机械门报告（POST /api/sepia/lint、POST /api/sepia/gate）
 * ------------------------------------------------------------------ */

export type SepiaGateSeverity = "blocking" | "advisory";

/** 三层：字面 / 篇章 / 叙事。UI 按此分组，不用 severity 代替层 */
export type SepiaGateLayer = "surface" | "discourse" | "narrative";

/** 修法分流：mechanical=形态即问题（仍需读上下文）/ semantic=可能承担叙事功能 */
export type SepiaReviewMode = "mechanical" | "semantic";

export type SepiaDeslopStatus = "ok" | "unavailable" | "skipped";

export type SepiaFindingLevel = "ok" | "warn" | "err" | "info";

export interface SepiaGateFinding {
  /** `L1-1` / `lint:paragraph-rhythm` / `deslop:not-is-comparison` */
  checkId: string;
  severity: SepiaGateSeverity;
  layer: SepiaGateLayer;
  /** sepia 自有项没有这个概念，留 undefined 而不是替它编一个 */
  review?: SepiaReviewMode;
  /** 机械项恒为 false：定位精确，改法依赖上下文 */
  rewritable: boolean;
  /** 连续原文片段；sepia 项多数不带引文，此时为空串 */
  quote: string;
  /** 行号；只有 deslop 项给得出 */
  line: number | null;
  message: string;
  rawItem: string;
  rawDetail: string;
}

export interface SepiaGateStats {
  chars: number;
  paras: number;
  sents: number;
}

export interface SepiaGateRawFinding {
  item: string;
  level: SepiaFindingLevel;
  detail: string;
  review?: SepiaReviewMode;
}

export interface SepiaGateReport {
  packVersion: string;
  contentHash: string;
  deslop: SepiaDeslopStatus;
  /** false 表示 deslop 没跑成，blocking 数只覆盖 lint 部分 */
  deslopOk: boolean;
  stats: SepiaGateStats;
  blocking: SepiaGateFinding[];
  advisory: SepiaGateFinding[];
  blockingCount: number;
  advisoryCount: number;
  /** 与 `lint.py --json` 逐字一致的 items，供对照与排障，不参与分级 */
  raw: SepiaGateRawFinding[];
}

/* ------------------------------------------------------------------ *
 * 章节架构表（GET/PUT /api/sepia/chapters/:chapterId/blueprint）
 * ------------------------------------------------------------------ */

export type SepiaBlueprintField =
  | "want"
  | "obstacle"
  | "action"
  | "result"
  | "change"
  | "cliff"
  | "infoTiming"
  | "relations";

export interface SepiaBlueprintChange {
  position?: boolean;
  possession?: boolean;
  cognition?: boolean;
  relationship?: boolean;
}

export interface SepiaChapterBlueprint {
  want: string;
  obstacle: string;
  action: string;
  result: string;
  change: SepiaBlueprintChange;
  cliff: string;
  infoTiming: string;
  relations: string;
}

/** blocked=不放行生成；warning=只提醒 */
export type SepiaBlueprintGapLevel = "blocked" | "warning";

export interface SepiaBlueprintGap {
  field: SepiaBlueprintField;
  level: SepiaBlueprintGapLevel;
  /** 不合格的原因，直接对应 narrative-pass.md 的合格线表述 */
  reason: string;
  /** 原文片段，供 UI 定位；空串表示该字段没填 */
  quote: string;
}

export interface SepiaBlueprintValidation {
  ok: boolean;
  gaps: SepiaBlueprintGap[];
  blockedCount: number;
  warningCount: number;
}

export type SepiaBlueprintGateMode = "off" | "write" | "all";

/* ------------------------------------------------------------------ *
 * 技法与角色（GET /api/sepia/techniques）
 * ------------------------------------------------------------------ */

export interface SepiaTechniqueBrief {
  id: string;
  no: number;
  name: string;
  /** 原标签，如「底层」「必上」「换骨」「按类型」 */
  tags: string[];
  /** base=甲部底层 / core=乙部换骨 / extra=丙部特色 */
  part: string;
  summary: string;
}

export type SepiaTechniqueReason = "role_required" | "grain_floor" | "reduce_floor";

export interface SepiaSelectedTechnique {
  id: string;
  no: number;
  name: string;
  summary: string;
  tags: string[];
  /** 为什么选它：角色必上 / 补足颗粒 / 强制减空洞 */
  reason: SepiaTechniqueReason;
}

export interface SepiaTechniqueSelection {
  roleKey: string;
  roleName: string;
  persona: string;
  bannedWords: string[];
  techniques: SepiaSelectedTechnique[];
}

export interface SepiaRoleBrief {
  key: string;
  no: number;
  name: string;
  persona: string;
  signals: string[];
  mustUseTechniques: string[];
  bannedWords: string[];
}

export interface SepiaTechniquesResponse {
  selection: SepiaTechniqueSelection;
  techniques: SepiaTechniqueBrief[];
  roles: SepiaRoleBrief[];
}

/* ------------------------------------------------------------------ *
 * 规则包信息与导入（GET /api/sepia/packs、POST /api/sepia/packs/import）
 * ------------------------------------------------------------------ */

export interface SepiaPackInfo {
  packVersion: string;
  contentHash: string;
  sourceHash: string;
  builtAt: string;
  quoteConvention: string;
  counts: {
    bannedWords: number;
    sentencePatterns: number;
    softWords: number;
  };
}

export type SepiaPackRuleAction = "added" | "updated" | "unchanged" | "local_modified" | "foreign_key";

export interface SepiaPackRuleDiffItem {
  key: string;
  name: string;
  action: SepiaPackRuleAction;
  note: string;
}

export interface SepiaPackImportDiff {
  packVersion: string;
  dryRun: boolean;
  added: number;
  updated: number;
  unchanged: number;
  conflicts: SepiaPackRuleDiffItem[];
  items: SepiaPackRuleDiffItem[];
}

/* ------------------------------------------------------------------ *
 * 角色模板（GET /api/sepia/role-templates）
 * ------------------------------------------------------------------ */

export interface SepiaRoleTemplateItem {
  roleKey: string;
  roleName: string;
  persona: string;
  mustUseTechniques: string[];
  bannedWords: string[];
  templateId: string | null;
  templateName: string | null;
}

/* ------------------------------------------------------------------ *
 * 卷级诊断（POST /api/sepia/volume-diagnostics）
 * ------------------------------------------------------------------ */

export type SepiaHookType = "危" | "疑" | "变" | "求" | "断" | "静" | "unknown";

export interface SepiaVolumeChapterSignal {
  order: number;
  title: string;
  hook: string;
  hookType: SepiaHookType;
  conflictLevel: number | null;
  intensity: 1 | 2 | 3 | null;
}

/** 推不出来的值显式标 unavailable + null，不编数字 */
export interface SepiaDerivedValue<T> {
  value: T | null;
  source: "derived" | "unavailable";
  note: string;
}

export interface SepiaVolumeDiagnostics {
  novelId: string;
  lastN: number;
  chapters: SepiaVolumeChapterSignal[];
  hookTypes: SepiaHookType[];
  repeatedHook: { type: SepiaHookType; run: number; startOrder: number; endOrder: number } | null;
  intensityWave: Array<1 | 2 | 3 | null>;
  intensityIssues: string[];
  peakPositions: SepiaDerivedValue<number[]>;
  repeatedSkeleton: SepiaDerivedValue<string[]>;
  orphanForeshadows: {
    count: number;
    items: Array<{ title: string; status: string; lastTouchedOrder: number | null }>;
  };
  notes: string[];
}
