/**
 * sepia 机械门路由（只读，P1）
 *
 *   GET  /api/sepia/packs   规则包信息（版本、哈希、词表规模）
 *   POST /api/sepia/lint    纯机械校验（对应 lint.py --no-deslop），编辑器实时用
 *   POST /api/sepia/gate    完整门（lint + deslop）
 *
 * 这一层**只报告，不阻断、不写库**。P2 才把 blocking 接进验收与 pass 判定。
 * 规则包缺失或被改动时返回 500 并把原因带出来——不静默降级成"没有发现问题"。
 */

import { Router } from "express";
import type { Response } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { authMiddleware } from "../middleware/auth";
import { prisma } from "../db/prisma";
import type { SepiaGateReport } from "../services/sepia/gate/SepiaGateService";
import { getSepiaGate, getSepiaPack } from "../services/sepia/pack";
import {
  normalizeBlueprint,
  parseBlueprint,
  validateBlueprint,
} from "../services/sepia/blueprint/sepiaBlueprint";
import type { BlueprintValidation, ChapterBlueprint } from "../services/sepia/blueprint/sepiaBlueprint";
import { selectTechniques } from "../services/sepia/techniques/sepiaTechniques";
import type { TechniqueSelection } from "../services/sepia/techniques/sepiaTechniques";
import { diagnoseVolume } from "../services/sepia/volume/volumeDiagnostics";
import type { VolumeDiagnostics } from "../services/sepia/volume/volumeDiagnostics";
import { importSepiaPackRules } from "../services/sepia/pack/sepiaPackImport";
import type { PackImportDiff } from "../services/sepia/pack/sepiaPackImport";

const router = Router();

router.use(authMiddleware);

/** 单章正文上限：sepia 本体是文件工具，这里只防误传整个书稿 */
const MAX_CONTENT_CHARS = 200_000;

