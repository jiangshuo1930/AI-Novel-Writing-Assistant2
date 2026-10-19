/**
 * 卷级诊断卡片（卷详情页右栏）
 *
 * 数据全部来自 `POST /api/sepia/volume-diagnostics`，本组件只做展示与换行，
 * 不重算任何指标。
 *
 * 一条硬规矩：`source === "unavailable"` 的项**显式显示"推不出来 + 原因"**，
 * 不给估算值、不显示 0。卷级诊断里峰值位置与场景骨架目前都属于这类——
 * 原文没有段落级标注，编一个数字会让作者据此改稿，比空缺有害得多。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SepiaHookType, SepiaVolumeDiagnostics } from "@ai-novel/shared/types/sepia";
import { RefreshCw } from "lucide-react";
import { getVolumeDiagnostics } from "@/api/sepia";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface Props {
  novelId: string;
  /** 本卷章节号；空数组表示还没拆章 */
  chapterOrders: number[];
  volumeLabel: string;
}

const HOOK_TYPES: SepiaHookType[] = ["危", "疑", "变", "求", "断", "静"];

const INTENSITY_LABEL: Record<1 | 2 | 3, string> = { 1: "一星", 2: "二星", 3: "三星" };

function intensityClass(value: 1 | 2 | 3 | null): string {
  if (value === 3) return "bg-rose-500/80";
  if (value === 2) return "bg-amber-400/80";
  if (value === 1) return "bg-sky-400/70";
  return "bg-muted";
}

export default function SepiaVolumeDiagnosticsCard({ novelId, chapterOrders, volumeLabel }: Props) {
  const [data, setData] = useState<SepiaVolumeDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 上层每次渲染都会 map 出新数组，直接进依赖会无限重跑；按内容做 key
  const ordersKey = useMemo(() => chapterOrders.join(","), [chapterOrders]);
  const ordersRef = useRef(chapterOrders);
  ordersRef.current = chapterOrders;

  const load = useCallback(async () => {
    const orders = ordersRef.current;
    if (!novelId || orders.length === 0) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await getVolumeDiagnostics(novelId, { chapterOrders: orders });
      if (!response.success || !response.data) {
        setError(response.error ?? "卷级诊断没有返回结果。");
        return;
      }
      setData(response.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    void load();
  }, [load, ordersKey]);

  const hookCounts = useMemo(() => {
    const counts = new Map<SepiaHookType, number>();
    for (const type of data?.hookTypes ?? []) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return counts;
  }, [data]);

  if (chapterOrders.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">卷级诊断</Badge>
            <span className="text-sm text-muted-foreground">{volumeLabel}</span>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs leading-5 text-muted-foreground">本卷还没拆章，拆完章再来诊断才有意义。</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">卷级诊断</Badge>
            <span className="text-sm text-muted-foreground">{volumeLabel}</span>
            <span className="text-xs text-muted-foreground">覆盖 {chapterOrders.length} 章</span>
          </div>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs"
            disabled={loading} onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            {loading ? "诊断中…" : "重新诊断"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {error ? <p className="text-xs leading-5 text-destructive">{error}</p> : null}

        {data ? (
          <>
            <div className="space-y-1.5">
              <div className="text-xs font-medium">钩子类型</div>
              <div className="flex flex-wrap gap-1.5">
                {HOOK_TYPES.map((type) => (
                  <span
                    key={type}
                    className={`rounded-full px-2 py-0.5 text-xs ${(hookCounts.get(type) ?? 0) > 0 ? "bg-muted text-foreground" : "bg-muted/40 text-muted-foreground"}`}
                  >
                    {type} {(hookCounts.get(type) ?? 0) > 0 ? hookCounts.get(type) : "—"}
                  </span>
                ))}
                {(hookCounts.get("unknown") ?? 0) > 0 ? (
                  <span className="rounded-full bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                    识别不出 {hookCounts.get("unknown")}
                  </span>
                ) : null}
              </div>
            </div>

            {data.repeatedHook ? (
              <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900">
                连续 {data.repeatedHook.run} 章都用了「{data.repeatedHook.type}」类钩子（第
                {data.repeatedHook.startOrder}–{data.repeatedHook.endOrder} 章），读者会开始预判。
              </p>
            ) : null}

            <div className="space-y-1.5">
              <div className="text-xs font-medium">冲突强度波</div>
              <div className="flex flex-wrap items-end gap-1">
                {data.chapters.map((chapter) => (
                  <span
                    key={chapter.order}
                    title={`第${chapter.order}章 ${chapter.title || ""}${chapter.intensity ? ` · ${INTENSITY_LABEL[chapter.intensity]}` : " · 未标强度"}`}
                    className={`w-4 rounded-sm ${intensityClass(chapter.intensity)} ${chapter.intensity === 3 ? "h-5" : chapter.intensity === 2 ? "h-4" : chapter.intensity === 1 ? "h-3" : "h-2"}`}
                  />
                ))}
              </div>
              {data.intensityIssues.length > 0 ? (
                <ul className="space-y-1">
                  {data.intensityIssues.map((issue) => (
                    <li key={issue} className="text-xs leading-5 text-amber-900">· {issue}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">强度起伏没有明显问题。</p>
              )}
            </div>

            <div className="space-y-1 rounded-lg bg-muted/30 px-2.5 py-2">
              <div className="text-xs font-medium">推不出来的项</div>
              {[data.peakPositions, data.repeatedSkeleton].map((item) => (
                <p key={item.note} className="text-xs leading-5 text-muted-foreground">
                  {item.source === "unavailable" ? "— " : ""}
                  {item.note}
                </p>
              ))}
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium">悬着的伏笔 {data.orphanForeshadows.count}</div>
              {data.orphanForeshadows.count === 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">没有久未触碰的伏笔。</p>
              ) : (
                <ul className="space-y-1">
                  {data.orphanForeshadows.items.slice(0, 3).map((item) => (
                    <li key={item.title} className="text-xs leading-5 text-muted-foreground">
                      · {item.title}
                      {item.lastTouchedOrder ? `（最后一次第 ${item.lastTouchedOrder} 章）` : "（没有触碰记录）"}
                    </li>
                  ))}
                  {data.orphanForeshadows.count > 3 ? (
                    <li className="text-xs text-muted-foreground">等 {data.orphanForeshadows.count} 条</li>
                  ) : null}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
