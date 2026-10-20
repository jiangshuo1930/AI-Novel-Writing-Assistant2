const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

/**
 * sepia 是加法功能：机械门、生成前门、技法选择、写作契约都不改变"生成/验收/修复/预算"
 * 这条主链路的语义。这些测试写于合并之前，主语是预算、租约、产物同步，被 sepia 拉进来
 * 的依赖不该让它们连加载都失败。
 *
 * 所以给这四个模块配**中立替身**（门永远放行、不选技法、不产出契约），而不是把真实实现
 * 放进来——真实实现会去连库、起 python 子进程，正好违反本 harness"只允许显式替身跨边界"
 * 的初衷。sepia 自身的判定由 `server/tests/sepia*.test.cjs` 与
 * `server/scripts/sepia-chain-smoke.cjs` 覆盖，不靠这里。
 *
 * 注意：仍然是白名单，未列出的 id 一律抛错——新增依赖时这里必须显式补，不许静默放行。
 */
const SEPIA_DOUBLES = {
  "../../sepia/acceptance/sepiaAcceptance": {
    applySepiaGate: async (assessment) => ({ assessment, report: null, degraded: false }),
    mergeSepiaIntoAssessment: (assessment) => assessment,
    classifyFixClass: () => "patch",
    issueCodeOf: (finding) => finding.checkId,
    toAcceptanceIssues: () => [],
    toRepairDirectives: () => [],
    isDistributionOnly: () => false,
    SEPIA_BLOCKING_TAG: "sepia_blocking",
    SEPIA_ADVISORY_TAG: "sepia_advisory",
    SEPIA_UNAVAILABLE_TAG: "sepia_gate_unavailable",
  },
  "../../sepia/blueprint/sepiaBlueprintGate": {
    assertBlueprintGate: async () => ({
      blocked: false, mode: "write", runtimeMode: "single", blueprintMissing: true,
      blockedCount: 0, warningCount: 0, gaps: [], reason: "",
    }),
    evaluateBlueprintGate: async () => ({
      blocked: false, mode: "write", runtimeMode: "single", blueprintMissing: true,
      blockedCount: 0, warningCount: 0, gaps: [], reason: "",
    }),
    decideBlueprintGate: () => ({
      blocked: false, mode: "write", runtimeMode: "single", blueprintMissing: true,
      blockedCount: 0, warningCount: 0, gaps: [], reason: "",
    }),
    BlueprintGateBlockedError: class BlueprintGateBlockedError extends Error {
      constructor(message, gaps) { super(message); this.name = "BlueprintGateBlockedError"; this.gaps = gaps ?? []; }
    },
  },
  "../../sepia/techniques/ensureChapterTechniques": {
    ensureChapterTechniques: async () => null,
  },
  "../../sepia/contract/buildSepiaContract": {
    buildSepiaWritingContract: () => null,
    renderSepiaContractText: () => "",
  },
  "../../sepia/gate/sepiaGateStatus": {
    buildSepiaGateStatus: () => ({
      schemaVersion: 1, verdict: "passed", blocking: 0, advisory: 0,
      deslop: "ok", packVersion: "", contentHash: "", checkedAt: "",
    }),
    saveSepiaGateStatus: async () => undefined,
    parseSepiaGateStatus: () => null,
  },
  // 结构自检是额外一次 LLM 调用；替身恒返回 null（= 本次跳过），
  // 这样预算/租约这些老用例的行为与合并前逐字节一致。
  "../../sepia/selfcheck/sepiaSelfCheck": {
    SEPIA_SELFCHECK_PASS_TAG: "sepia_selfcheck:pass",
    SEPIA_SELFCHECK_FAIL_PREFIX: "sepia_selfcheck:fail",
    SEPIA_SELFCHECK_ADVISORY_PREFIX: "sepia_selfcheck_advisory",
    SEPIA_SELFCHECK_UNAVAILABLE_TAG: "sepia_selfcheck_unavailable",
    mergeSelfCheckIntoAssessment: (assessment) => assessment,
    isBlockingLevelItem: () => false,
    readSelfCheckBlockingCount: () => 0,
    hasSelfCheckUnavailableTag: () => false,
  },
  "./SepiaStructuralSelfCheckService": {
    runSepiaStructuralSelfCheck: async () => null,
  },
};

