/**
 * 结构自检测试：两张表的分工不能被混成一张门槛
 *
 * 关键断言只有三条：
 *   1. selfcheck 的 L2 / L3-1 / L3-2 / L4 未过 → 阻断（原文「交付前必须过」）；
 *   2. rubric 五组未过 → 只做诊断，不阻断（把它当门槛会让每章都卡死）；
 *   3. 模型漏判过多 → unavailable，不伪装成通过。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");
const { getSepiaPack } = require(path.join(DIST, "services/sepia/pack/index.js"));
const {
  buildSelfCheckRecord,
  mergeSelfCheckIntoAssessment,
  selfCheckRiskTags,
  readSelfCheckBlockingCount,
  isBlockingLevelItem,
  parseLevelItems,
  SEPIA_SELFCHECK_UNAVAILABLE_TAG,
} = require(path.join(DIST, "services/sepia/selfcheck/sepiaSelfCheck.js"));

const pack = getSepiaPack();

function levelItemIds() {
  const levels = pack.data.selfCheck.levels.filter((level) => level.key !== "L1");
  return levels.map((level) => ({
    key: level.key,
    items: parseLevelItems(level.items).map((item) => item.id),
  }));
}

/** 全通过的原始输出：先给一份"干净答卷"，再按用例改其中某项 */
function fullPassRaw() {
  return {
    diagnosis: pack.data.diagnosis.groups.map((group) => ({
      key: group.key,
      items: group.items.map((item) => ({ item: item.item, verdict: "pass", evidence: "", fix: "" })),
    })),
    levels: levelItemIds().map((level) => ({
      key: level.key,
      items: level.items.map((id) => ({ item: id, verdict: "pass", evidence: "", fix: "" })),
    })),
    summary: "干净。",
  };
}

function fail(raw, scope, key, item, evidence = "他忽然明白，这一切都是命。", fix = "删掉总结句") {
  const group = raw[scope].find((entry) => entry.key === key);
  const target = group.items.find((entry) => entry.item === item);
  assert.ok(target, `${scope}/${key}/${item} 不存在`);
  target.verdict = "fail";
  target.evidence = evidence;
  target.fix = fix;
  return raw;
}

function record(raw) {
  return buildSelfCheckRecord({ raw, pack, content: "正文正文正文", model: "test-model" });
}

test("全通过时 verdict=pass，没有任何阻断项", () => {
  const result = record(fullPassRaw());
  assert.equal(result.verdict, "pass");
  assert.equal(result.blocking.length, 0);
  assert.equal(result.levels.failed, 0);
  assert.deepEqual(selfCheckRiskTags(result), ["sepia_selfcheck:pass"]);
});

test("selfcheck 的 L4 未过是阻断项，并落成修文指令", () => {
  const result = record(fail(fullPassRaw(), "levels", "L4", "L4-2"));
  assert.equal(result.verdict, "fail");
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].item, "L4-2");
  assert.equal(readSelfCheckBlockingCount(selfCheckRiskTags(result)), 1);

  const merged = mergeSelfCheckIntoAssessment({
    status: "accepted",
    blockingIssues: [],
    repairDirectives: [],
    continuePolicy: "continue",
    riskTags: [],
  }, result);
  assert.equal(merged.status, "repairable");
  assert.equal(merged.continuePolicy, "repair_once");
  assert.equal(merged.blockingIssues.length, 1);
  assert.match(merged.blockingIssues[0].code, /^SEPIA_SELFCHECK_/);
  assert.equal(merged.repairDirectives[0].mode, "patch");
  assert.match(merged.repairDirectives[0].instruction, /^\[sepia 自检 L4-2\]/);
});

test("L3-3 / L3-4 不在通过标准里，未过只记诊断不阻断", () => {
  const raw = fail(fullPassRaw(), "levels", "L3", "L3-3");
  const result = record(raw);
  assert.equal(result.verdict, "pass", "L3-3 不是交付门槛");
  assert.equal(result.blocking.length, 0);
  assert.equal(result.advisory.length, 1);
  assert.equal(result.advisory[0].item, "L3-3");
});

