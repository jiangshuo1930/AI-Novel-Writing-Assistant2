/**
 * story-deslop 检测器封装（对应 sepia scripts/deslop_bridge.py）
 *
 * 边界：**4 个 JS 文件字节不变，用 Node 子进程调用**。这里只做调用、汇总、
 * 等级映射、中文标签，绝不重新实现任何正则——重写必然丢护栏细节。
 *
 * 与 deslop_bridge.py 的逐项对应：
 *   DETECTORS / LEVEL / TYPE_CN / SUBTYPE_CN / _label / type_drift / _node / scan
 *
 * 三处刻意的"照抄"（看起来像 bug，但都是上游行为，端口无权修正）：
 *   1. 超时 60s（Python `subprocess.run(..., timeout=60)`），不是方案 §8.2 曾写的 3s。
 *      用户裁决：sepia 怎么跑，并入后就得怎么跑。
 *   2. 检测器故障时 `continue`（跳过该检测器），不是"门降级为不阻塞"。
 *      Python 是跳过，剩下的项照跑，汇总项照出。
 *   3. 剥 meta 后写临时文件再扫，会让 `.deslop-whitelist` 失效（临时目录没有
 *      同名兄弟文件）。这是 Python 的既有行为，原样保留。
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { splitBody, stripMeta } from '../lint/sepiaLint';
import type { SepiaFinding, SepiaLevel, SepiaReview } from '../types';

/** 检测器：中文标签 → 脚本名（对应 deslop_bridge.DETECTORS） */
const DETECTORS: ReadonlyArray<readonly [string, string]> = [
  ['句式与密度', 'check-ai-patterns.js'],
  ['退化', 'check-degeneration.js'],
];

/** sepia 等级 ← story-deslop severity（对应 deslop_bridge.LEVEL） */
const LEVEL: Record<string, SepiaLevel> = { blocking: 'err', advisory: 'warn' };

/**
 * type → 中文名（对应 deslop_bridge.TYPE_CN）
 *
 * 退化类的 key 必须与 check-degeneration.js 里的 type 字面量逐字一致。
 * 历史上曾写成 repeat / adjacent-repeat / truncation / placeholder，与 JS 产出的
 * verbatim-repeat / truncated / placeholder-leak 对不上，退化告警全部掉回英文。
 * `typeDrift()` 就是防这个回归。
 */
const TYPE_CN: Record<string, string> = {
  'not-is-comparison': '不是A而是B',
  'voice-contrast': '音量反差腔',
  'negation-parade': '否定排比',
  'reverse-not-is': '反序对比',
  'trailer-ending': '预告式收尾',
  'trailer-summary': '章尾总结体',
  'em-dash': '破折号',
  'long-paragraph': '长段落',
  'period-stutter': '碎句号',
  'micro-action-tic': '微动作复读',
  'negation-pair-tic': '否定对偶',
  'cliche-density-tic': '套词密度',
  'stock-reaction-tic': '套式反应细节',
  'action-list-tic': '动作清单',
  'abstract-summary-tic': '抽象总结复读',
  'metaphor-density-tic': '比喻密度',
  'reasoning-chain-tic': '解释链密度',
  'system-notice-formality-tic': '系统公告公文腔',
  'overcompressed-prose-tic': '过度精炼短段',
  'low-connective-density-tic': '低连接密度',
  'quote-emphasis-tic': '引号强调滥用',
  'formulaic-parallelism': '工整并列',
  'verbatim-repeat': '复读打转',
  truncated: '截断',
  'placeholder-leak': '占位符泄漏',
  'meta-leak': '工程词泄漏',
};

/** 同一 type 有两条触发路径时按 message 前缀细分（对应 deslop_bridge.SUBTYPE_CN） */
const SUBTYPE_CN: Record<string, ReadonlyArray<readonly [string, string]>> = {
  'verbatim-repeat': [
    ['逐行复读', '紧邻整行重复'],
    ['长句复读', '长句复读'],
  ],
};

/** JS 侧 type 都是单引号字面量，用它做漂移自检（对应 _TYPE_LITERAL） */
const TYPE_LITERAL = /\btype:\s*'([a-z][a-z0-9-]*)'/g;

/** 对应 deslop_bridge.scan 的 60s 超时 */
const DETECTOR_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** Node 侧单条 finding（JS 输出结构） */
interface RawFinding {
  type?: string;
  severity?: string;
  review?: string;
  line?: number | null;
  column?: number | null;
  message?: string;
  excerpt?: string;
}

export type DeslopStatus = 'ok' | 'unavailable' | 'skipped';

export interface DeslopFinding extends SepiaFinding {
  /** deslop 侧额外字段，仅供报告分组，不进入 sepia 的 items 语义 */
  detector?: string;
  type?: string;
  line?: number | null;
  excerpt?: string;
}