// Only explicit doubles can cross the module boundary: no production DB or LLM imports.
function loadRuntimeSource(filename, imports) {
  const sourcePath = path.resolve(__dirname, "../../src/services/novel/runtime", filename);
  const source = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  }).outputText;
  const exports = {};
  const evaluate = vm.runInThisContext(
    `(function(require, exports) {\n${source}\n})`, { filename: sourcePath },
  );
  evaluate((id) => {
    if (Object.hasOwn(imports, id)) return imports[id];
    if (Object.hasOwn(SEPIA_DOUBLES, id)) return SEPIA_DOUBLES[id];
    throw new Error(`Unmocked production dependency: ${id}`);
  }, exports);
  return exports;
}

function createPipelineHarness({
  content = "original draft",
  scores = [90],
  repairError,
  repairContent = "repair candidate",
  repairContents,
  repairMetadata = {},
  acceptanceMeta = {},
  acceptanceAssessment,
  recheckAssessment,
  auditHasBlockingIssues = false,
  timelineStatus,
  stopAt,
  artifactSyncStatus = "completed",
  completedArtifacts,
  reviewRetrySummary,
} = {}) {
  const events = [];
  const committedContents = [];
  const syncedContents = [];
  const reviewBaselines = [];
  const styleBaselines = [];
  let persisted = content;
  let reviewIndex = 0;
  let budget = 0;
  let approved = false;
  let finalizedResult;
  const selectionModule = loadRuntimeSource("selection/ChapterRepairCandidateSelection.ts", {
    "node:crypto": { createHash: require("node:crypto").createHash },
  });
  const { runPipelineChapterWithRuntime } = loadRuntimeSource("chapterRuntimePipeline.ts", {
    "./acceptance": { currentChapterReviewRetryBudget: () => reviewRetrySummary ? { loadSummary: async () => ({ ...reviewRetrySummary }) } : undefined },
    "../../styleEngine/styleGenerationSanitizer": { detectForbiddenStyleEntities: () => [] },
    "./chapterEmptyContentError": { assertChapterContentNotEmpty: (value) => value, isChapterEmptyContentError: () => false },
    "./repair/chapterRepairRuntime": {
      runChapterRepairText: async () => {
        events.push("repair");
        if (repairError) throw repairError;
        const round = events.filter((event) => event === "repair").length - 1;
        const nextContent = Array.isArray(repairContents)
          ? (repairContents[Math.min(round, repairContents.length - 1)] ?? repairContent)
          : repairContent;
        return { content: nextContent, ...repairMetadata };
      },
    },
    "../chapterPatchRepairService": { ChapterPatchRepairFailedError: class extends Error {} },
    "./selection/ChapterRepairCandidateSelection": selectionModule,
    "./repair/ChapterRepairEligibility": loadRuntimeSource("repair/ChapterRepairEligibility.ts", {}),
    "./proseQuality": loadRuntimeSource("proseQuality/ProseQualityDetector.ts", {}),
    "./artifactSync/ChapterArtifactSyncResult": {
      ChapterArtifactSyncBoundaryError: class extends Error {
        constructor(result) { super(result.reason); this.result = result; }
      },
    },
  });
  const deps = {
    loadFinalizedChapterResult: async () => finalizedResult && { content: persisted, result: finalizedResult },
    persistFinalizedChapterResult: async (_novel, _chapter, value, result) => {
      assertFinalContent(value);
      events.push("finalized_checkpoint");
      finalizedResult = JSON.parse(JSON.stringify(result));
    },
    validateRequest: () => ({}),
    ensureNovelCharacters: async () => {},
    assemble: async () => ({ novel: { title: "Novel" }, chapter: { title: "Chapter", content: persisted }, contextPackage: {} }),
    generateDraftFromWriter: async () => { events.push("writer"); return { content: "generated draft" }; },
    saveDraftAndArtifacts: async (_novel, _chapter, value) => {
      persisted = value;
      events.push("save");
      if (stopAt === "after_save") throw new Error("after_save");
    },
    finalizeChapterContent: async ({ content: value, repairReviewBaseline, styleRewriteBaseline }) => {
      reviewBaselines.push(repairReviewBaseline);
      styleBaselines.push(styleRewriteBaseline);
      events.push("acceptance");
      if (stopAt === "recheck" && reviewIndex > 0) throw new Error("recheck");
      const roundIndex = Math.min(reviewIndex, scores.length - 1);
      const score = scores[roundIndex];
      reviewIndex += 1;
      // 数组形态用于多轮收敛：每轮可以给不同的门结果（sepia 硬伤数逐轮下降）。
      const roundMeta = Array.isArray(acceptanceMeta)
        ? (acceptanceMeta[Math.min(roundIndex, acceptanceMeta.length - 1)] ?? {})
        : acceptanceMeta;
      const roundAssessment = Array.isArray(acceptanceAssessment)
        ? (acceptanceAssessment[Math.min(roundIndex, acceptanceAssessment.length - 1)] ?? null)
        : (reviewIndex > 1 && recheckAssessment ? recheckAssessment : acceptanceAssessment);
      return {
        finalContent: value,
        runtimePackage: {
          novelId: "n", chapterId: "c",
          audit: { score: { coherence: score, repetition: score, engagement: score, overall: score }, openIssues: [], reports: [], hasBlockingIssues: auditHasBlockingIssues },
          context: {}, meta: { acceptanceStatus: score >= 80 ? "accepted" : "repairable", ...roundMeta },
          styleReview: { report: null, autoRewritten: false, originalContent: null },
          ...(timelineStatus ? { timelineCheck: { status: timelineStatus } } : {}),
        },
        needsRepair: score < 80,
        ...(roundAssessment ? { acceptanceResult: { assessment: roundAssessment } } : {}),
      };
    },
    commitFinalizedChapterContent: async ({ evaluation }) => {
      events.push("terminal_commit");
      committedContents.push(evaluation.finalContent);
    },
    markChapterGenerationState: async (_id, state) => {
      events.push(state);
      if (state === "approved") approved = true;
    },
    markChapterNeedsRepair: async () => events.push("needs_repair"),
    syncFinalChapterArtifacts: async (_novel, _chapter, value) => {
      events.push("artifact_sync");
      syncedContents.push(value);
      if (stopAt === "artifact_sync") throw new Error("artifact_sync");
      return {
        status: artifactSyncStatus,
        contentHash: value,
        completedArtifacts: completedArtifacts ?? (artifactSyncStatus === "completed" ? ["artifact_delta"] : []),
        reason: artifactSyncStatus === "completed" ? undefined : `artifact sync ${artifactSyncStatus}`,
      };
    },
  };
  function assertFinalContent(value) {
    if (value !== persisted) throw new Error("checkpoint must describe the retained saved draft");
  }
  return {
    events,
    reviewBaselines,
    styleBaselines,
    get content() { return persisted; },
    get budget() { return budget; },
    get approved() { return approved; },
    get committedContents() { return [...committedContents]; },
    get syncedContents() { return [...syncedContents]; },
    resume: () => { stopAt = undefined; artifactSyncStatus = "completed"; },
    run: (options = {}, hooks = {}) => runPipelineChapterWithRuntime(deps, "n", "c", options, {
      onRetryConsumed: async () => { budget++; }, ...hooks,
    }),
  };
}

module.exports = { loadRuntimeSource, createPipelineHarness };
