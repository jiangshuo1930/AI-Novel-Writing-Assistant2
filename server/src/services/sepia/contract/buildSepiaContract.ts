/**
 * 生成期 sepia 契约（对应合并方案 §7.5）
 *
 * 预算：≈700 字 / 500 token。分四块：
 *   1. 角色人设一句（≤120 字）
 *   2. 本章 3–5 招（每招名 + 一句指令，见 techniques.md 的 summary）
 *   3. 架构表已定项（6 行，来自 narrative-pass.md 的表格）
 *   4. 类型专属禁词 top-8（roles.md「专属禁用词」）
 *
 * 契约是**可选**的：章上没有架构表也没有技法记录时返回 null，注入层直接不生成这个 block，
 * 保证「没开启 sepia 的书」行为与合并前逐字节一致。
 */

import type { SepiaWritingContract } from "@ai-novel/shared/types/chapterRuntime";
import { parseBlueprint } from "../blueprint/sepiaBlueprint";
import { matchRole, selectTechniques, readSelectedIds } from "../techniques/sepiaTechniques";
import { getSepiaPack } from "../pack";
import type { SepiaPack } from "../types";

const PERSONA_MAX = 120;
const BANNED_TOP_N = 8;

/** 甲部「底层」= 人味底线，原文要求「不占配额」，不是「永不使用」 */
const BASE_TAG = "底层";

/** discourse-pass.md 毛病表里最该在生成前就避开的三类 + 结尾升华 */
const DISCOURSE_FLAWS = ["流水账", "结尾升华", "全是后果", "一段到底"];

/** 模型 id → 指纹表的 key（fingerprints 表按厂商命名，模型名常带后缀） */
const MODEL_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["moonshot", "kimi"],
  ["kimi", "kimi"],
  ["deepseek", "deepseek"],
  ["claude", "claude"],
  ["anthropic", "claude"],
  ["gpt", "gpt"],
  ["openai", "gpt"],
  ["qwen", "qwen"],
  ["glm", "glm"],
  ["zhipu", "glm"],
];

export interface SepiaContractSource {
  chapter: {
    order: number;
    sepiaBlueprintJson?: string | null;
    sepiaTechKeysJson?: string | null;
  };
  novel: {
    title?: string | null;
    genre?: { name?: string | null; description?: string | null } | null;
    primaryStoryMode?: { name?: string | null; description?: string | null } | null;
  };
  /** 最近 3 章用过的技法，降权用；不传则不降权 */
  usedRecently?: string[];
  /** 当前生成用的模型 id/provider，用于查模型惯性；解析不出就不注入 */
  modelHint?: string | null;
}

/** 甲部 14 条底线的名字（不是招式，不进 3–5 招配额） */
export function baseTechniqueNames(pack: SepiaPack): string[] {
  return pack.data.techniques.filter((tech) => tech.tags.includes(BASE_TAG)).map((tech) => tech.name);
}

/** discourse-pass.md「每段在回答什么问题」里最常塌的四类 */
export function discourseLinesOf(pack: SepiaPack): string[] {
  const table = pack.data.discourse
    ?.flatMap((section) => section.tables)
    .find((item) => item.kind === "flaws");
  if (!table) return [];
  return table.rows
    .filter((row) => DISCOURSE_FLAWS.includes(row.flaw ?? ""))
    .map((row) => `${row.flaw}：${clip((row.fix ?? row.symptom ?? "").replace(/\*\*/g, ""), 48)}`);
}

