/**
 * sepia 机械项校验 —— 1:1 端口
 *
 * 来源：pack/source/scripts/lint.py（`check()`，第 176–326 行）
 * 原则：**逐项照抄**，包括阈值、文案、排序、边界判断。这里不做任何"顺手修正"。
 *       端口与源不一致时，以源为准（合并方案 §12.2 / T1）。
 *
 * 与 Python 的三处实现差异（已知且不改变判定）：
 * 1. `len(str)` 在 Python 是码点，JS `.length` 是 UTF-16 单元 → 统一用 cpLen()。
 * 2. `str.count(w)` 是非重叠计数 → 用 split(w).length - 1。
 * 3. `f"{x:.1f}"` 是 ties-to-even → 用 pyFixed()，避免极少见的 .05 进位差。
 *
 * 阈值全部是内嵌字面量，与源同位置同值：5–8（句号密度）、30/50（对话占比）、
 * 55（超长句）、3（相邻同长句 / 超长句 / 「不是X而是Y」密度）、100（最短正文）、4（替代词过载）。
 */

import type {
  SepiaFinding,
  SepiaLevel,
  SepiaLintStats,
  SepiaPack,
  SepiaSentencePattern,
} from '../types';

export interface SepiaLintResult {
  findings: SepiaFinding[];
  stats: SepiaLintStats;
}

// ---------------------------------------------------------------- 基础工具

/** 码点数，等价 Python len(str) */
function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join('');
}

/** 等价 Python str.count(sub)：非重叠计数 */
function countSub(hay: string, needle: string): number {
  if (!needle) return 0;
  return hay.split(needle).length - 1;
}

function countRe(hay: string, re: RegExp): number {
  const m = hay.match(re);
  return m ? m.length : 0;
}

/** 等价 Python f"{x:.1f}"（ties-to-even，避免 toFixed 的 half-away-from-zero） */
function pyFixed(value: number, digits: number): string {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  let n: number;
  if (Math.abs(scaled - floor - 0.5) < 1e-9) {
    n = floor % 2 === 0 ? floor : floor + 1;
  } else {
    n = Math.round(scaled);
  }
  return (n / factor).toFixed(digits);
}

// ---------------------------------------------------------------- 正文切分

const SPLITLINES = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

/** 去掉标题行、引用行、表格、代码块，只留正文（lint.py:136–152） */
export function stripMeta(text: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const ln of text.split(SPLITLINES)) {
    const s = ln.trim();
    if (s.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (s.startsWith('#') || s.startsWith('>') || s.startsWith('|')) continue;
    if (s === '---' || s === '***') continue;
    out.push(ln);
  }
  return out.join('\n');
}

/** 若文件含「## 四、正文」这类分节，只取正文节（lint.py:155–162） */
export function splitBody(text: string): string {
  const m = /^##\s*(?:四、)?正文\s*$/m.exec(text);
  if (!m) return text;
  const rest = text.slice(m.index + m[0].length);
  const nxt = /^##\s+(?!正文)/m.exec(rest);
  return nxt ? rest.slice(0, nxt.index) : rest;
}

function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function sentences(text: string): string[] {
  return text.split(/(?<=[。！？!?])/).filter((s) => s.trim().length > 0);
}

function linenoHits(body: string, pattern: RegExp): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  body.split(SPLITLINES).forEach((ln, i) => {
    if (pattern.test(ln)) out.push([i + 1, ln.trim()]);
  });
  return out;
}

// ---------------------------------------------------------------- 主检查

