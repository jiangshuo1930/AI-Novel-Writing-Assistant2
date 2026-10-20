/**
 * Sepia 机械门卡片（章节编辑器左栏）
 *
 * 只做三件事：跑门、按层分组展示、把报告项落到正文位置。
 * 分级完全照抄报告里的 `severity`——UI 不改判、不合并、不重排优先级。
 *
 * 关于自动跑：机械门是子进程调用（lint + deslop），不可能随打随跑。
 * 这里每章打开时跑一次，之后由作者点「重新检查」触发。正文改动过就标注
 * 「结果对应上次检查的正文」，不用旧结果冒充当前状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SepiaGateFinding, SepiaGateLayer, SepiaGateReport, SepiaGateStatusRecord, SepiaSelfCheckView } from "@ai-novel/shared/types/sepia";
import { resolveSepiaRange } from "@ai-novel/shared/utils/sepiaRange";
import { getSepiaGateStatus, getSepiaSelfCheck, runSepiaGate } from "@/api/sepia";
import { Button } from "@/components/ui/button";

const LAYER_ORDER: SepiaGateLayer[] = ["surface", "discourse", "narrative"];
const LAYER_LABEL: Record<SepiaGateLayer, string> = {
  surface: "字面层",
  discourse: "篇章层",
  narrative: "叙事层",
};
/** 正文太短时 sepia 只会报「正文太短」，跑一次没有信息量 */
const MIN_AUTO_RUN_CHARS = 200;

type Status = "idle" | "loading" | "ready" | "error";

interface Props {
  chapterId: string;
  content: string;
  disabled: boolean;
  isDirty: boolean;
  onFocusRange: (range: { from: number; to: number }) => void;
}