export interface DeslopScanOptions {
  /** vendor 的 deslop 目录；默认由 packDir 推导 */
  deslopDir?: string;
  /** node 可执行文件；默认自动定位 */
  nodePath?: string;
  /** 覆盖超时（仅测试用，默认 60s 对齐 Python） */
  timeoutMs?: number;
  /**
   * 正文来源文件路径（可选）。
   *
   * 对应 lint.py 的 `a.file`：不需要剥 meta 时，Python 直接把原路径交给检测器，
   * 于是 `.deslop-whitelist`（book-local）能生效。内容来自 DB 的章节没有这个
   * 路径，只能写临时文件——那是合并后不可避免的差异，单独登记，不在端口里
   * 假装等价。
   */
  sourcePath?: string;
}

/** type → 中文名。未登记的 type 原样透出，便于第一时间发现漂移。 */
export function labelFor(type: string, message = ''): string {
  for (const [probe, name] of SUBTYPE_CN[type] ?? []) {
    if (message.includes(probe)) return name;
  }
  return TYPE_CN[type] ?? type;
}

/** Python 字符串切片按码位；JS 的 slice 按 UTF-16 码元，代理对会被切坏 */
function cpSlice(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join('');
}

/** vendor 的 deslop 目录（pack/source/scripts/deslop） */
export function defaultDeslopDir(packDir: string): string {
  return path.join(packDir, 'source', 'scripts', 'deslop');
}

/**
 * 校验 deslop 目录下全部 .js 与 manifest 记录的 sha256 一致。
 *
 * 注意是**全部**，不是只校验 DETECTORS：`check-ai-patterns.js` 会
 * `require('./style-whitelist')`，只校验两个入口脚本等于给护栏留后门。
 * 这是"字节不变"从口号变成可执行检查的唯一办法——被手改过的检测器
 * 会让 T2 通过、线上行为漂移，是最难发现的一类退化。
 */
