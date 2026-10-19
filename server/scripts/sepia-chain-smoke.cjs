/**
 * sepia 合并后的整链路冒烟（真实 DB + 真实 HTTP，非 mock）
 *
 * 链路：规则包加载 → 规则导入(幂等) → 建夹具 → 架构表写入与拦截 → 生成前门四模式
 *      → 技法选择(持久化/复用) → 写作契约(预算) → 机械门 → 验收合并 → 修文后复检
 *      → 卷级诊断 → 开关总闸 → 清理
 *
 * 用法：先 `pnpm --filter @ai-novel/server build`，再
 *      `BASE=http://127.0.0.1:3001 node server/scripts/sepia-chain-smoke.cjs`
 * 退出码 0 = 全通过；任一断言失败退出码 1，且不保留夹具。
 */
const path = require("path");
const SERVER_ROOT = path.resolve(__dirname, "..");
process.chdir(SERVER_ROOT);

const DIST = path.join(SERVER_ROOT, "dist");
/**
 * 目标服务必须是**跑着合并后代码**的那个实例。
 *
 * 本机可能同时有多个工作区在跑同名项目，直接打默认 3000 会命中别人的旧构建，
 * 表现为「接口不存在」而不是「功能有问题」。所以候选地址必须自证：
 * `/api/sepia/packs` 能返回 packVersion 才算数。
 */
async function resolveBase() {
  const explicit = process.env.BASE;
  const candidates = explicit
    ? [explicit]
    : [...new Set([process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : null, "http://127.0.0.1:3001", "http://127.0.0.1:3000", "http://127.0.0.1:5174"].filter(Boolean))];
  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}/api/sepia/packs`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.success && body?.data?.packVersion) return candidate;
    } catch { /* 下一个候选 */ }
  }
  throw new Error(
    `找不到跑着合并后代码的服务（试过 ${candidates.join(", ")}）。`
    + " 先在目标工作区启动 dev 或用 BASE=http://127.0.0.1:<port> 指定端口。",
  );
}

let BASE = "";

const { prisma } = require(path.join(DIST, "db/prisma"));
const { getSepiaPack, getSepiaGate } = require(path.join(DIST, "services/sepia/pack"));
const blueprintGate = require(path.join(DIST, "services/sepia/blueprint/sepiaBlueprintGate"));
const { ensureChapterTechniques } = require(path.join(DIST, "services/sepia/techniques/ensureChapterTechniques"));
const { buildSepiaWritingContract, renderSepiaContractText } = require(path.join(DIST, "services/sepia/contract/buildSepiaContract"));
const { applySepiaGate } = require(path.join(DIST, "services/sepia/acceptance/sepiaAcceptance"));
const { importSepiaPackRules } = require(path.join(DIST, "services/sepia/pack/sepiaPackImport"));

let pass = 0;
const failures = [];
const notes = [];

function check(stage, label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ [${stage}] ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`[${stage}] ${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ [${stage}] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function stage(n, title) {
  console.log(`\n──── ${n}. ${title} ────`);
}

async function http(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 原样留在 text */ }
  return { status: res.status, json, text };
}

const GOOD_BLUEPRINT = {
  want: "拿到茶馆后巷那张纸上的地址",
  obstacle: "后巷的门上挂了把新锁，锁眼有油",
  action: "他用铁丝撬开锁，进了后院",
  result: "后院没人，晾衣绳上挂着一件还滴水的褂子",
  change: { position: true },
  cliff: "褂子口袋里露出半张车票，终点是他老家的站",
  infoTiming: "撬锁前他就知道里面有人",
  relations: "守门的老周不肯放他进，还说了一句别去",
};

const VAGUE_BLUEPRINT = {
  want: "变强",
  obstacle: "",
  action: "",
  result: "",
  change: {},
  cliff: "",
  infoTiming: "",
  relations: "",
};

const BAD_TEXT = [
  "他忽然停下——不是害怕，而是听见了门后有人。",
  "那声音很轻，像纸在墙上擦过，一下，又一下。",
  "他数了三遍，都是二十三。这个数字他记得，昨天也是二十三。",
  "不是他不愿意走，而是脚底像被钉住了。",
  "风把门帘掀起来，又落下，反复了三次，像是有人在试探。",
  "“谁？”他问。门后没有人答。",
  "他又数了一遍，还是二十三。",
  "最后他把手放在门把上，停了很久，才慢慢往下压。",
  "门开了一条缝，里面有光。",
].join("\n\n");

