/**
 * 把「本章用哪几招」落到 Chapter.sepiaTechKeysJson
 *
 * 为什么要落库：下一章的契约要靠它做「最近 3 章用过的招降权」，
 * 事后再看「这章到底按哪几招写的」也要有据可查。写一次就不再覆盖，
 * 保证同一章在多次重跑中技法稳定（可复现）。
 */

import { prisma } from "../../../db/prisma";
import { isSepiaDisabled } from "../sepiaFlags";
import { readSelectedIds, selectTechniques, serializeSelection } from "./sepiaTechniques";

export interface EnsureTechniquesResult {
  /** 本章最终使用的技法 id；写库失败时也返回，供本次生成使用 */
  techniqueIds: string[];
  roleKey: string;
  /** true = 本次新写入；false = 已有记录或写库失败 */
  persisted: boolean;
}

export async function ensureChapterTechniques(input: {
  novelId: string;
  chapterId: string;
  chapterOrder: number;
}): Promise<EnsureTechniquesResult | null> {
  if (isSepiaDisabled()) {
    return null;
  }
  const chapter = await prisma.chapter.findFirst({
    where: { id: input.chapterId, novelId: input.novelId },
    select: { id: true, sepiaTechKeysJson: true },
  });
  if (!chapter) return null;

  const existing = readSelectedIds(chapter.sepiaTechKeysJson);
  if (existing.length > 0) {
    return {
      techniqueIds: existing,
      roleKey: readRoleKey(chapter.sepiaTechKeysJson),
      persisted: false,
    };
  }

  const [novel, recentChapters] = await Promise.all([
    prisma.novel.findUnique({
      where: { id: input.novelId },
      select: {
        title: true,
        genre: { select: { name: true, description: true } },
        primaryStoryMode: { select: { name: true, description: true } },
      },
    }),
    prisma.chapter.findMany({
      where: {
        novelId: input.novelId,
        order: { lt: input.chapterOrder },
        sepiaTechKeysJson: { not: null },
      },
      orderBy: { order: "desc" },
      take: 3,
      select: { sepiaTechKeysJson: true },
    }),
  ]);

  const searchText = [
    novel?.title ?? "",
    novel?.genre?.name ?? "",
    novel?.genre?.description ?? "",
    novel?.primaryStoryMode?.name ?? "",
    novel?.primaryStoryMode?.description ?? "",
  ].filter(Boolean).join(" ");

  const selection = selectTechniques({
    text: searchText,
    usedRecently: recentChapters.flatMap((row) => readSelectedIds(row.sepiaTechKeysJson)),
  });

  const payload = serializeSelection(selection);
  try {
    await prisma.chapter.update({
      where: { id: chapter.id },
      data: { sepiaTechKeysJson: payload },
    });
    return {
      techniqueIds: selection.techniques.map((item) => item.id),
      roleKey: selection.roleKey,
      persisted: true,
    };
  } catch (error) {
    console.warn("[sepia] persist techniques failed", {
      novelId: input.novelId,
      chapterId: input.chapterId,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      techniqueIds: selection.techniques.map((item) => item.id),
      roleKey: selection.roleKey,
      persisted: false,
    };
  }
}

function readRoleKey(raw: string | null | undefined): string {
  if (!raw) return "general";
  try {
    const parsed = JSON.parse(raw) as { roleKey?: unknown };
    return typeof parsed.roleKey === "string" ? parsed.roleKey : "general";
  } catch {
    return "general";
  }
}
