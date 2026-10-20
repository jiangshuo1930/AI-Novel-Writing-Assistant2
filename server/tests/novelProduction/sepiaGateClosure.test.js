const test=require('node:test');
const assert=require('node:assert/strict');
const {loadRuntimeSource,createPipelineHarness}=require('./sourceHarness.cjs');

function loadClosure(issues,assessments=[]){
  return loadRuntimeSource('../production/qualityClosure/ChapterQualityClosure.ts',{
    '@ai-novel/shared/types/directorIssue': require('../../../shared/dist/types/directorIssue'),
    '../../novelCoreShared':{logPipelineWarn:()=>{},logPipelineError:()=>{}},
    '../../novelCoreReviewService':{createQualityReport:async()=>{}},
    '../../quality/ChapterQualityLoopService':{chapterQualityLoopService:{recordAssessment:async input=>{assessments.push(input);}}},
    '../issueGovernance/PipelineIssueGovernance':{reportPipelineIssue:async input=>{issues.push(input);}},
  });
}

function closeWith(closure,result,extra={}){
  return closure.applyChapterQualityClosure({governance:null,novelId:'n',jobId:'job',chapter:{id:'c',order:1},chapterResult:result,
    qualityThreshold:75,runtimePayload:{autoReview:true},qualityAlertDetails:[],replanAlertDetails:[],recoverableRepairDetails:[],
    runLocalReplan:async()=>{throw Error('no replan');},...extra});
}

test('sepia blocking 未清零时在章节边界暂停，且不把本章记成已完成',async()=>{
  const h=createPipelineHarness({scores:[60],acceptanceMeta:{riskTags:['sepia_blocking:3','sepia_advisory:7']}});
  const result=await h.run();
  assert.equal(result.pass,false);
  const issues=[],assessments=[];
  const closure=loadClosure(issues,assessments);
  const closed=await closeWith(closure,result);
  assert.equal(closed.shouldStopAfterCurrentChapter,true);
  assert.equal(closed.stopAction,'pause_for_manual');
  // terminalAction 留空 = 不写 defer_and_continue 风险标记 → 恢复创作时不会被 skipCompleted 跳过
  assert.equal(assessments.length,1);
  assert.equal(assessments[0].terminalAction,null);
});

test('sepia 机械门没跑成也按未过门处理',async()=>{
  const h=createPipelineHarness({scores:[95],acceptanceMeta:{riskTags:['sepia_gate_unavailable']}});
  const result=await h.run();
  const issues=[],assessments=[];
  const closure=loadClosure(issues,assessments);
  const closed=await closeWith(closure,result);
  assert.equal(closed.shouldStopAfterCurrentChapter,true);
  assert.equal(closed.stopAction,'pause_for_manual');
  assert.equal(assessments[0].terminalAction,null);
});

test('sepia 门通过时沿用原有关闭策略，不额外暂停',async()=>{
  const h=createPipelineHarness({scores:[95],acceptanceMeta:{riskTags:[]}});
  const result=await h.run();
  assert.equal(result.pass,true);
  const issues=[],assessments=[];
  const closure=loadClosure(issues,assessments);
  const closed=await closeWith(closure,result);
  assert.equal(closed.shouldStopAfterCurrentChapter,false);
  assert.equal(issues.some(i=>i.issueCode==='quality.sepia_gate_blocked'),false);
});

test('sepia 门通过但分数未达标时仍记质量债并继续',async()=>{
  const h=createPipelineHarness({scores:[60],acceptanceMeta:{riskTags:[]}});
  const result=await h.run();
  const issues=[],assessments=[];
  const closure=loadClosure(issues,assessments);
  await closeWith(closure,result);
  assert.equal(assessments[0].terminalAction,'defer_and_continue');
});

test('结构自检未过同样在章节边界暂停，用的是自检专属编码',async()=>{
  // 机械项清零、分数也够，只有自检未过：这一章依然不算交付
  const h=createPipelineHarness({scores:[92],acceptanceMeta:{riskTags:['sepia_selfcheck:fail:2']}});
  const result=await h.run();
  assert.equal(result.pass,false);
  const issues=[],assessments=[];
  const closure=loadClosure(issues,assessments);
  const closed=await closeWith(closure,result);
  assert.equal(closed.shouldStopAfterCurrentChapter,true);
  assert.equal(closed.stopAction,'pause_for_manual');
  assert.equal(assessments[0].terminalAction,null);
});

test('自检没跑成不阻断，只让人看得见这章没跑自检',async()=>{
  const h=createPipelineHarness({scores:[92],acceptanceMeta:{riskTags:['sepia_selfcheck_unavailable']}});
  const result=await h.run();
  assert.equal(result.pass,true);
  const issues=[],assessments=[];
  const closure=loadClosure(issues,assessments);
  const closed=await closeWith(closure,result);
  assert.equal(closed.shouldStopAfterCurrentChapter,false);
});
