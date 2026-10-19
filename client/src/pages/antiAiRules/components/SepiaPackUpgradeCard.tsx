/**
 * 规则包来源与升级入口（反 AI 规则页顶部）
 *
 * 只做两件事：告诉作者"这批规则来自哪儿"，以及在包版本前进后把新增/更新的规则带进来。
 *
 * 三条不能松的边界（对应 P4-c 的导入语义）：
 *   1. **本地改过的规则不覆盖**。`local_modified` 只计数、只提示，导入时跳过。
 *   2. **先看差异再写库**。默认 dryRun，作者点"导入"才落盘。
 *   3. 包版本相同且无差异时整块收成一行，不占版面。
 */

import { useCallback, useEffect, useState } from "react";
import type { SepiaPackImportDiff, SepiaPackInfo } from "@ai-novel/shared/types/sepia";
import { RefreshCw, PackagePlus } from "lucide-react";
import { getSepiaPackInfo, importSepiaPackRules } from "@/api/sepia";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

interface Props {
  /** 导入成功后让上层重拉规则列表 */
  onImported?: () => void;
}

const ACTION_LABEL: Record<string, string> = {
  added: "新增",
  updated: "更新",
  local_modified: "本地已改（不覆盖）",
  foreign_key: "标识冲突（跳过）",
};

export default function SepiaPackUpgradeCard({ onImported }: Props) {
  const [pack, setPack] = useState<SepiaPackInfo | null>(null);
  const [diff, setDiff] = useState<SepiaPackImportDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [packResponse, diffResponse] = await Promise.all([
        getSepiaPackInfo(),
        importSepiaPackRules({ dryRun: true }),
      ]);
      if (packResponse.success && packResponse.data) {
        setPack(packResponse.data);
      } else if (!packResponse.success) {
        setError(packResponse.error ?? "规则包信息读取失败。");
      }
      if (diffResponse.success && diffResponse.data) {
        setDiff(diffResponse.data);
      } else if (!diffResponse.success) {
        setError(diffResponse.error ?? "规则包差异读取失败。");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleImport = async () => {
    setImporting(true);
    try {
      const response = await importSepiaPackRules({ dryRun: false });
      if (!response.success || !response.data) {
        toast.error(response.error ?? "规则包导入失败。");
        return;
      }
      const { added, updated, conflicts } = response.data;
      toast.success(
        `规则包 ${response.data.packVersion} 已导入：新增 ${added} 条，更新 ${updated} 条` +
          (conflicts.length ? `，跳过 ${conflicts.length} 条（本地已改或标识冲突）` : "") +
          "。",
      );
      onImported?.();
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "规则包导入失败。");
    } finally {
      setImporting(false);
    }
  };

  if (error) {
    return (
      <section aria-label="规则包来源" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 px-4 py-3">
        <p className="text-sm leading-6 text-muted-foreground">规则包读取失败：{error}</p>
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
          {loading ? "重试中…" : "重试"}
        </Button>
      </section>
    );
  }

  if (!pack || !diff) {
    return (
      <section aria-label="规则包来源" className="rounded-xl bg-muted/40 px-4 py-3">
        <p className="text-sm text-muted-foreground">{loading ? "正在读取规则包…" : "规则包信息暂不可用。"}</p>
      </section>
    );
  }

  const pendingCount = diff.added + diff.updated;
  const conflictCount = diff.conflicts.length;

  if (pendingCount === 0 && conflictCount === 0) {
    return (
      <section aria-label="规则包来源" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 px-4 py-3">
        <p className="text-sm leading-6 text-muted-foreground">
          规则包 <span className="font-medium text-foreground">sepia-webnovel v{pack.packVersion}</span> 已同步，
          本页 {diff.unchanged} 条规则来自包内。
        </p>
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          {loading ? "检查中…" : "重新检查"}
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-label="规则包升级"
      className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">
          规则包 sepia-webnovel v{pack.packVersion} 有 {pendingCount} 条可带入
        </p>
        <p className="text-xs leading-5 text-amber-900/80">
          新增 {diff.added} 条 · 更新 {diff.updated} 条
          {conflictCount > 0 ? ` · ${conflictCount} 条本地已改，导入时跳过、不覆盖` : ""}
        </p>
        {conflictCount > 0 ? (
          <p className="text-xs leading-5 text-amber-900/80">
            {diff.conflicts
              .slice(0, 3)
              .map((item) => `${item.name}（${ACTION_LABEL[item.action] ?? item.action}）`)
              .join("；")}
            {conflictCount > 3 ? ` 等 ${conflictCount} 条` : ""}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="border-amber-300 bg-white/70 hover:bg-white"
          disabled={loading || importing} onClick={() => void load()}>
          重新检查
        </Button>
        <Button type="button" size="sm" disabled={importing || pendingCount === 0} onClick={() => void handleImport()}>
          <PackagePlus aria-hidden="true" className="h-4 w-4" />
          {importing ? "导入中…" : "导入/升级"}
        </Button>
      </div>
    </section>
  );
}
