/**
 * sepia 规则包类型（对应 pack/rules.compiled.json）
 *
 * 约束：这里的 data 只有"数据"，没有任何判定逻辑。
 * 阈值不在包里——lint.py 的阈值是内嵌字面量，抽取等于改写，
 * 所以阈值写在 sepiaLint.ts 里逐字转写，并标注来源行号。
 */

export type SepiaLevel = 'ok' | 'warn' | 'err' | 'info';

/** 修法分流：mechanical=形态即问题（仍需上下文判断才安全）/ semantic=可能承担叙事功能 */
export type SepiaReview = 'mechanical' | 'semantic';

export interface SepiaFinding {
  item: string;
  level: SepiaLevel;
  detail: string;
  /** 只有 deslop 侧的 advisory 才带 review；sepia 自有项不带 */
  review?: SepiaReview;
}

export interface SepiaLintStats {
  chars: number;
  paras: number;
  sents: number;
}

export interface SepiaSentencePattern {
  name: string;
  regex: string;
}

export interface SepiaPackMeta {
  packName: string;
  packVersion: string;
  builtAt: string;
  contentHash: string;
  sourceHash: string;
  quoteConvention: string;
  sourceFileCount?: number;
  counts?: Record<string, number>;
  notes?: string[];
}

/** 人味技法（techniques.md 的 30 条，编译期提取，措辞不改） */
export interface SepiaTechnique {
  id: string;
  no: number;
  name: string;
  /** 原标签，如「底层」「必上」「换骨」「按类型」 */
  tags: string[];
  /** base=甲部底层 / core=乙部换骨 / extra=丙部特色 */
  part: "base" | "core" | "extra" | string;
  summary: string;
}

/** 5 类角色（roles.md） */
export interface SepiaRole {
  key: string;
  no: number;
  name: string;
  persona: string;
  signals: string[];
  mustUseTechniques: string[];
  bannedWords: string[];
}

/** 禁用词表按 banned-words.md 的分节（导入规则时按组聚合，避免 153 条规则） */
export interface SepiaBannedWordGroup {
  key: string;
  title: string;
  words: string[];
}

/** 编译期聚合出的 AntiAiRule 种子（6 组词表 + 9 条句式 = 15 条） */
export interface SepiaAntiAiRuleSeed {
  key: string;
  name: string;
  type: "forbidden" | "risk" | "encourage";
  severity: "low" | "medium" | "high";
  description: string;
  detectPatterns: string[];
  promptInstruction: string;
  autoRewrite: boolean;
  enabled: boolean;
  globalBaselineEnabled: boolean;
}

/** 第 2 层 篇章（discourse-pass.md）：毛病表 + 位置表 */
export interface SepiaDiscourseTable {
  kind: "flaws" | "positions" | "other" | string;
  header: string[];
  rows: Array<Record<string, string>>;
}

export interface SepiaDiscourseSection {
  key: string;
  title: string;
  tables: SepiaDiscourseTable[];
  bullets: string[];
}

/** 网文体检表（rubric.md）：5 组、29 项，一项一条 */
export interface SepiaDiagnosisItem {
  item: string;
  detect: string;
  good: string;
  fix: string;
}

export interface SepiaDiagnosisGroup {
  key: string;
  title: string;
  items: SepiaDiagnosisItem[];
}

export interface SepiaDiagnosis {
  usage: string[];
  groups: SepiaDiagnosisGroup[];
}

/** 自检清单（selfcheck.md）：L1–L4 分层 + 误伤警告 + 通过标准 */
export interface SepiaSelfCheckLevel {
  key: string;
  title: string;
  items: string[];
}

export interface SepiaFalsePositiveWarning {
  feature: string;
  threshold: string;
  note: string;
}

export interface SepiaSelfCheck {
  levels: SepiaSelfCheckLevel[];
  falsePositiveWarnings: SepiaFalsePositiveWarning[];
  passCriteria: string[];
  doubleTests: string[];
  quickCheck: string[];
}

/** 第 0 层 台账（state-schema.md）：6 节字段模板 */
export interface SepiaStateTable {
  header: string[];
  rows: string[][];
  rowCount: number;
}

export interface SepiaStateSection {
  key: string;
  title: string;
  tables: SepiaStateTable[];
  bullets: string[];
}

/** 各模型写作惯性（model-fingerprints.md） */
export interface SepiaModelFingerprint {
  key: string;
  title: string;
  summary: string;
  traits: string[];
  fixes: string[];
}

export interface SepiaModelFingerprints {
  models: SepiaModelFingerprint[];
  humanSignals: Array<{ feature: string; how: string }>;
}

export interface SepiaPackData {
  bannedWords: string[];
  sentencePatterns: SepiaSentencePattern[];
  softWords: string[];
  techniques: SepiaTechnique[];
  roles: SepiaRole[];
  bannedWordGroups: SepiaBannedWordGroup[];
  antiAiRuleSeeds: SepiaAntiAiRuleSeed[];
  /** 以下为参考文档的结构化转写，0.5.1 之前的包没有这些字段 */
  discourse?: SepiaDiscourseSection[];
  diagnosis?: SepiaDiagnosis;
  selfCheck?: SepiaSelfCheck;
  stateLedger?: SepiaStateSection[];
  modelFingerprints?: SepiaModelFingerprints;
}

export interface SepiaPack {
  meta: SepiaPackMeta;
  data: SepiaPackData;
}