test("rubric 五组未过只做诊断：每章都卡在体检表上等于没有流程", () => {
  const raw = fullPassRaw();
  raw.diagnosis[0].items[0].verdict = "fail";
  raw.diagnosis[0].items[0].evidence = "他终于明白，人这一生不过如此。";
  raw.diagnosis[0].items[0].fix = "删掉点题";
  raw.diagnosis[2].items[0].verdict = "over_corrected";
  raw.diagnosis[2].items[0].evidence = "三天后、五年前、两小时后……";
  raw.diagnosis[2].items[0].fix = "收回时线杂耍";
  const result = record(raw);
  assert.equal(result.verdict, "pass");
  assert.equal(result.diagnosis.failed, 1);
  assert.equal(result.diagnosis.overCorrected, 1);
  assert.equal(result.advisory.length, 2);
});

test("模型漏判过多时记 unavailable，不冒充通过", () => {
  const raw = fullPassRaw();
  raw.levels = [raw.levels[0]];
  raw.diagnosis = [];
  const result = record(raw);
  assert.equal(result.verdict, "unavailable");
  assert.deepEqual(selfCheckRiskTags(result), [SEPIA_SELFCHECK_UNAVAILABLE_TAG]);
  // 不可用不阻断：这里是额外一次 LLM 调用，抖动不该让整章停摆
  const merged = mergeSelfCheckIntoAssessment({
    status: "accepted",
    blockingIssues: [],
    repairDirectives: [],
    continuePolicy: "continue",
    riskTags: [],
  }, result);
  assert.equal(merged.status, "accepted");
  assert.ok(merged.riskTags.includes(SEPIA_SELFCHECK_UNAVAILABLE_TAG));
});

test("模型自创的项被忽略，判 pass 的项不带证据", () => {
  const raw = fullPassRaw();
  raw.levels[0].items.push({ item: "L9-9 自创项", verdict: "fail", evidence: "x", fix: "y" });
  raw.diagnosis[0].items[0].evidence = "这句其实没问题";
  const result = record(raw);
  assert.equal(result.verdict, "pass");
  assert.equal(result.blocking.length, 0);
  assert.ok(!JSON.stringify(result).includes("L9-9"));
  const passed = result.diagnosis.groups[0].items[0];
  assert.equal(passed.verdict, "pass");
  assert.equal(passed.evidence, "");
});

test("needs_manual_review 不被自检失败降级成可自动修", () => {
  const result = record(fail(fullPassRaw(), "levels", "L2", "L2-1"));
  const merged = mergeSelfCheckIntoAssessment({
    status: "needs_manual_review",
    blockingIssues: [],
    repairDirectives: [],
    continuePolicy: "pause",
    riskTags: [],
  }, result);
  assert.equal(merged.status, "needs_manual_review");
  assert.equal(merged.continuePolicy, "pause");
});

test("阻断项只认通过标准列出的编号，不做前缀误伤", () => {
  assert.equal(isBlockingLevelItem("L2", "L2-3"), true);
  assert.equal(isBlockingLevelItem("L3", "L3-1"), true);
  assert.equal(isBlockingLevelItem("L3", "L3-2"), true);
  assert.equal(isBlockingLevelItem("L3", "L3-3"), false);
  assert.equal(isBlockingLevelItem("L3", "L3-12"), false);
  assert.equal(isBlockingLevelItem("L4", "L4-4"), true);
});

test("自检结论落库时只存计数，不存整份明细", () => {
  const { buildSepiaGateStatus } = require(path.join(DIST, "services/sepia/gate/sepiaGateStatus.js"));
  const result = record(fail(fullPassRaw(), "levels", "L3", "L3-2"));
  const status = buildSepiaGateStatus(
    { blockingCount: 0, advisoryCount: 0, deslop: "ok", packVersion: pack.meta.packVersion, contentHash: "h" },
    false,
    new Date("2026-10-20T00:00:00Z"),
    result,
  );
  assert.equal(status.verdict, "passed");
  assert.equal(status.selfCheck.verdict, "fail");
  assert.equal(status.selfCheck.blocking, 1);
  assert.equal(typeof status.selfCheck.summary, "string");
  assert.equal(status.selfCheck.groups, undefined, "明细不能进 Chapter 行");
  const { parseSepiaGateStatus } = require(path.join(DIST, "services/sepia/gate/sepiaGateStatus.js"));
  assert.equal(parseSepiaGateStatus(JSON.stringify(status)).selfCheck.verdict, "fail");
  // 旧数据没有 selfCheck 字段，解析仍要成立
  const legacy = parseSepiaGateStatus(JSON.stringify({ verdict: "passed", blocking: 0 }));
  assert.equal(legacy.selfCheck, undefined);
});
