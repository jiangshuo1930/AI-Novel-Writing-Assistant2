/**
 * sepia 数据层测试：参考文档的结构化转写是否真的接上了
 *
 * 覆盖三件在审计里发现「转了一半」的事：
 *   1. 甲部 14 条「底层」技法必须进生成契约（原文要求「不占配额」，不是「不用」）；
 *   2. 第 30 招的 summary 不能是空串（解析器曾跳过 `**辩证小标题**：正文`）；
 *   3. discourse / diagnosis / selfCheck / stateLedger / fingerprints 五个编译段有真实消费点。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");
const { getSepiaPack } = require(path.join(DIST, "services/sepia/pack/index.js"));
const {
  baseTechniqueNames,
  discourseLinesOf,
  modelFingerprintOf,
  buildSepiaWritingContract,
  renderSepiaContractText,
} = require(path.join(DIST, "services/sepia/contract/buildSepiaContract.js"));
const {
  buildSepiaGateStatus,
  parseSepiaGateStatus,
} = require(path.join(DIST, "services/sepia/gate/sepiaGateStatus.js"));
const {
  computeParagraphRhythm,
  computeDialoguePlacement,
  buildStateLedgerCoverage,
  pickDiagnosisGroup,
} = require(path.join(DIST, "services/sepia/volume/volumeDiagnostics.js"));

const pack = getSepiaPack();

test("五个参考文档都编译成结构化数据，计数与源文档一致", () => {
  assert.equal(pack.data.discourse.length, 6);
  assert.equal(pack.data.diagnosis.groups.length, 5);
  assert.equal(pack.data.diagnosis.groups.reduce((sum, group) => sum + group.items.length, 0), 29);
  assert.equal(pack.data.stateLedger.length, 6);
  assert.equal(pack.data.modelFingerprints.models.length, 5);
  assert.ok(pack.data.selfCheck.levels.length === 4);
  assert.ok(pack.data.selfCheck.falsePositiveWarnings.length > 0);
  assert.ok(pack.data.selfCheck.quickCheck.length > 0);
});

test("第 30 招的说明不再是空串（解析器修的是 `**小标题**：正文`）", () => {
  const tech30 = pack.data.techniques.find((item) => item.id === "tech30");
  assert.ok(tech30, "第30招必须存在");
  assert.ok(tech30.summary.trim().length > 0, "summary 不能为空");
  assert.match(tech30.summary, /减的是/);
  // 30 条全部有说明，避免同类漏解析再次发生
  assert.equal(pack.data.techniques.filter((item) => !item.summary.trim()).length, 0);
});

test("底层 14 条技法进入契约，且不占 3–5 招配额", () => {
  const names = baseTechniqueNames(pack);
  assert.equal(names.length, 14);
  assert.ok(names.includes("糙话/脏话"));
  assert.ok(names.includes("句式断裂"));

  const contract = buildSepiaWritingContract({
    chapter: { order: 1, sepiaTechKeysJson: JSON.stringify({ techniques: ["tech23", "tech17"] }) },
    novel: { title: "测试书", genre: { name: "玄幻" } },
  });
  assert.equal(contract.baseTechniques.length, 14);
  // 配额只看 techniques（3–5 招），底线不进这个数组
  assert.deepEqual(contract.techniques.map((item) => item.id), ["tech23", "tech17"]);

  const text = renderSepiaContractText(contract);
  assert.match(text, /人味底线/);
  assert.ok(text.indexOf("人味底线") < text.indexOf("本章技法"), "底线要排在招式前面");
});

test("篇章安排取 discourse-pass 毛病表里最易塌的四类", () => {
  const lines = discourseLinesOf(pack);
  assert.equal(lines.length, 4);
  assert.ok(lines.some((line) => line.startsWith("流水账：")));
  assert.ok(lines.some((line) => line.startsWith("结尾升华：")));
});

test("模型惯性按模型名匹配，匹配不上就不注入", () => {
  assert.match(modelFingerprintOf(pack, "deepseek-chat"), /前置交代/);
  assert.match(modelFingerprintOf(pack, "moonshot-v1-8k"), /指纹最淡/);
  assert.equal(modelFingerprintOf(pack, "some-unknown-model"), null);
  assert.equal(modelFingerprintOf(pack, null), null);
});

test("门结论落库结构可往返；坏数据按没有结论处理", () => {
  const status = buildSepiaGateStatus(
    {
      packVersion: "0.5.1",
      contentHash: "abc",
      deslop: "ok",
      deslopOk: true,
      stats: { chars: 1, paras: 1, sents: 1 },
      blocking: [],
      advisory: [],
      blockingCount: 3,
      advisoryCount: 7,
      raw: [],
    },
    false,
  );
  assert.equal(status.verdict, "blocked");
  assert.equal(status.blocking, 3);
  const round = parseSepiaGateStatus(JSON.stringify(status));
  assert.equal(round.blocking, 3);
  assert.equal(round.advisory, 7);
  assert.equal(parseSepiaGateStatus("{坏"), null);
  assert.equal(parseSepiaGateStatus(null), null);

  const unavailable = buildSepiaGateStatus(null, true);
  assert.equal(unavailable.verdict, "unavailable");
});

test("篇章指标只算字面，不编数据", () => {
  const rhythm = computeParagraphRhythm(["第一段挺长的，大概有三十多个字，写了一个动作和一点环境。\n\n短。\n\n第二段也比较长，继续推进情节和对话内容，长度和第一段差不多。"]);
  assert.equal(rhythm.source, "derived");
  assert.equal(rhythm.value.paragraphs, 3);

  const placement = computeDialoguePlacement(['他说：“走吧。”\n\n“不去。”她没抬头。']);
  assert.equal(placement.source, "unavailable", "少于 3 段对话时必须说不可用");

  const empty = computeParagraphRhythm([]);
  assert.equal(empty.source, "unavailable");
});

test("台账 6 节映射到 ANA 字段，缺的明说", () => {
  const coverage = buildStateLedgerCoverage(pack.data);
  assert.equal(coverage.total, 6);
  assert.ok(coverage.mapped >= 4, `实际映射 ${coverage.mapped} 节`);
  const missing = coverage.sections.filter((section) => !section.mappedTo);
  assert.equal(missing.length, coverage.total - coverage.mapped, "缺的节必须显式标 null");
});

test("体检组按章号轮转，同样章号永远取同一组", () => {
  const first = pickDiagnosisGroup(pack.data, 1);
  const again = pickDiagnosisGroup(pack.data, 1);
  assert.equal(first.groupKey, again.groupKey);
  const second = pickDiagnosisGroup(pack.data, 2);
  assert.notEqual(first.groupKey, second.groupKey);
  assert.ok(first.items.length > 0);
});
