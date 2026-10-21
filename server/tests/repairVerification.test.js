const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateRepairReview,
  buildRepairReviewChecklist,
  ChapterRepairVerificationError,
} = require("../dist/prompting/prompts/novel/acceptance/repairVerification.js");
const {
  recoverAcceptanceStyleReview,
} = require("../dist/prompting/prompts/novel/acceptance/styleReview.js");

const CONTENT = "沈砚推开柴房的门。红豆提醒宿主节点不稳。他把半枚丹按在掌心，转身走向药圃。";

function input(overrides = {}) {
  const base = {
    novelTitle: "测试小说",
    chapterOrder: 1,
    chapterTitle: "第一章",
    content: CONTENT,
    previousChapterContent: null,
    styleReviewEnabled: false,
    styleRuleIds: [],
    expectedNarrativePov: null,
    repairReviewBaseline: {
      blockingIssues: [{ code: "prose_dash_or_ellipsis", category: "voice", severity: "high", evidence: "历史证据", fixSuggestion: "修掉" }],
      missingObligations: [],
      repairDirectives: [],
    },
    styleRewriteBaseline: null,
    ...overrides,
  };
  base.checklist = buildRepairReviewChecklist(base);
  return base;
}

function output(overrides = {}) {
  const inp = input();
  return {
    status: "repairable",
    score: { coherence: 80, repetition: 80, pacing: 80, engagement: 80, voice: 80, overall: 80 },
    summary: "s",
    decisionReason: "d",
    blockingIssues: [],
    repairDirectives: [],
    missingObligations: [],
    riskTags: [],
    assetSyncRecommendation: { priority: "normal", reason: "r", requiresFullPayoffReconcile: false },
    continuePolicy: "continue",
    repairVerification: {
      contentHash: inp.checklist.contentHash,
      checks: [{
        kind: "issue",
        key: "prose_dash_or_ellipsis",
        status: "unresolved",
        currentEvidence: "红豆提醒宿主节点不稳。",
        reason: "仍在",
      }],
    },
    inp,
    ...overrides,
  };
}

test("stale evidence error names the offending checks so the retry feedback is actionable", () => {
  const inp = input();
  const out = output();
  out.repairVerification.checks[0].currentEvidence = "这句来自历史报告，不在正文里。";
  try {
    validateRepairReview(out, inp);
    assert.fail("should throw");
  } catch (error) {
    assert.ok(error instanceof ChapterRepairVerificationError);
    assert.match(error.message, /prose_dash_or_ellipsis/);
    assert.match(error.message, /历史报告证据/);
  }
});

test("missing checklist entries are enumerated in the error", () => {
  const inp = input();
  const out = output();
  out.repairVerification.checks = [];
  try {
    validateRepairReview(out, inp);
    assert.fail("should throw");
  } catch (error) {
    assert.match(error.message, /prose_dash_or_ellipsis/);
    assert.match(error.message, /遗漏/);
  }
});

test("recover salvages a failed repair verification instead of discarding the whole assessment", () => {
  const inp = input();
  const out = output();
  out.repairVerification.checks[0].currentEvidence = "历史证据原句。";
  const recovered = recoverAcceptanceStyleReview(out, inp);
  assert.equal(recovered.repairVerification, undefined);
  assert.equal(recovered.status, "repairable");
  assert.ok(recovered.riskTags.includes("repair_verification_unavailable"));
  // 语义判断保留：blockingIssues 不被丢弃
  assert.equal(recovered.blockingIssues.length, out.blockingIssues.length);
});

test("accepted verdicts are demoted when repair verification is salvaged", () => {
  const inp = input();
  const out = output({ status: "accepted" });
  out.repairVerification.checks[0].status = "resolved";
  out.repairVerification.checks[0].currentEvidence = "历史证据原句。";
  const recovered = recoverAcceptanceStyleReview(out, inp);
  assert.equal(recovered.status, "continue_with_risk");
  assert.ok(recovered.riskTags.includes("repair_verification_unavailable"));
});

test("valid repair verification still passes through recovery unchanged", () => {
  const inp = input();
  const out = output();
  const recovered = recoverAcceptanceStyleReview(out, inp);
  assert.ok(recovered.repairVerification);
  assert.equal(recovered.riskTags.includes("repair_verification_unavailable"), false);
});