/** model-fingerprints.md：当前模型的惯性一句 + 第一条改法 */
export function modelFingerprintOf(pack: SepiaPack, modelHint?: string | null): string | null {
  const hay = (modelHint ?? "").toLowerCase();
  if (!hay) return null;
  const hit = MODEL_ALIASES.find(([alias]) => hay.includes(alias));
  if (!hit) return null;
  const model = pack.data.modelFingerprints?.models.find((item) => item.key === hit[1]);
  if (!model) return null;
  const summary = model.summary || model.traits[0] || "";
  if (!summary) return null;
  const head = clip(summary.replace(/\s+/g, " ").trim(), 60).replace(/[；;]+$/, "");
  const withStop = /[。！？.!?]$/.test(head) ? head : `${head}。`;
  const fix = model.fixes[0] ? `改法：${clip(model.fixes[0], 50)}` : "";
  return `模型惯性（${model.key}）：${withStop}${fix}`;
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function roleSearchText(source: SepiaContractSource): string {
  return [
    source.novel.title ?? "",
    source.novel.genre?.name ?? "",
    source.novel.genre?.description ?? "",
    source.novel.primaryStoryMode?.name ?? "",
    source.novel.primaryStoryMode?.description ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildSepiaWritingContract(source: SepiaContractSource): SepiaWritingContract | null {
  const blueprint = parseBlueprint(source.chapter.sepiaBlueprintJson);
  const techIds = readSelectedIds(source.chapter.sepiaTechKeysJson);
  // 没有架构表也没有技法记录：这本书没用 sepia，别注入空壳
  if (!blueprint && techIds.length === 0) {
    return null;
  }

  const pack = getSepiaPack();
  const role = matchRole(roleSearchText(source), pack.data.roles);
  const selection = selectTechniques({
    roleKey: role.key,
    text: roleSearchText(source),
    usedRecently: source.usedRecently,
  });

  const byId = new Map(pack.data.techniques.map((item) => [item.id, item]));
  const chosen = techIds
    .map((id) => byId.get(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({ id: item.id, name: item.name, instruction: clip(item.summary, 60) }));

  const techniques = chosen.length > 0
    ? chosen
    : selection.techniques.map((item) => ({
      id: item.id,
      name: item.name,
      instruction: clip(item.summary, 60),
    }));

  const blueprintLines = blueprint
    ? [
      `想要什么：${clip(blueprint.want, 40)}`,
      `阻碍：${clip(blueprint.obstacle, 40)}`,
      `做了什么：${clip(blueprint.action, 40)}`,
      `结果：${clip(blueprint.result, 40)}`,
      `章末悬着：${clip(blueprint.cliff, 40)}`,
      `信息压后：${clip(blueprint.infoTiming, 30) || "（未定）"}`,
    ]
    : [];

  return {
    roleKey: role.key,
    roleName: role.name,
    persona: clip(role.persona, PERSONA_MAX),
    techniques,
    blueprintLines,
    bannedWords: role.bannedWords.slice(0, BANNED_TOP_N),
    baseTechniques: baseTechniqueNames(pack),
    discourseLines: discourseLinesOf(pack),
    modelFingerprint: modelFingerprintOf(pack, source.modelHint),
  };
}

/** 把契约渲染成 block 正文（注入层调用） */
export function renderSepiaContractText(contract: SepiaWritingContract): string {
  const lines: string[] = [];
  if (contract.persona) {
    lines.push(`编辑视角：${contract.persona}`);
  }
  // 底线放在招式前面：先有「真人写作的样子」，再谈这一章用哪几招。
  if (contract.baseTechniques.length > 0) {
    lines.push(`人味底线（常驻，不占本章招式配额，别摊成清单）：${contract.baseTechniques.join("、")}`);
  }
  if (contract.techniques.length > 0) {
    lines.push("本章技法（选 3–5 招落地，不要全堆）：");
    for (const tech of contract.techniques) {
      lines.push(`- ${tech.name}${tech.instruction ? `：${tech.instruction}` : ""}`);
    }
  }
  if (contract.discourseLines.length > 0) {
    lines.push("篇章安排（这几处最容易被读者滑走）：");
    for (const line of contract.discourseLines) {
      lines.push(`- ${line}`);
    }
  }
  if (contract.blueprintLines.length > 0) {
    lines.push("架构表已定：");
    for (const line of contract.blueprintLines) {
      lines.push(`- ${line}`);
    }
  }
  if (contract.modelFingerprint) {
    lines.push(contract.modelFingerprint);
  }
  if (contract.bannedWords.length > 0) {
    lines.push(`本类型禁用词（不要出现）：${contract.bannedWords.join("、")}`);
  }
  return lines.join("\n");
}
