/**
 * 技法选择（生成前门 · 表达层）
 *
 * 判据来源（全部照抄，不发明）：
 *   - `references/zh-fiction/techniques.md` 第 17-19 行校准：
 *     「单篇最多 3–5 招，而且必须"减空洞"和"加颗粒"同时做（第 30 招）」
 *     「[底层]：人味底线。是"真人写作的样子"，不是招式。」→ 底层不占配额
 *   - `references/zh-fiction/roles.md` 每个角色的「改写重点（必上技法）」
 *
 * 确定性优先：不掷骰子、不调模型。同样的输入永远得到同一组结果，
 * 这样「这章用了哪几招」可复现、可写进 Chapter.sepiaTechKeysJson 供事后核对。
 */

import type { SepiaRole, SepiaTechnique } from "../types";
import { getSepiaPack } from "../pack";

/** 减空洞类：techniques.md 第 30 招，原文要求「必须同时做」 */
export const REDUCE_TECHNIQUE_ID = "tech30";

/** 加颗粒类：原文「闲笔 / 无用道具 / 感官偏见 / 私人印记」对应的招式 */
export const GRAIN_TECHNIQUE_IDS = ["tech15", "tech16", "tech21", "tech24", "tech26"];

export const TECHNIQUE_MIN = 3;
export const TECHNIQUE_MAX = 5;

export interface SelectedTechnique {
  id: string;
  no: number;
  name: string;
  summary: string;
  tags: string[];
  /** 为什么选它：角色必上 / 补足颗粒 / 强制减空洞 */
  reason: "role_required" | "grain_floor" | "reduce_floor";
}

export interface TechniqueSelection {
  roleKey: string;
  roleName: string;
  persona: string;
  bannedWords: string[];
  techniques: SelectedTechnique[];
}

/** 按信号词命中数匹配角色；全不命中走通用兜底（roles.md 第 5 行「匹配不上用通用小说编辑兜底」） */
export function matchRole(text: string, roles: SepiaRole[]): SepiaRole {
  const haystack = (text ?? "").toLowerCase();
  let best = roles.find((role) => role.key === "general") ?? roles[roles.length - 1];
  let bestScore = 0;
  for (const role of roles) {
    if (role.key === "general") continue;
    let score = 0;
    for (const signal of role.signals) {
      if (signal && haystack.includes(signal.toLowerCase())) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = role;
    }
  }
  return best;
}

function pickResult(
  role: SepiaRole,
  techniques: SepiaTechnique[],
  usedRecently: Set<string>,
): SelectedTechnique[] {
  const byId = new Map(techniques.map((item) => [item.id, item]));
  const chosen: SelectedTechnique[] = [];
  const take = (id: string, reason: SelectedTechnique["reason"]): boolean => {
    if (chosen.some((item) => item.id === id)) return false;
    const tech = byId.get(id);
    if (!tech) return false;
    chosen.push({ id: tech.id, no: tech.no, name: tech.name, summary: tech.summary, tags: tech.tags, reason });
    return true;
  };

  // 角色必上：按 roles.md 的顺序，近 3 章用过的排到后面（降权，不删除）
  const required = role.mustUseTechniques.filter((id) => byId.has(id));
  const fresh = required.filter((id) => !usedRecently.has(id));
  const stale = required.filter((id) => usedRecently.has(id));

  // 减空洞是硬要求，先占一席
  take(REDUCE_TECHNIQUE_ID, "reduce_floor");

  for (const id of [...fresh, ...stale]) {
    if (chosen.length >= TECHNIQUE_MAX) break;
    take(id, "role_required");
  }

  // 加颗粒至少一条；不足时用角色必上里的颗粒招补，仍不足则全库找
  if (!chosen.some((item) => GRAIN_TECHNIQUE_IDS.includes(item.id))) {
    const grainId =
      required.find((id) => GRAIN_TECHNIQUE_IDS.includes(id) && !chosen.some((item) => item.id === id))
      ?? techniques.find((tech) => GRAIN_TECHNIQUE_IDS.includes(tech.id) && !chosen.some((item) => item.id === tech.id))?.id;
    if (grainId) {
      if (chosen.length >= TECHNIQUE_MAX) chosen.pop();
      take(grainId, "grain_floor");
    }
  }

  // 下限 3：角色必上太少（如玄幻只有 3 条）时从乙部补，底层不占配额
  if (chosen.length < TECHNIQUE_MIN) {
    for (const tech of techniques) {
      if (chosen.length >= TECHNIQUE_MIN) break;
      if (tech.tags.includes("底层")) continue;
      take(tech.id, "grain_floor");
    }
  }

  return chosen.slice(0, TECHNIQUE_MAX);
}

export interface SelectTechniquesInput {
  /** 直接指定角色；不传时按 text 匹配 */
  roleKey?: string;
  /** 用于匹配角色的文本（书名 + 类型 + 简介） */
  text?: string;
  /** 最近 3 章用过的技法 id，降权用 */
  usedRecently?: string[];
}

export function selectTechniques(input: SelectTechniquesInput = {}): TechniqueSelection {
  const pack = getSepiaPack();
  const roles = pack.data.roles;
  const role = input.roleKey
    ? roles.find((item) => item.key === input.roleKey) ?? matchRole(input.text ?? "", roles)
    : matchRole(input.text ?? "", roles);
  const usedRecently = new Set(input.usedRecently ?? []);
  return {
    roleKey: role.key,
    roleName: role.name,
    persona: role.persona,
    bannedWords: role.bannedWords,
    techniques: pickResult(role, pack.data.techniques, usedRecently),
  };
}

/** 渲染成 prompt 用的短文本：每招一行「招式名：一句说明」，控制在 700 字预算内 */
export function renderTechniquesContract(selection: TechniqueSelection): string {
  if (selection.techniques.length === 0) return "";
  const lines = selection.techniques.map((tech) => {
    const summary = tech.summary.trim();
    return summary ? `${tech.name}：${summary}` : tech.name;
  });
  return lines.join("\n");
}

/** 把选择结果序列化进 Chapter.sepiaTechKeysJson */
export function serializeSelection(selection: TechniqueSelection): string {
  return JSON.stringify({
    roleKey: selection.roleKey,
    techniques: selection.techniques.map((tech) => tech.id),
    at: new Date().toISOString(),
  });
}

/** 读回历史选择，坏数据按空处理 */
export function readSelectedIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { techniques?: unknown };
    return Array.isArray(parsed.techniques) ? parsed.techniques.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