interface SepiaPackInfo {
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

function readContent(body: unknown): { content?: string; error?: string } {
  if (!body || typeof body !== "object") return { error: "请求体必须是 JSON 对象。" };
  const raw = (body as { content?: unknown }).content;
  if (typeof raw !== "string") return { error: "content 必须是字符串。" };
  if (!raw.trim()) return { error: "content 不能为空。" };
  if (raw.length > MAX_CONTENT_CHARS) {
    return { error: `content 超过 ${MAX_CONTENT_CHARS} 字符上限。` };
  }
  return { content: raw };
}

function failure(res: Response, error: unknown, status = 500): void {
  const message = error instanceof Error ? error.message : String(error);
  const payload: ApiResponse<never> = { success: false, error: message };
  res.status(status).json(payload);
}

router.get("/packs", (_req, res) => {
  try {
    const pack = getSepiaPack();
    const data: SepiaPackInfo = {
      packVersion: pack.meta.packVersion,
      contentHash: pack.meta.contentHash,
      sourceHash: pack.meta.sourceHash,
      builtAt: pack.meta.builtAt,
      quoteConvention: pack.meta.quoteConvention,
      counts: {
        bannedWords: pack.data.bannedWords.length,
        sentencePatterns: pack.data.sentencePatterns.length,
        softWords: pack.data.softWords.length,
      },
    };
    const payload: ApiResponse<SepiaPackInfo> = { success: true, data };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

async function runGate(content: string, noDeslop: boolean): Promise<SepiaGateReport> {
  return getSepiaGate().run(content, { noDeslop });
}

router.post("/lint", async (req, res) => {
  const parsed = readContent(req.body);
  if (!parsed.content) {
    const payload: ApiResponse<never> = { success: false, error: parsed.error };
    res.status(400).json(payload);
    return;
  }
  try {
    const data = await runGate(parsed.content, true);
    const payload: ApiResponse<SepiaGateReport> = { success: true, data };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

router.post("/gate", async (req, res) => {
  const parsed = readContent(req.body);
  if (!parsed.content) {
    const payload: ApiResponse<never> = { success: false, error: parsed.error };
    res.status(400).json(payload);
    return;
  }
  try {
    const data = await runGate(parsed.content, false);
    const payload: ApiResponse<SepiaGateReport> = { success: true, data };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

router.get("/techniques", (req, res) => {
  try {
    const pack = getSepiaPack();
    const roleParam = typeof req.query.role === "string" ? req.query.role : "";
    const textParam = typeof req.query.text === "string" ? req.query.text : "";
    const usedParam = typeof req.query.used === "string" ? req.query.used : "";
    const usedRecently = usedParam.split(",").map((item) => item.trim()).filter(Boolean);
    const selection = selectTechniques({
      roleKey: roleParam || undefined,
      text: textParam,
      usedRecently,
    });
    const payload: ApiResponse<{
      selection: TechniqueSelection;
      techniques: typeof pack.data.techniques;
      roles: typeof pack.data.roles;
    }> = {
      success: true,
      data: { selection, techniques: pack.data.techniques, roles: pack.data.roles },
    };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

router.post("/packs/import", async (req, res) => {
  const body = (req.body ?? {}) as { dryRun?: unknown };
  const dryRun = body.dryRun === true || req.query.dryRun === "1" || req.query.dryRun === "true";
  try {
    const data = await importSepiaPackRules({ dryRun });
    const payload: ApiResponse<PackImportDiff> = { success: true, data };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

router.get("/role-templates", async (_req, res) => {
  try {
    const pack = getSepiaPack();
    const keys = pack.data.roles.map((role) => `sepia-role-${role.key}`);
    const rows = await prisma.styleTemplate.findMany({
      where: { key: { in: keys } },
      select: { id: true, key: true, name: true, description: true },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const data = pack.data.roles.map((role) => {
      const template = byKey.get(`sepia-role-${role.key}`);
      return {
        roleKey: role.key,
        roleName: role.name,
        persona: role.persona,
        mustUseTechniques: role.mustUseTechniques,
        bannedWords: role.bannedWords,
        templateId: template?.id ?? null,
        templateName: template?.name ?? null,
      };
    });
    const payload: ApiResponse<typeof data> = { success: true, data };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

router.post("/volume-diagnostics", async (req, res) => {
  const body = (req.body ?? {}) as { novelId?: unknown; lastN?: unknown; chapterOrders?: unknown };
  const novelId = typeof body.novelId === "string" ? body.novelId.trim() : "";
  if (!novelId) {
    const payload: ApiResponse<never> = { success: false, error: "novelId 不能为空。" };
    res.status(400).json(payload);
    return;
  }
  const lastN = typeof body.lastN === "number" && Number.isFinite(body.lastN) ? body.lastN : undefined;
  const chapterOrders = Array.isArray(body.chapterOrders)
    ? body.chapterOrders.filter((order): order is number => typeof order === "number" && Number.isInteger(order) && order > 0)
    : undefined;
  try {
    const data = await diagnoseVolume({ novelId, lastN, chapterOrders });
    const payload: ApiResponse<VolumeDiagnostics> = { success: true, data };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

router.get("/novels/:novelId/blueprint-gate", async (req, res) => {
  try {
    const novel = await prisma.novel.findUnique({
      where: { id: req.params.novelId },
      select: { id: true, sepiaBlueprintGate: true },
    });
    if (!novel) {
      const payload: ApiResponse<never> = { success: false, error: "作品不存在。" };
      res.status(404).json(payload);
      return;
    }
    const mode = novel.sepiaBlueprintGate ?? "write";
    const payload: ApiResponse<{ mode: string }> = { success: true, data: { mode } };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

router.put("/novels/:novelId/blueprint-gate", async (req, res) => {
  const raw = (req.body ?? {}) as { mode?: unknown };
  const mode = typeof raw.mode === "string" ? raw.mode.trim().toLowerCase() : "";
  if (!["off", "write", "all"].includes(mode)) {
    const payload: ApiResponse<never> = { success: false, error: "mode 只能是 off / write / all。" };
    res.status(400).json(payload);
    return;
  }
  try {
    const novel = await prisma.novel.findUnique({
      where: { id: req.params.novelId },
      select: { id: true },
    });
    if (!novel) {
      const payload: ApiResponse<never> = { success: false, error: "作品不存在。" };
      res.status(404).json(payload);
      return;
    }
    await prisma.novel.update({
      where: { id: novel.id },
      data: { sepiaBlueprintGate: mode },
    });
    const payload: ApiResponse<{ mode: string }> = { success: true, data: { mode } };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

router.get("/chapters/:chapterId/blueprint", async (req, res) => {
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.chapterId },
      select: { id: true, novelId: true, order: true, sepiaBlueprintJson: true },
    });
    if (!chapter) {
      const payload: ApiResponse<never> = { success: false, error: "章节不存在。" };
      res.status(404).json(payload);
      return;
    }
    const previous = await prisma.chapter.findFirst({
      where: { novelId: chapter.novelId, order: { lt: chapter.order } },
      orderBy: { order: "desc" },
      select: { sepiaBlueprintJson: true },
    });
    const blueprint = parseBlueprint(chapter.sepiaBlueprintJson);
    const previousResult = parseBlueprint(previous?.sepiaBlueprintJson ?? null)?.result ?? "";
    const validation = validateBlueprint(blueprint, { previousResult });
    const payload: ApiResponse<{ blueprint: ChapterBlueprint | null; validation: BlueprintValidation }> = {
      success: true,
      data: { blueprint, validation },
    };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

router.put("/chapters/:chapterId/blueprint", async (req, res) => {
  const body = (req.body ?? {}) as { blueprint?: unknown; allowBlocked?: unknown };
  const blueprint = normalizeBlueprint(body.blueprint);
  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: req.params.chapterId },
      select: { id: true, novelId: true, order: true },
    });
    if (!chapter) {
      const payload: ApiResponse<never> = { success: false, error: "章节不存在。" };
      res.status(404).json(payload);
      return;
    }
    const previous = await prisma.chapter.findFirst({
      where: { novelId: chapter.novelId, order: { lt: chapter.order } },
      orderBy: { order: "desc" },
      select: { sepiaBlueprintJson: true },
    });
    const previousResult = parseBlueprint(previous?.sepiaBlueprintJson ?? null)?.result ?? "";
    const validation = validateBlueprint(blueprint, { previousResult });
    // allowBlocked=true 用于「边写边补」的草稿态：blocked 也允许存，生成前门仍会拦
    const allowBlocked = body.allowBlocked === true;
    if (!validation.ok && !allowBlocked) {
      const payload: ApiResponse<{ validation: BlueprintValidation }> = {
        success: false,
        error: `架构表有 ${validation.blockedCount} 项不合格，生成会被拦下。`,
        data: { validation },
      };
      res.status(400).json(payload);
      return;
    }
    await prisma.chapter.update({
      where: { id: chapter.id },
      data: { sepiaBlueprintJson: JSON.stringify(blueprint) },
    });
    const payload: ApiResponse<{ blueprint: ChapterBlueprint; validation: BlueprintValidation }> = {
      success: true,
      data: { blueprint, validation },
    };
    res.status(200).json(payload);
  } catch (error) {
    failure(res, error);
  }
});

export default router;
