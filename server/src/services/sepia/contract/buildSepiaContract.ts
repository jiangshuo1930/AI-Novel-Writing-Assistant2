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

const PERSONA_MAX = 120;
const BANNED_TOP_N = 8;

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
  };
}

/** 把契约渲染成 block 正文（注入层调用） */
export function renderSepiaContractText(contract: SepiaWritingContract): string {
  const lines: string[] = [];
  if (contract.persona) {
    lines.push(`编辑视角：${contract.persona}`);
  }
  if (contract.techniques.length > 0) {
    lines.push("本章技法（选 3–5 招落地，不要全堆）：");
    for (const tech of contract.techniques) {
      lines.push(`- ${tech.name}${tech.instruction ? `：${tech.instruction}` : ""}`);
    }
  }
  if (contract.blueprintLines.length > 0) {
    lines.push("架构表已定：");
    for (const line of contract.blueprintLines) {
      lines.push(`- ${line}`);
    }
  }
  if (contract.bannedWords.length > 0) {
    lines.push(`本类型禁用词（不要出现）：${contract.bannedWords.join("、")}`);
  }
  return lines.join("\n");
}
