/**
 * sepia 报告项 → 正文区间 的纯函数换算
 *
 * 为什么需要这层：sepia 的机械门报告只有两种定位信息——
 *   - `quote`：连续原文片段（lint 侧，部分项有）
 *   - `line`：行号（只在 deslop 侧有，且是 **1 起** 的「第N行」）
 *
 * 而编辑器（Plate）只认 `{ from, to }` 字符偏移。这中间必须换算，
 * 否则 UI 只能显示「整章」，点不进去。
 *
 * 三条纪律：
 *   1. 不做模糊匹配。quote 在正文里找不到就返回 null，绝不"就近猜一个"——
 *      猜错会把作者光标扔到无关段落，比不定位更糟。
 *   2. 行号越界、空行一律返回 null，不夹到文末。
 *   3. 只读，不改正文；token 里含换行时按原样跨越。
 */

export interface SepiaTextRange {
  from: number;
  to: number;
}

export interface SepiaLocator {
  /** 连续原文片段；空串表示该报告项没带引文 */
  quote?: string;
  /** 行号，1 起；null/undefined 表示没有 */
  line?: number | null;
}

/** 每行起始偏移，索引 0 对应第 1 行 */
export function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 第 lineNo 行（1 起）的字符区间；越界或空行返回 null */
export function rangeOfLine(text: string, lineNo: number): SepiaTextRange | null {
  if (!Number.isInteger(lineNo) || lineNo < 1) return null;
  const starts = lineStartOffsets(text);
  const start = starts[lineNo - 1];
  if (start === undefined) return null;
  const nextStart = starts[lineNo];
  const end = nextStart === undefined ? text.length : nextStart - 1;
  // 去掉行尾 \r，避免把回车算进选区
  const trimmedEnd = end > start && text[end - 1] === "\r" ? end - 1 : end;
  if (trimmedEnd <= start) return null;
  return { from: start, to: trimmedEnd };
}

function findAll(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    hits.push(index);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return hits;
}

function withinLine(text: string, hit: SepiaTextRange, line: SepiaTextRange): boolean {
  return hit.from >= line.from && hit.to <= line.to;
}

/**
 * 换算定位区间。
 *
 * 优先级：
 *   1. quote + line 同时给 → 优先取"落在该行内的那次出现"，其次取首次出现
 *   2. 只有 quote → 首次出现
 *   3. 只有 line → 整行
 *   4. 都没有 / 找不到 → null（调用方按"整章"处理，不给假定位）
 */
export function resolveSepiaRange(text: string, locator: SepiaLocator): SepiaTextRange | null {
  const quote = (locator.quote ?? "").trim();
  const lineNo = typeof locator.line === "number" ? locator.line : null;
  const lineRange = lineNo === null ? null : rangeOfLine(text, lineNo);

  if (quote.length >= 2) {
    const hits = findAll(text, quote).map((start) => ({ from: start, to: start + quote.length }));
    if (hits.length > 0) {
      if (lineRange) {
        const onLine = hits.find((hit) => withinLine(text, hit, lineRange));
        if (onLine) return onLine;
      }
      return hits[0];
    }
  }

  return lineRange;
}