export function lintText(text: string, pack: SepiaPack): SepiaLintResult {
  const body = stripMeta(splitBody(text));
  const nChar = cpLen(body.replace(/\s/g, ''));
  const paras = paragraphs(body);
  const sents = sentences(body);
  const findings: SepiaFinding[] = [];

  const add = (item: string, level: SepiaLevel, detail: string): void => {
    findings.push({ item, level, detail });
  };

  if (nChar < 100) {
    // 即便正文过短也要先跑完破折号项：merge_deslop() 靠「L1-1 破折号已存在」去重
    const nDash = countRe(body, /—+/g);
    add('正文', 'err', `只识别到 ${nChar} 字正文，检查文件格式（正文需用空行分段）`);
    add('L1-1 破折号', nDash ? 'err' : 'ok', `${nDash} 处（要求 0）`);
    return { findings, stats: { chars: nChar, paras: paras.length, sents: sents.length } };
  }

  // L1-1 破折号：数**连续串**，不数字符（否则「——」算 2 处）
  const nDash = countRe(body, /—+/g);
  add('L1-1 破折号', nDash ? 'err' : 'ok', `${nDash} 处（要求 0）`);
  if (nDash) {
    for (const [, ln] of linenoHits(body, /—/)) {
      add('  ↳ 位置', 'info', `「${cpSlice(ln, 40)}」`);
    }
  }

  // L1-2 禁用词：台词豁免（剥掉 “…” 再扫），与 deslop 的引号遮罩对齐
  const scan = body.replace(/“[^”]*”/g, '');
  const words = pack.data.bannedWords;
  const softSet = new Set(pack.data.softWords);
  const hits = new Map<string, number>();
  const softHits = new Map<string, number>();
  for (const w of words) {
    const c = countSub(scan, w);
    if (c) {
      if (softSet.has(w)) softHits.set(w, c);
      else hits.set(w, c);
    }
  }
  // 子串已被长词覆盖的，去掉重复计数
  const allWords = [...hits.keys(), ...softHits.keys()];
  for (const longW of allWords) {
    for (const shortW of [...hits.keys()]) {
      if (shortW !== longW && longW.includes(shortW) && scan.includes(longW)) {
        hits.delete(shortW);
      }
    }
  }
  const hitTotal = [...hits.values()].reduce((a, b) => a + b, 0);
  add(
    'L1-2 禁用词',
    hits.size ? 'err' : 'ok',
    hits.size ? `命中 ${hitTotal} 处 / 扫描 ${words.length} 条` : `0 处（扫描 ${words.length} 条）`,
  );
  if (hits.size) {
    for (const [w, c] of [...hits.entries()].sort((a, b) => b[1] - a[1])) {
      add('  ↳ 命中', 'info', `${w} × ${c}`);
    }
  }
  if (softHits.size) {
    const detail = [...softHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([w, c]) => `${w}×${c}`)
      .join('；');
    add('道具警惕项（不算硬伤）', 'warn', `${detail} · 出现两个以上要换掉一半，一个可留`);
  }

  // L1-5 引号：全角弯引号成对；直角与半角均为 0
  const lq = countSub(body, '\u201c');
  const rq = countSub(body, '\u201d');
  const asciiQ = countSub(body, '"');
  const straight = countSub(body, '「') + countSub(body, '」');
  add(
    'L1-5 引号',
    asciiQ || straight || lq !== rq ? 'err' : 'ok',
    `左\u201c ${lq} / 右\u201d ${rq} · 直角「」 ${straight} · 半角" ${asciiQ}` +
      '（要求：弯引号成对，其余 0）',
  );

  // L1-6 冒号
  const nColon = countSub(body, '：') + countSub(body, ':');
  add('L1-6 冒号', nColon ? 'warn' : 'ok', `${nColon} 处（尽量 0）`);

  // L1-9 句式套子（同样只扫叙述层）
  const patHits: Array<[string, number]> = [];
  for (const p of pack.data.sentencePatterns as SepiaSentencePattern[]) {
    const c = countRe(scan, new RegExp(p.regex, 'g'));
    if (c) patHits.push([p.name, c]);
  }
  add(
    'L1-9 句式套子',
    patHits.length ? 'err' : 'ok',
    patHits.length ? patHits.map(([n, c]) => `${n} × ${c}`).join('；') : '0 处',
  );
  // 不是X而是Y 密度红线
  const nx = countRe(scan, /不是[^。；\n]{1,20}[，,]\s*(?:而是|是)/g);
  if (nx >= 3) {
    add('L1-9 不是X而是Y密度', 'err', `${nx} 次（800 字内 ≥3 即硬伤）`);
  }

  // L1-12 句号密度
  const periods = countSub(body, '。');
  const dens = (periods / nChar) * 100;
  add(
    'L1-12 句号密度',
    5 <= dens && dens <= 8 ? 'ok' : 'warn',
    `${pyFixed(dens, 1)}/百字（参考 5–8）`,
  );

  // 段落节奏
  const lens = paras.map((p) => cpLen(p));
  const avgS = sents.length / paras.length;
  let uniform = 0;
  for (let i = 0; i < lens.length - 3; i += 1) {
    const seg = lens.slice(i, i + 4);
    const mn = Math.min(...seg);
    const mx = Math.max(...seg);
    if (mx - mn <= Math.max(4, mn * 0.15)) uniform += 1;
  }
  add(
    '段落参差',
    uniform >= 3 ? 'warn' : 'ok',
    `${paras.length} 段 · 均 ${pyFixed(avgS, 1)} 句 · 段长 ${Math.min(...lens)}–${Math.max(...lens)}` +
      (uniform ? ` · 连续 4 段长度雷同 ${uniform} 处` : ''),
  );

  // 相邻同长句
  const slens = sents.map((s) => cpLen(s.replace(/\s/g, '')));
  let runs = 0;
  let cur = 1;
  for (let i = 1; i < slens.length; i += 1) {
    if (Math.abs(slens[i] - slens[i - 1]) <= 3) {
      cur += 1;
      runs = Math.max(runs, cur);
    } else {
      cur = 1;
    }
  }
  add('相邻同长句', runs >= 3 ? 'warn' : 'ok', `最长连续 ${runs} 句长度接近（≥3 需打断）`);

  // 超长句
  const longs = sents.filter((s) => cpLen(s) > 55);
  add('超长句', longs.length >= 3 ? 'warn' : 'ok', `${longs.length} 句 >55 字`);
  for (const s of longs.slice(0, 3)) {
    add('  ↳ 长句', 'info', `「${cpSlice(s, 36)}…」`);
  }

  // 对话占比
  const dlgMatches = body.match(/\u201c[^\u201d]*\u201d/g) || [];
  const dialogue = dlgMatches.reduce((a, m) => a + cpLen(m.replace(/\s/g, '')), 0);
  const ratio = nChar ? (dialogue / nChar) * 100 : 0;
  const hasScene = countSub(body, '\u201c') >= 3;
  let ratioLevel: SepiaLevel = 'ok';
  let hint = '';
  if (hasScene && ratio < 30) {
    ratioLevel = 'warn';
    hint = '（有角色在场场景要求 ≥30%）';
  } else if (ratio > 50) {
    ratioLevel = 'warn';
    hint = '（>50% 读着像剧本，配比叙述）';
  }
  add('对话占比', ratioLevel, `${pyFixed(ratio, 0)}%${hint}`);

  // L1-7 / L1-8 候选：开篇两句
  const first = sentences(paras[0] ?? '').slice(0, 2);
  if (first.length) {
    const head = first[0];
    const susp =
      /(风|雨|雪|天|夜|雾|阳光|月光|云)/.test(head) &&
      /(像|仿佛|犹如|好似|似的)/.test(head);
    add('L1-7 开篇比喻（候选）', susp ? 'warn' : 'ok', `首句「${cpSlice(head, 30)}」`);
    const camera = /(竖起|拍了拍|深吸|抬头|望向|眯起|眯眼|揉了揉|伸了个懒腰)/.test(head);
    add('L1-8 镜头式开场（候选）', camera ? 'warn' : 'ok', `首句「${cpSlice(head, 30)}」`);
  }

  // L1-10 内心总结句（候选）
  const inner = body.match(/[他她][们]?(?:知道|看出|意识到|明白|懂得)[^。；]{0,12}(?:是|了)/g) || [];
  add(
    'L1-10 内心总结句（候选）',
    inner.length ? 'warn' : 'ok',
    inner.length ? `${inner.length} 处，需人工复核` : '0 处',
  );
  for (const s of inner.slice(0, 3)) {
    add('  ↳ 候选', 'info', s);
  }

  // 替代词自查：改完复查有没有把禁用词换成新的高频替代词
  const repl = ['冷不丁', '莫名', '没来由', '八成', '活像个', '摆明'];
  const over = repl
    .map((w) => [w, countSub(body, w)] as [string, number])
    .filter(([, c]) => c >= 4);
  add(
    '替代词过载',
    over.length ? 'warn' : 'ok',
    over.length ? over.map(([w, c]) => `${w}×${c}`).join('；') : '无',
  );

  return {
    findings,
    stats: { chars: nChar, paras: paras.length, sents: sents.length },
  };
}