function groupByLayer(findings: SepiaGateFinding[]): Array<{ layer: SepiaGateLayer; items: SepiaGateFinding[] }> {
  return LAYER_ORDER.map((layer) => ({ layer, items: findings.filter((item) => item.layer === layer) })).filter(
    (group) => group.items.length > 0,
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function FindingRow({
  finding,
  content,
  disabled,
  onFocusRange,
}: {
  finding: SepiaGateFinding;
  content: string;
  disabled: boolean;
  onFocusRange: (range: { from: number; to: number }) => void;
}) {
  const range = useMemo(
    () => resolveSepiaRange(content, { quote: finding.quote, line: finding.line }),
    [content, finding.quote, finding.line],
  );
  return (
    <li className="space-y-1.5 rounded-lg bg-muted/20 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium leading-5">{finding.rawItem}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {finding.line ? `第 ${finding.line} 行` : LAYER_LABEL[finding.layer]}
        </span>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{finding.message}</p>
      {finding.quote ? (
        <p className="text-xs leading-5 text-muted-foreground">「{truncate(finding.quote, 30)}」</p>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        disabled={disabled || !range}
        title={range ? "定位到正文" : "这条报告没有可定位的原文片段，请按描述在正文中自查"}
        onClick={() => {
          if (range) onFocusRange(range);
        }}
      >
        {range ? "定位到正文" : "无法定位"}
      </Button>
    </li>
  );
}

export default function SepiaGateCard(props: Props) {
  const { chapterId, content, disabled, isDirty, onFocusRange } = props;
  const [status, setStatus] = useState<Status>("idle");
  const [report, setReport] = useState<SepiaGateReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 上次验收时落库的门结论；编辑器里手跑的报告不写库，两者分开显示 */
  const [persisted, setPersisted] = useState<SepiaGateStatusRecord | null>(null);
  const [selfCheck, setSelfCheck] = useState<SepiaSelfCheckView | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  const autoRunRef = useRef<string | null>(null);

  const run = useCallback(async () => {
    const text = contentRef.current;
    if (!text.trim()) {
      setReport(null);
      setStatus("idle");
      setError(null);
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const response = await runSepiaGate(text);
      if (!response.success || !response.data) {
        setStatus("error");
        setError(response.error ?? "机械门没有返回结果。");
        return;
      }
      setReport(response.data);
      setStatus("ready");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    if (autoRunRef.current === chapterId) return;
    if (contentRef.current.trim().length < MIN_AUTO_RUN_CHARS) return;
    autoRunRef.current = chapterId;
    void run();
  }, [chapterId, run]);

  useEffect(() => {
    let alive = true;
    void getSepiaGateStatus(chapterId)
      .then((response) => {
        if (alive && response.success) setPersisted(response.data ?? null);
      })
      .catch(() => {
        // 没有落库记录不是错误：老章节在门结论持久化之前就写完了
      });
    return () => {
      alive = false;
    };
  }, [chapterId]);

  useEffect(() => {
    let alive = true;
    void getSepiaSelfCheck()
      .then((response) => {
        if (alive && response.success) setSelfCheck(response.data ?? null);
      })
      .catch(() => {
        // 自检口径只是参考，拿不到就不显示，不影响门本身
      });
    return () => {
      alive = false;
    };
  }, []);

  const blockingGroups = useMemo(() => groupByLayer(report?.blocking ?? []), [report]);
  const advisoryGroups = useMemo(() => groupByLayer(report?.advisory ?? []), [report]);

  return (
    <section aria-label="Sepia 机械门" className="space-y-3 border-t border-border/50 pt-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Sepia 机械门</h3>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={disabled || status === "loading"}
          onClick={() => void run()}
        >
          {status === "loading" ? "检查中…" : report ? "重新检查" : "检查机械项"}
        </Button>
      </div>

      {persisted ? (
        <p className="text-xs leading-5 text-muted-foreground">
          上次验收：{persisted.verdict === "passed" ? "过门" : persisted.verdict === "blocked" ? "未过门" : "门未跑成"}
          {" · "}硬伤 {persisted.blocking} · 建议 {persisted.advisory}
          {persisted.packVersion ? ` · 包 v${persisted.packVersion}` : ""}
          {persisted.checkedAt ? ` · ${new Date(persisted.checkedAt).toLocaleString()}` : ""}
        </p>
      ) : null}

      {/* 结构自检是机械门之后的第二级门：门清零才跑，L2/L3-1/L3-2/L4 未过同样不许进下一章 */}
      {persisted?.selfCheck ? (
        <p className="text-xs leading-5 text-muted-foreground">
          上次结构自检：
          {persisted.selfCheck.verdict === "pass"
            ? "通过"
            : persisted.selfCheck.verdict === "fail"
              ? `未过 ${persisted.selfCheck.blocking} 项`
              : "未跑成"}
          {persisted.selfCheck.advisory > 0 ? ` · 诊断 ${persisted.selfCheck.advisory} 项` : ""}
          {persisted.selfCheck.summary ? ` · ${persisted.selfCheck.summary}` : ""}
        </p>
      ) : null}

      {status === "loading" ? (
        <p className="text-sm leading-6 text-muted-foreground">正在跑字面与去味检测，首次约需数秒。</p>
      ) : null}

      {status === "error" ? (
        <div className="space-y-1.5 rounded-xl bg-destructive/5 px-3 py-2">
          <p className="text-sm leading-6 text-destructive">机械门没有跑成，正文未受影响。</p>
          <p className="text-xs leading-5 text-muted-foreground">{error}</p>
        </div>
      ) : null}

      {status === "idle" && !report ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {content.trim().length < MIN_AUTO_RUN_CHARS
            ? "正文还太短，写满一段后再检查才有意义。"
            : "点「检查机械项」跑一遍破折号、禁用词、句式套子与去味检测。"}
        </p>
      ) : null}

      {report ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`rounded-full px-2 py-0.5 ${report.blockingCount > 0 ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
            >
              硬伤 {report.blockingCount}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">提示 {report.advisoryCount}</span>
            <span className="text-muted-foreground">{report.packVersion}</span>
          </div>

          {!report.deslopOk ? (
            <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900">
              去味检测本次未跑成（{report.deslop}），硬伤数只覆盖字面校验部分。
            </p>
          ) : null}

          {isDirty ? (
            <p className="text-xs leading-5 text-muted-foreground">正文已改动，下面是上次检查的结果。</p>
          ) : null}

          {report.blockingCount === 0 && report.advisoryCount === 0 ? (
            <p className="text-sm leading-6 text-muted-foreground">本章没有机械项问题。</p>
          ) : null}

          {blockingGroups.map((group) => (
            <div key={`blocking-${group.layer}`} className="space-y-1.5">
              <div className="text-xs font-medium text-destructive">
                {LAYER_LABEL[group.layer]} · 硬伤
              </div>
              <ul className="space-y-1.5">
                {group.items.map((finding, index) => (
                  <FindingRow
                    key={`${finding.checkId}-${index}`}
                    finding={finding}
                    content={content}
                    disabled={disabled}
                    onFocusRange={onFocusRange}
                  />
                ))}
              </ul>
            </div>
          ))}

          {report.advisoryCount > 0 ? (
            <details className="space-y-1.5">
              <summary className="cursor-pointer text-xs text-muted-foreground">提示项（{report.advisoryCount}）</summary>
              <div className="mt-2 space-y-2">
                {advisoryGroups.map((group) => (
                  <div key={`advisory-${group.layer}`} className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">{LAYER_LABEL[group.layer]}</div>
                    <ul className="space-y-1.5">
                      {group.items.map((finding, index) => (
                        <FindingRow
                          key={`${finding.checkId}-${index}`}
                          finding={finding}
                          content={content}
                          disabled={disabled}
                          onFocusRange={onFocusRange}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : null}

      {selfCheck ? (
        <details className="space-y-1.5 border-t border-border/40 pt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            自检口径（L2–L4 · 包 v{selfCheck.packVersion}）
          </summary>
          <div className="mt-2 space-y-2">
            {selfCheck.levels.map((level) => (
              <div key={level.key} className="space-y-1">
                <div className="text-xs font-medium">{level.title}</div>
                <ul className="space-y-0.5">
                  {level.items.map((item) => (
                    <li key={item} className="text-xs leading-5 text-muted-foreground">· {item}</li>
                  ))}
                </ul>
              </div>
            ))}
            {selfCheck.falsePositiveWarnings.length > 0 ? (
              <div className="space-y-1">
                <div className="text-xs font-medium">误伤警告（看密度，不看单次）</div>
                <ul className="space-y-0.5">
                  {selfCheck.falsePositiveWarnings.map((warning) => (
                    <li key={warning.feature} className="text-xs leading-5 text-muted-foreground">
                      · {warning.feature}：{warning.threshold}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
