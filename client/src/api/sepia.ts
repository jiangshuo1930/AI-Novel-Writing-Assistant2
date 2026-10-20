/**
 * sepia 合并层 API 封装
 *
 * 全部走 `apiClient`（baseURL 已含 `/api`），所以这里的路径都从 `/sepia` 起。
 * 类型一律来自 `@ai-novel/shared/types/sepia`，不在客户端重定义。
 *
 * 两点约定：
 *   - `gate`/`lint` 是子进程调用，慢是正常的；调用方要自己给 loading 与超时文案，
 *     不要因为 3 秒没回就当成失败。
 *   - 保存架构表的 400 是**业务结果**（有 blocked 项），不是网络错误。这里用
 *     `silentErrorStatuses: [400]` 压掉全局 toast，让调用方自己按 gaps 渲染。
 */

import type { ApiResponse } from "@ai-novel/shared/types/api";
import type {
  SepiaBlueprintGateMode,
  SepiaBlueprintValidation,
  SepiaChapterBlueprint,
  SepiaGateReport,
  SepiaGateStatusRecord,
  SepiaPackImportDiff,
  SepiaPackInfo,
  SepiaSelfCheckView,
  SepiaRoleTemplateItem,
  SepiaTechniquesResponse,
  SepiaVolumeDiagnostics,
} from "@ai-novel/shared/types/sepia";
import { apiClient } from "./client";

const GATE_TIMEOUT_MS = 60_000;

export async function getSepiaPackInfo() {
  const { data } = await apiClient.get<ApiResponse<SepiaPackInfo>>("/sepia/packs");
  return data;
}

/** 纯机械校验（lint.py --no-deslop），编辑器实时用；比 gate 快 */
export async function runSepiaLint(content: string) {
  const { data } = await apiClient.post<ApiResponse<SepiaGateReport>>(
    "/sepia/lint",
    { content },
    { timeout: GATE_TIMEOUT_MS, silentErrorStatuses: [400] },
  );
  return data;
}

/** 完整机械门（lint + deslop）；同一份报告，但多了去味检测器 */
export async function runSepiaGate(content: string) {
  const { data } = await apiClient.post<ApiResponse<SepiaGateReport>>(
    "/sepia/gate",
    { content },
    { timeout: GATE_TIMEOUT_MS, silentErrorStatuses: [400] },
  );
  return data;
}

export async function getChapterBlueprint(chapterId: string) {
  const { data } = await apiClient.get<
    ApiResponse<{ blueprint: SepiaChapterBlueprint | null; validation: SepiaBlueprintValidation }>
  >(`/sepia/chapters/${chapterId}/blueprint`, { silentErrorStatuses: [404] });
  return data;
}

/** 自检口径：L1 已由机械门自动化，接口只给 L2–L4 + 误伤警告 */
export async function getSepiaSelfCheck() {
  const { data } = await apiClient.get<ApiResponse<SepiaSelfCheckView>>("/sepia/self-check");
  return data;
}

/** 门结论落库记录：只在验收跑过门之后才有，没有就返回 null */
export async function getSepiaGateStatus(chapterId: string) {
  const { data } = await apiClient.get<ApiResponse<SepiaGateStatusRecord | null>>(
    `/sepia/chapters/${chapterId}/gate-status`,
    { silentErrorStatuses: [404] },
  );
  return data;
}

/**
 * 保存架构表。`allowBlocked=true` 用于「边写边补」的草稿态：
 * blocked 也允许存，但生成前门仍会拦——这里不替服务端做判断。
 */
export async function saveChapterBlueprint(
  chapterId: string,
  blueprint: SepiaChapterBlueprint,
  options: { allowBlocked?: boolean } = {},
) {
  const { data } = await apiClient.put<
    ApiResponse<{ blueprint: SepiaChapterBlueprint; validation: SepiaBlueprintValidation }>
  >(
    `/sepia/chapters/${chapterId}/blueprint`,
    { blueprint, allowBlocked: options.allowBlocked === true },
    { silentErrorStatuses: [400, 404] },
  );
  return data;
}

export async function getSepiaTechniques(params: { role?: string; text?: string; used?: string[] } = {}) {
  const { data } = await apiClient.get<ApiResponse<SepiaTechniquesResponse>>("/sepia/techniques", {
    params: {
      role: params.role,
      text: params.text,
      used: params.used?.join(","),
    },
  });
  return data;
}

export async function getSepiaRoleTemplates() {
  const { data } = await apiClient.get<ApiResponse<SepiaRoleTemplateItem[]>>("/sepia/role-templates");
  return data;
}

/**
 * 卷级诊断。
 *
 * `chapterOrders` 给了就只统计这些章（卷详情页用）；不给则按 `lastN` 取最近 N 章。
 * 两者不要同时传——服务端以 chapterOrders 优先，同时传只会让人误读 lastN 的含义。
 */
export async function getVolumeDiagnostics(
  novelId: string,
  options: { lastN?: number; chapterOrders?: number[] } = {},
) {
  const { data } = await apiClient.post<ApiResponse<SepiaVolumeDiagnostics>>(
    "/sepia/volume-diagnostics",
    { novelId, lastN: options.lastN, chapterOrders: options.chapterOrders },
    { silentErrorStatuses: [400, 404] },
  );
  return data;
}

export async function getBlueprintGateMode(novelId: string) {
  const { data } = await apiClient.get<ApiResponse<{ mode: SepiaBlueprintGateMode }>>(
    `/sepia/novels/${novelId}/blueprint-gate`,
    { silentErrorStatuses: [404] },
  );
  return data;
}

export async function setBlueprintGateMode(novelId: string, mode: SepiaBlueprintGateMode) {
  const { data } = await apiClient.put<ApiResponse<{ mode: SepiaBlueprintGateMode }>>(
    `/sepia/novels/${novelId}/blueprint-gate`,
    { mode },
    { silentErrorStatuses: [400, 404] },
  );
  return data;
}

/** dryRun=true 只看 diff，不写库 */
export async function importSepiaPackRules(options: { dryRun?: boolean } = {}) {
  const { data } = await apiClient.post<ApiResponse<SepiaPackImportDiff>>(
    "/sepia/packs/import",
    { dryRun: options.dryRun === true },
    { timeout: 120_000 },
  );
  return data;
}