export function assertDetectorBytes(packDir: string, deslopDir = defaultDeslopDir(packDir)): void {
  const manifestFile = path.join(packDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`[sepia] manifest.json 缺失：${manifestFile}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    files?: Array<{ path: string; sha256: string }>;
  };
  const table = new Map((manifest.files ?? []).map((f) => [f.path, f.sha256]));

  const scripts = fs.existsSync(deslopDir)
    ? fs.readdirSync(deslopDir).filter((n) => n.endsWith('.js'))
    : [];
  if (scripts.length === 0) throw new Error(`[sepia] 检测器目录为空：${deslopDir}`);

  for (const script of scripts.sort()) {
    const rel = `scripts/deslop/${script}`;
    const want = table.get(rel);
    if (!want) throw new Error(`[sepia] manifest 未登记 ${rel}，规则包不完整`);
    const got = createHash('sha256')
      .update(fs.readFileSync(path.join(deslopDir, script)))
      .digest('hex');
    if (got !== want) {
      throw new Error(
        `[sepia] 检测器字节被改动：${rel}\n  期望 ${want}\n  实得 ${got}\n` +
          'deslop 只允许原样 vendor，要改规则请走上游并重新构建规则包。',
      );
    }
  }
}

/** 对应 deslop_bridge.type_drift：JS 实际产出的 type vs TYPE_CN 覆盖 */
export function typeDrift(deslopDir: string): {
  seen: string[];
  missing: string[];
  stale: string[];
} {
  const seen = new Set<string>();
  for (const [, script] of DETECTORS) {
    const file = path.join(deslopDir, script);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(TYPE_LITERAL)) seen.add(m[1]);
  }
  const all = Array.from(seen).sort();
  return {
    seen: all,
    missing: all.filter((t) => !(t in TYPE_CN)),
    stale: Object.keys(TYPE_CN)
      .filter((t) => !seen.has(t))
      .sort(),
  };
}

let cachedNode: string | undefined;

/**
 * 定位 node（对应 deslop_bridge._node，顺序一致）：
 * 先 PATH，再 WorkBuddy 托管运行时目录。
 *
 * 额外前置：若当前进程本身就是 node，直接用 process.execPath。
 * 只影响"能不能跑"，不影响检测行为；避免服务端 PATH 干净时误判 unavailable。
 * 只缓存**成功**结果：Python 每次 which，找不到不记忆，否则装好 node 也不会重试。
 */
export function findNode(): string | null {
  if (cachedNode) return cachedNode;

  const exe = process.execPath;
  if (exe && /^node(\.exe)?$/i.test(path.basename(exe))) {
    cachedNode = exe;
    return cachedNode;
  }

  const fromPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'))
    .find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  if (fromPath) {
    cachedNode = fromPath;
    return cachedNode;
  }

  const roots = [process.env.USERPROFILE ?? '', 'C:/Users/Jani'];
  for (const root of roots) {
    if (!root) continue;
    const base = path.join(root, '.workbuddy', 'binaries', 'node', 'versions');
    if (!fs.existsSync(base)) continue;
    // Python 是 sorted(..., reverse=True) 字符串降序，保持同样的挑选顺序
    const versions = fs.readdirSync(base).sort().reverse();
    for (const ver of versions) {
      for (const cand of ['node.exe', 'node']) {
        const p = path.join(base, ver, cand);
        if (fs.existsSync(p)) {
          cachedNode = p;
          return cachedNode;
        }
      }
    }
  }

  return null;
}

/** 跑单个检测器。返回 null 表示应跳过（超时/启动失败/退出码 2/JSON 损坏）。 */
function runDetector(
  node: string,
  script: string,
  target: string,
  timeoutMs: number,
): Promise<{ findings: RawFinding[] } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { findings: RawFinding[] } | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let child;
    try {
      child = spawn(node, [script, '--json', target], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      done(null);
      return;
    }

    const out: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已被回收 */
      }
      done(null);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_BUFFER) out.push(chunk);
    });
    child.stderr?.resume();

    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 退出码 2 = 读文件失败等内部错误，Python 侧同样跳过
      if (code === 2) {
        done(null);
        return;
      }
      try {
        const data = JSON.parse(Buffer.concat(out).toString('utf8') || '{}');
        done({ findings: Array.isArray(data.findings) ? data.findings : [] });
      } catch {
        done(null);
      }
    });
  });
}

/**
 * 对单个文件跑全部检测器（对应 deslop_bridge.scan）。
 *
 * 返回 status = "unavailable" 表示 node 或脚本目录缺失；
 * 单个检测器失败只跳过该检测器，不影响另一个，也不改变 status。
 */
export async function scan(
  target: string,
  options: DeslopScanOptions = {},
): Promise<{ findings: DeslopFinding[]; status: 'ok' | 'unavailable' }> {
  const deslopDir = options.deslopDir;
  const node = options.nodePath ?? findNode();
  if (!node || !deslopDir || !fs.existsSync(deslopDir)) {
    return { findings: [], status: 'unavailable' };
  }

  const timeoutMs = options.timeoutMs ?? DETECTOR_TIMEOUT_MS;
  const findings: DeslopFinding[] = [];

  for (const [label, script] of DETECTORS) {
    const file = path.join(deslopDir, script);
    if (!fs.existsSync(file)) continue;

    const result = await runDetector(node, file, target, timeoutMs);
    if (!result) continue;

    for (const f of result.findings) {
      const sev = f.severity ?? 'advisory';
      const type = f.type ?? 'unknown';
      const message = f.message ?? '';
      findings.push({
        item: `${label}·${labelFor(type, message)}`,
        level: LEVEL[sev] ?? 'warn',
        review: (f.review === 'mechanical' ? 'mechanical' : 'semantic') as SepiaReview,
        detail: `${message}（${type}）`,
        detector: label,
        type,
        line: f.line ?? null,
        excerpt: f.excerpt ?? '',
      });
    }
  }

  return { findings, status: 'ok' };
}

/** 写临时正文文件后清理目录。对应 lint.py merge_deslop 的 mkstemp 分支。 */
async function scanBodyOnly(
  bodyOnly: string,
  options: DeslopScanOptions,
): Promise<{ findings: DeslopFinding[]; status: 'ok' | 'unavailable' }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sepia-deslop-'));
  const tmp = path.join(dir, '_deslop_.md');
  try {
    fs.writeFileSync(tmp, bodyOnly, 'utf8');
    return await scan(tmp, options);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

/**
 * 把 deslop 结果并入 res（对应 lint.py merge_deslop，逐行转写）。
 *
 * blocking → err（与 sepia 硬伤同级，必须清零）
 * advisory → warn（带 review：mechanical 就地改 / semantic 读上下文）
 *
 * 破折号去重：sepia 的 L1-1 已报过就不再重复报。
 */
export async function mergeDeslop(
  text: string,
  res: SepiaFinding[],
  options: DeslopScanOptions = {},
): Promise<DeslopStatus> {
  const bodyOnly = stripMeta(splitBody(text));
  // Python 的判断是 body_only.strip() != raw.strip()：不等就写临时文件，
  // 相等就把**原路径**交给检测器。这里 text 已在内存里，语义等价。
  const needTemp = bodyOnly.trim() !== text.trim();

  let result: { findings: DeslopFinding[]; status: 'ok' | 'unavailable' };
  if (!needTemp && options.sourcePath) {
    result = await scan(options.sourcePath, options);
  } else {
    // 没有来源路径时一律走临时文件：检测器只认路径，不认内存里的字符串。
    result = await scanBodyOnly(needTemp ? bodyOnly : text, options);
  }
  const { findings, status } = result;
  if (status === 'unavailable') return 'unavailable';

  const seenDash = res.some((r) => r.item === 'L1-1 破折号');

  for (const f of findings) {
    if (f.item.endsWith('·破折号') && seenDash) continue;
    const loc = f.line ? `第${f.line}行` : '';
    let detail = `${loc}·${f.detail}`;
    if (f.excerpt) detail += `｜「${cpSlice(f.excerpt, 24)}」`;
    res.push({ item: f.item, level: f.level, review: f.review, detail });
  }

  const nErr = findings.filter((f) => f.level === 'err').length;
  const nWarn = findings.filter((f) => f.level === 'warn').length;
  res.push({
    item: '去味检测器（story-deslop）',
    level: nErr ? 'err' : 'ok',
    detail:
      `句式/退化：硬伤 ${nErr} · 提示 ${nWarn}` +
      (nWarn ? '（mechanical 可直接改，semantic 需读上下文）' : ''),
  });
  return 'ok';
}