const CLEAN_TEXT = [
  "他把手放在门把上，停了很久。",
  "门轴响了一声，缝里透出一线黄光。",
  "屋里摆着三张方桌，桌面擦得发白。",
  "最里面那张桌上放着一只粗瓷碗，碗里的茶还冒着气。",
  "他走过去，用指节敲了敲碗沿。",
  "“老周。”他喊了一声。",
  "没有人应。后窗开着半扇，窗台上有一道新蹭的灰印。",
  "他把碗端起来，碗底压着一张对折的车票。",
  "票面上的日期是明天，终点站写着青石桥。",
].join("\n\n");

const ACCEPTED_ASSESSMENT = {
  status: "accepted",
  blockingIssues: [],
  repairDirectives: [],
  repairability: "none",
  continuePolicy: "continue",
  riskTags: [],
};

(async () => {
  let fixture = null;
  const createdRuleKeys = [];
  try {
    BASE = await resolveBase();
    console.log(`目标服务：${BASE}（已用 /api/sepia/packs 自证跑的是合并后代码）`);

    // ─────────────────────────────────────────────────────────────
    stage(1, "规则包加载");
    const pack = getSepiaPack();
    check("pack", "packVersion 可读", /^\d+\.\d+\.\d+$/.test(pack.meta.packVersion), `v${pack.meta.packVersion}`);
    check("pack", "技法 30 条", pack.data.techniques.length === 30, String(pack.data.techniques.length));
    check("pack", "角色 5 个", pack.data.roles.length === 5, pack.data.roles.map((r) => r.roleKey).join("/"));
    check("pack", "禁用词组 6 组", pack.data.bannedWordGroups.length === 6, String(pack.data.bannedWordGroups.length));
    check("pack", "反 AI 规则种子 15 条", pack.data.antiAiRuleSeeds.length === 15, String(pack.data.antiAiRuleSeeds.length));
    check(
      "pack",
      "种子字段完整（key/name/type/severity/detectPatterns）",
      pack.data.antiAiRuleSeeds.every((s) => s.key && s.name && s.type && s.severity && Array.isArray(s.detectPatterns)),
    );

    // ─────────────────────────────────────────────────────────────
    stage(2, "规则导入（幂等三态）");
    const beforeDry = await importSepiaPackRules({ dryRun: true });
    check("import", "首次 dryRun 不会写库", beforeDry.dryRun === true, `added=${beforeDry.added} updated=${beforeDry.updated} unchanged=${beforeDry.unchanged}`);
    const realRun = await importSepiaPackRules({ dryRun: false });
    check("import", "真实导入后 added 与 dryRun 预报一致", realRun.added === beforeDry.added, `added=${realRun.added}`);
    check("import", "无冲突（本地无同名手写规则）", realRun.conflicts.length === 0 || realRun.conflicts.every((c) => c.reason !== "local_modified"), `conflicts=${realRun.conflicts.length}`);
    const afterDry = await importSepiaPackRules({ dryRun: true });
    check("import", "再次 dryRun 全部 unchanged（幂等）", afterDry.added === 0 && afterDry.updated === 0, `added=${afterDry.added} updated=${afterDry.updated} unchanged=${afterDry.unchanged}`);
    const importedRows = await prisma.antiAiRule.findMany({ where: { packKey: "sepia-webnovel" }, select: { key: true, packVersion: true, ruleGroup: true } });
    check(
      "import",
      "落库行带 packKey 与分组",
      importedRows.length >= realRun.added && importedRows.length > 0 && importedRows.every((r) => r.ruleGroup),
      `rows=${importedRows.length} 本次新增=${realRun.added}`,
    );
    createdRuleKeys.push(...importedRows.map((r) => r.key));

    // ─────────────────────────────────────────────────────────────
    stage(3, "建夹具（1 书 4 章 + 悬疑题材）");
    // 自愈：上一次被中断（Ctrl-C / 管道提前关闭）可能留下同名夹具，先清干净再建。
    const stale = await prisma.novel.findMany({ where: { title: "__sepia_chain_fixture__" }, select: { id: true } });
    for (const row of stale) {
      await prisma.chapter.deleteMany({ where: { novelId: row.id } });
      await prisma.novel.deleteMany({ where: { id: row.id } });
    }
    await prisma.novelGenre.deleteMany({ where: { name: "__sepia_chain_悬疑__" } });
    const genre = await prisma.novelGenre.create({ data: { name: "__sepia_chain_悬疑__" } });
    const novel = await prisma.novel.create({
      data: { title: "__sepia_chain_fixture__", genreId: genre.id, description: "悬疑 推理 案件" },
    });
    const chapter1 = await prisma.chapter.create({ data: { novelId: novel.id, order: 1, title: "一", hook: "井沿上蹲着个人。", conflictLevel: 2, content: "正文一" } });
    const chapter2 = await prisma.chapter.create({ data: { novelId: novel.id, order: 2, title: "二", hook: "他数了三遍，都是二十三。", conflictLevel: 3, content: "正文二" } });
    const chapter3 = await prisma.chapter.create({ data: { novelId: novel.id, order: 3, title: "三", hook: "门开了，里面有光。", conflictLevel: 2, content: "正文三" } });
    const chapter4 = await prisma.chapter.create({ data: { novelId: novel.id, order: 4, title: "四", hook: "车票上是青石桥。", conflictLevel: 4, content: "正文四" } });
    fixture = { novelId: novel.id, genreId: genre.id, chapterIds: [chapter1.id, chapter2.id, chapter3.id, chapter4.id] };
    check("fixture", "夹具就绪", Boolean(novel.id && chapter4.id), `novel=${novel.id}`);

    // ─────────────────────────────────────────────────────────────
    stage(4, "架构表写入 + 拦截（HTTP）");
    const missing = await http("GET", `/api/sepia/chapters/${chapter1.id}/blueprint`);
    check("blueprint", "空表 GET 返回 8 项 gaps", missing.status === 200 && missing.json?.data?.validation?.gaps?.length === 8, `gaps=${missing.json?.data?.validation?.gaps?.length}`);
    const fields = (missing.json?.data?.validation?.gaps || []).map((g) => g.field);
    check(
      "blueprint",
      "gaps 覆盖 6 blocked + 2 warning",
      ["want", "obstacle", "action", "result", "change", "cliff"].every((f) => fields.includes(f))
        && ["infoTiming", "relations"].every((f) => fields.includes(f)),
      fields.join(","),
    );

    const vaguePut = await http("PUT", `/api/sepia/chapters/${chapter1.id}/blueprint`, { blueprint: VAGUE_BLUEPRINT });
    check("blueprint", "空话架构表被 400 拦下", vaguePut.status === 400, `HTTP ${vaguePut.status}`);

    const goodPut = await http("PUT", `/api/sepia/chapters/${chapter1.id}/blueprint`, { blueprint: GOOD_BLUEPRINT });
    check("blueprint", "具体架构表 0 gaps 落库", goodPut.status === 200 && goodPut.json?.data?.validation?.ok === true, `blocked=${goodPut.json?.data?.validation?.blockedCount}`);

    const goodGet = await http("GET", `/api/sepia/chapters/${chapter1.id}/blueprint`);
    check("blueprint", "回读与写入一致", goodGet.json?.data?.blueprint?.want === GOOD_BLUEPRINT.want);

    const vagueDraft = await http("PUT", `/api/sepia/chapters/${chapter2.id}/blueprint`, { allowBlocked: true, blueprint: VAGUE_BLUEPRINT });
    check("blueprint", "allowBlocked 允许存草稿", vagueDraft.status === 200 && vagueDraft.json?.data?.validation?.ok === false, `blocked=${vagueDraft.json?.data?.validation?.blockedCount}`);

    // ─────────────────────────────────────────────────────────────
    stage(5, "生成前门（四模式 + 缺表放行）");
    // 默认 null → write
    const gDefault = await blueprintGate.evaluateBlueprintGate({ novelId: novel.id, chapterId: chapter1.id, runtimeMode: "single" });
    check("gate", "具体表 + 单章模式 → 放行", gDefault.blocked === false, `mode=${gDefault.mode} blocked=${gDefault.blockedCount}`);

    const gBlockedSingle = await blueprintGate.evaluateBlueprintGate({ novelId: novel.id, chapterId: chapter2.id, runtimeMode: "single" });
    check("gate", "草稿表 + 单章模式 → 拦", gBlockedSingle.blocked === true, `blockedCount=${gBlockedSingle.blockedCount}`);

    const gAutopilot = await blueprintGate.evaluateBlueprintGate({ novelId: novel.id, chapterId: chapter2.id, runtimeMode: "autopilot" });
    check("gate", "草稿表 + 批量导演 → 降级不拦", gAutopilot.blocked === false && gAutopilot.blockedCount > 0, `blocked=${gAutopilot.blockedCount} reason=${gAutopilot.reason.slice(0, 24)}`);

    const gMissing = await blueprintGate.evaluateBlueprintGate({ novelId: novel.id, chapterId: chapter4.id, runtimeMode: "single" });
    check("gate", "章上没表 → 不拦（存量书不被卡死）", gMissing.blocked === false && gMissing.blueprintMissing === true);

    await http("PUT", `/api/sepia/novels/${novel.id}/blueprint-gate`, { mode: "all" });
    const gAll = await blueprintGate.evaluateBlueprintGate({ novelId: novel.id, chapterId: chapter2.id, runtimeMode: "autopilot" });
    check("gate", "mode=all 时批量导演也拦", gAll.blocked === true, `blocked=${gAll.blockedCount}`);

    await http("PUT", `/api/sepia/novels/${novel.id}/blueprint-gate`, { mode: "off" });
    const gOff = await blueprintGate.evaluateBlueprintGate({ novelId: novel.id, chapterId: chapter2.id, runtimeMode: "single" });
    check("gate", "mode=off 只记录不拦", gOff.blocked === false && gOff.blockedCount > 0);

    const badMode = await http("PUT", `/api/sepia/novels/${novel.id}/blueprint-gate`, { mode: "bogus" });
    check("gate", "非法 mode → 400", badMode.status === 400, `HTTP ${badMode.status}`);

    await http("PUT", `/api/sepia/novels/${novel.id}/blueprint-gate`, { mode: "write" });
    let thrown = null;
    try {
      await blueprintGate.assertBlueprintGate({ novelId: novel.id, chapterId: chapter2.id, runtimeMode: "single" });
    } catch (error) { thrown = error; }
    check(
      "gate",
      "assert 抛 BlueprintGateBlockedError 且带 gaps",
      thrown && thrown.name === "BlueprintGateBlockedError" && Array.isArray(thrown.gaps) && thrown.gaps.length > 0,
      thrown ? `${thrown.name} gaps=${thrown.gaps?.length}` : "未抛出",
    );
    const okAssert = await blueprintGate.assertBlueprintGate({ novelId: novel.id, chapterId: chapter1.id, runtimeMode: "single" });
    check("gate", "assert 对合格章不抛", okAssert.blocked === false);

    // ─────────────────────────────────────────────────────────────
    stage(6, "技法选择（写入一次 + 复用）");
    const tech1 = await ensureChapterTechniques({ novelId: novel.id, chapterId: chapter1.id, chapterOrder: 1 });
    check("tech", "首次选择落在 3–5 招", tech1 && tech1.techniqueIds.length >= 3 && tech1.techniqueIds.length <= 5, `${tech1?.techniqueIds.length} 招`);
    check("tech", "必含减法技 tech30", Boolean(tech1?.techniqueIds.includes("tech30")), tech1?.techniqueIds.join(","));
    check(
      "tech",
      "必含至少 1 个加颗粒技法",
      Boolean(tech1?.techniqueIds.some((id) => ["tech15", "tech16", "tech21", "tech24", "tech26"].includes(id))),
    );
    check("tech", "角色识别为悬疑", tech1?.roleKey === "suspense", String(tech1?.roleKey));
    check("tech", "首次 persisted=true", tech1?.persisted === true);
    const tech1b = await ensureChapterTechniques({ novelId: novel.id, chapterId: chapter1.id, chapterOrder: 1 });
    check("tech", "二次调用不重选且 persisted=false", tech1b?.persisted === false && JSON.stringify(tech1b.techniqueIds) === JSON.stringify(tech1.techniqueIds));
    const rowAfter = await prisma.chapter.findUnique({ where: { id: chapter1.id }, select: { sepiaTechKeysJson: true } });
    check("tech", "技法已落库字段", Boolean(rowAfter?.sepiaTechKeysJson && rowAfter.sepiaTechKeysJson.includes("tech30")));

    // ─────────────────────────────────────────────────────────────
    stage(7, "写作契约（注入内容与预算）");
    const chapterRow = await prisma.chapter.findUnique({
      where: { id: chapter1.id },
      select: { order: true, sepiaBlueprintJson: true, sepiaTechKeysJson: true },
    });
    const contract = buildSepiaWritingContract({
      chapter: chapterRow,
      novel: { title: novel.title, genre: { name: "悬疑", description: "悬疑 推理 案件" }, primaryStoryMode: null },
      usedRecently: [],
    });
    check("contract", "契约非空", Boolean(contract));
    check("contract", "角色名与画像已填充", Boolean(contract?.roleName && contract?.persona), `${contract?.roleName}`);
    check("contract", "含架构表行（≥4 行）", Boolean(contract?.blueprintLines?.length >= 4), `${contract?.blueprintLines?.length} 行`);
    check("contract", "含本章技法", Boolean(contract?.techniques?.length), `${contract?.techniques?.length} 条`);
    check("contract", "含本类型禁用词", Boolean(contract?.bannedWords?.length), `${contract?.bannedWords?.length} 词`);
    const contractText = renderSepiaContractText(contract);
    check("contract", "渲染文本 ≤700 字（预算硬上限）", contractText.length <= 700, `${contractText.length} 字`);
    check("contract", "渲染文本含章末悬着", contractText.includes("车票"));
    const emptyContract = buildSepiaWritingContract({ chapter: { order: 9 }, novel: { title: "x" } });
    check("contract", "无表无技法 → 不注入空壳", emptyContract === null);

    // ─────────────────────────────────────────────────────────────
    stage(8, "机械门（真实 python 子进程）");
    const gate = getSepiaGate();
    const badReport = await gate.run(BAD_TEXT);
    check("machine", "坏文本有硬伤", badReport.blockingCount > 0, `blocking=${badReport.blockingCount}`);
    check("machine", "去味真的跑了", badReport.deslop === "ok" && badReport.deslopOk === true, `deslop=${badReport.deslop}`);
    const badIds = badReport.blocking.map((b) => b.checkId);
    check("machine", "命中破折号与禁用词", badIds.some((id) => /L1-1/.test(id)) && badIds.some((id) => /L1-2/.test(id)), badIds.join(","));
    check("machine", "报告带 packVersion", Boolean(badReport.packVersion), String(badReport.packVersion));

    const cleanReport = await gate.run(CLEAN_TEXT);
    check("machine", "干净文本 0 硬伤", cleanReport.blockingCount === 0, `blocking=${cleanReport.blockingCount} advisory=${cleanReport.advisoryCount}`);

    // ─────────────────────────────────────────────────────────────
    stage(9, "验收合并（硬伤 → 可修）");
    const mergedBad = await applySepiaGate({ ...ACCEPTED_ASSESSMENT, blockingIssues: [], repairDirectives: [], riskTags: [] }, BAD_TEXT, { gate });
    check("accept", "状态从 accepted 变为 repairable", mergedBad.assessment.status === "repairable", mergedBad.assessment.status);
    check("accept", "continuePolicy=repair_once", mergedBad.assessment.continuePolicy === "repair_once", mergedBad.assessment.continuePolicy);
    const blockTag = mergedBad.assessment.riskTags.find((t) => t.startsWith("sepia_blocking:"));
    check("accept", "riskTags 带真实计数", Boolean(blockTag), blockTag);
    const tagCount = blockTag ? Number(blockTag.split(":")[1]) : -1;
    check("accept", "计数与报告 blockedCount 一致", tagCount === badReport.blockingCount, `${tagCount} vs ${badReport.blockingCount}`);
    check("accept", "directive 数量与硬伤条数对齐（≤5 且 ≥min(n,5)）", mergedBad.assessment.repairDirectives.length === Math.min(badReport.blockingCount, 5), `${mergedBad.assessment.repairDirectives.length} 条`);
    check("accept", "每条 directive 有可执行 instruction", mergedBad.assessment.repairDirectives.every((d) => typeof d.instruction === "string" && d.instruction.length > 4));
    check("accept", "未降级", mergedBad.degraded === false && mergedBad.report !== null);

    stage(10, "修文后复检（放行条件不依赖截断数组）");
    const mergedClean = await applySepiaGate({ ...ACCEPTED_ASSESSMENT, blockingIssues: [], repairDirectives: [], riskTags: [] }, CLEAN_TEXT, { gate });
    check("accept", "干净文本保持 accepted", mergedClean.assessment.status === "accepted", mergedClean.assessment.status);
    check("accept", "干净文本不带 blocking 标签", !mergedClean.assessment.riskTags.some((t) => t.startsWith("sepia_blocking:")));
    check("accept", "干净文本 continuePolicy=continue", mergedClean.assessment.continuePolicy === "continue");
    const synthetic = await require(path.join(DIST, "services/sepia/acceptance/sepiaAcceptance")).mergeSepiaIntoAssessment(
      { ...ACCEPTED_ASSESSMENT },
      { blockingCount: 1, advisoryCount: 0, blocking: [], advisory: [], deslop: "ok", deslopOk: true },
    );
    check("accept", "报告 1 条硬伤但数组为空 → 仍判可修（不误放行）", synthetic.status === "repairable", `${synthetic.status} tags=${synthetic.riskTags.join(",")}`);

    // ─────────────────────────────────────────────────────────────
    stage(11, "卷级诊断（HTTP，本卷口径）");
    const vol = await http("POST", "/api/sepia/volume-diagnostics", { novelId: novel.id, chapterOrders: [1, 2, 3] });
    const volData = vol.json?.data;
    check("volume", "只看本卷 3 章", volData?.lastN === 3 && volData?.chapters?.length === 3, `lastN=${volData?.lastN} chapters=${volData?.chapters?.length}`);
    check("volume", "钩子分类已产出", Boolean(volData?.hookTypes && Object.keys(volData.hookTypes).length > 0), JSON.stringify(volData?.hookTypes));
    check("volume", "推不出的项显式 unavailable 而非编数字", volData?.peakPositions?.source === "unavailable" && volData?.peakPositions?.value === null, `peak=${volData?.peakPositions?.source}`);
    check("volume", "孤儿伏笔计数为数字", typeof volData?.orphanForeshadows?.count === "number", String(volData?.orphanForeshadows?.count));
    const volEmpty = await http("POST", "/api/sepia/volume-diagnostics", { novelId: "" });
    check("volume", "空 novelId → 400", volEmpty.status === 400, `HTTP ${volEmpty.status}`);

    // ─────────────────────────────────────────────────────────────
    stage(12, "总闸（SEPIA_DISABLED）");
    process.env.SEPIA_DISABLED = "1";
    const techOff = await ensureChapterTechniques({ novelId: novel.id, chapterId: chapter3.id, chapterOrder: 3 });
    check("flag", "关闸后不选技法", techOff === null);
    const gateOff = await blueprintGate.evaluateBlueprintGate({ novelId: novel.id, chapterId: chapter2.id, runtimeMode: "single" });
    check("flag", "关闸后生成前门不拦", gateOff.blocked === false, `mode=${gateOff.mode}`);
    const accOff = await applySepiaGate({ ...ACCEPTED_ASSESSMENT }, BAD_TEXT);
    check("flag", "关闸后验收不跑机械门", accOff.report === null && accOff.degraded === false && accOff.assessment.status === "accepted");
    delete process.env.SEPIA_DISABLED;
    const techBack = await ensureChapterTechniques({ novelId: novel.id, chapterId: chapter3.id, chapterOrder: 3 });
    check("flag", "开闸后恢复选技法", Boolean(techBack && techBack.techniqueIds.length > 0), `${techBack?.techniqueIds.length} 招`);
  } catch (error) {
    failures.push(`未捕获异常：${error && error.message}`);
    console.error("\n!! 链路中断：", error);
  } finally {
    // ─────────────────────────────────────────────────────────────
    stage(13, "清理夹具");
    if (fixture) {
      await prisma.chapter.deleteMany({ where: { novelId: fixture.novelId } });
      await prisma.novel.deleteMany({ where: { id: fixture.novelId } });
      await prisma.novelGenre.deleteMany({ where: { id: fixture.genreId } });
    }
    if (createdRuleKeys.length > 0) {
      await prisma.antiAiRule.deleteMany({ where: { key: { in: createdRuleKeys }, packKey: "sepia-webnovel" } });
    }
    const [novels, chapters, genres, rules] = await Promise.all([
      prisma.novel.count(), prisma.chapter.count(), prisma.novelGenre.count({ where: { name: "__sepia_chain_悬疑__" } }), prisma.antiAiRule.count(),
    ]);
    notes.push(`清理后：novels=${novels} chapters=${chapters} 残留题材=${genres} rules=${rules}（导入的 ${createdRuleKeys.length} 条已回滚）`);
    console.log(`  · ${notes[notes.length - 1]}`);
    await prisma.$disconnect();
  }

  console.log(`\n════ 通过 ${pass} 项，失败 ${failures.length} 项 ════`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("整链路全通过。");
})().catch(async (error) => {
  console.error("FATAL", error);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
