/**
 * 规则包导入 / 升级（对应合并方案 §6.2 §6.3）
 *
 * 两个纪律：
 *   1. 153 个词不变成 153 条规则——包编译期已聚合成 15 条（6 组词表 + 9 条句式），
 *      全量词表仍由机械门在 lint 阶段使用。
 *   2. 导入幂等，且**绝不覆盖本地修改**：判据是「同 key + 同 packVersion + 内容不同」，
 *      说明这条规则是作者在包规则上改过的，只报 local_modified，不写库。
 */

import { prisma } from "../../../db/prisma";
import { getSepiaPack } from "./index";
import type { SepiaAntiAiRuleSeed } from "../types";

export type PackRuleAction = "added" | "updated" | "unchanged" | "local_modified" | "foreign_key";

export interface PackRuleDiffItem {
  key: string;
  name: string;
  action: PackRuleAction;
  note: string;
}

export interface PackImportDiff {
  packVersion: string;
  dryRun: boolean;
  added: number;
  updated: number;
  unchanged: number;
  conflicts: PackRuleDiffItem[];
  items: PackRuleDiffItem[];
}

export interface ExistingRuleRow {
  key: string;
  name: string;
  type: string;
  severity: string;
  description: string;
  detectPatternsJson: string | null;
  promptInstruction: string | null;
  packKey: string | null;
  packVersion: string | null;
}

const PACK_KEY = "sepia-webnovel";

function samePayload(row: ExistingRuleRow, seed: SepiaAntiAiRuleSeed): boolean {
  return row.name === seed.name
    && row.type === seed.type
    && row.severity === seed.severity
    && row.description === seed.description
    && (row.detectPatternsJson ?? "[]") === JSON.stringify(seed.detectPatterns)
    && (row.promptInstruction ?? "") === seed.promptInstruction;
}

/** 纯函数：算出每条规则该怎么处理，不写库 */
export function diffAntiAiSeeds(
  seeds: SepiaAntiAiRuleSeed[],
  existing: ExistingRuleRow[],
  packVersion: string,
): PackRuleDiffItem[] {
  const byKey = new Map(existing.map((row) => [row.key, row]));
  return seeds.map((seed) => {
    const row = byKey.get(seed.key);
    if (!row) {
      return { key: seed.key, name: seed.name, action: "added", note: "包内新增" };
    }
    if (row.packKey !== PACK_KEY) {
      return {
        key: seed.key,
        name: seed.name,
        action: "foreign_key",
        note: "同名 key 已被非包规则占用，不覆盖",
      };
    }
    if (samePayload(row, seed)) {
      return {
        key: seed.key,
        name: seed.name,
        action: "unchanged",
        note: row.packVersion === packVersion ? "内容与版本都一致" : "内容一致，仅更新版本号",
      };
    }
    if (row.packVersion === packVersion) {
      return {
        key: seed.key,
        name: seed.name,
        action: "local_modified",
        note: "同一版本下内容被本地改过，升级不覆盖",
      };
    }
    return { key: seed.key, name: seed.name, action: "updated", note: `从 ${row.packVersion ?? "未标注"} 升级` };
  });
}

export interface ImportOptions {
  dryRun?: boolean;
}

export async function importSepiaPackRules(options: ImportOptions = {}): Promise<PackImportDiff> {
  const pack = getSepiaPack();
  const seeds = pack.data.antiAiRuleSeeds;
  const packVersion = pack.meta.packVersion;
  const dryRun = options.dryRun === true;

  const rows = await prisma.antiAiRule.findMany({
    where: { key: { in: seeds.map((seed) => seed.key) } },
    select: {
      key: true,
      name: true,
      type: true,
      severity: true,
      description: true,
      detectPatternsJson: true,
      promptInstruction: true,
      packKey: true,
      packVersion: true,
    },
  });

  const items = diffAntiAiSeeds(seeds, rows, packVersion);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const seedByKey = new Map(seeds.map((seed) => [seed.key, seed]));

  if (!dryRun) {
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const seed = seedByKey.get(item.key);
        if (!seed) continue;
        const data = {
          name: seed.name,
          type: seed.type as never,
          severity: seed.severity as never,
          description: seed.description,
          detectPatternsJson: JSON.stringify(seed.detectPatterns),
          promptInstruction: seed.promptInstruction,
          autoRewrite: seed.autoRewrite,
          enabled: seed.enabled,
          globalBaselineEnabled: seed.globalBaselineEnabled,
          packKey: PACK_KEY,
          packVersion,
          ruleGroup: seed.key.split(".")[1] ?? null,
        };
        if (item.action === "added") {
          await tx.antiAiRule.create({ data: { key: item.key, ...data } });
        } else if (item.action === "updated" || (item.action === "unchanged" && byKey.get(item.key)?.packVersion !== packVersion)) {
          await tx.antiAiRule.update({ where: { key: item.key }, data });
        }
      }
    });
  }

  const count = (action: PackRuleAction) => items.filter((item) => item.action === action).length;
  return {
    packVersion,
    dryRun,
    added: count("added"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    conflicts: items.filter((item) => item.action === "local_modified" || item.action === "foreign_key"),
    items,
  };
}
