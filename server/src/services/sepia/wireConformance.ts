/**
 * 线协议一致性检查（编译期，零运行时）
 *
 * `shared/types/sepia.ts` 是客户端唯一的 sepia 类型来源，服务端各 service
 * 保留自己的定义（那里的注释带着判定逻辑的上下文）。两边是两份代码，
 * 靠这个文件做**双向赋值**把它们钉在一起：
 *
 *   - 共享类型少字段 → `service → shared` 赋值报错
 *   - 共享类型多必填字段 → `shared → service` 赋值报错
 *   - 联合类型收窄/放宽 → 任一向报错
 *
 * 只写赋值，不写断言函数，编译完即空文件。任何一边改结构而另一边没跟上，
 * `pnpm -C server typecheck` 会直接失败，不会等到前端渲染时才发现字段是 undefined。
 */

import type {
  SepiaBlueprintGap,
  SepiaBlueprintValidation,
  SepiaChapterBlueprint,
  SepiaGateFinding,
  SepiaGateRawFinding,
  SepiaGateReport,
  SepiaPackImportDiff,
  SepiaRoleBrief,
  SepiaTechniqueBrief,
  SepiaTechniqueSelection,
  SepiaVolumeDiagnostics,
} from "@ai-novel/shared/types/sepia";

import type {
  BlueprintGap,
  BlueprintValidation,
  ChapterBlueprint,
} from "./blueprint/sepiaBlueprint";
import type { SepiaGateFinding as ServiceGateFinding, SepiaGateReport as ServiceGateReport } from "./gate/SepiaGateService";
import type { PackImportDiff } from "./pack/sepiaPackImport";
import type {
  SelectedTechnique,
  TechniqueSelection,
} from "./techniques/sepiaTechniques";
import type { VolumeDiagnostics } from "./volume/volumeDiagnostics";
import type { SepiaFinding, SepiaRole, SepiaTechnique } from "./types";

/** 双向赋值：两个方向都通过才算"同一份协议" */
function sameContract<A, B>(_forward: (value: A) => B, _backward: (value: B) => A): void {
  /* 仅用于类型检查 */
}

/* 机械门 */
sameContract<ServiceGateFinding, SepiaGateFinding>((value) => value, (value) => value);
sameContract<ServiceGateReport, SepiaGateReport>((value) => value, (value) => value);
sameContract<SepiaFinding, SepiaGateRawFinding>((value) => value, (value) => value);

/* 架构表 */
sameContract<ChapterBlueprint, SepiaChapterBlueprint>((value) => value, (value) => value);
sameContract<BlueprintGap, SepiaBlueprintGap>((value) => value, (value) => value);
sameContract<BlueprintValidation, SepiaBlueprintValidation>((value) => value, (value) => value);

/* 技法与角色 */
sameContract<SepiaTechnique, SepiaTechniqueBrief>((value) => value, (value) => value);
sameContract<SepiaRole, SepiaRoleBrief>((value) => value, (value) => value);
sameContract<TechniqueSelection, SepiaTechniqueSelection>((value) => value, (value) => value);
sameContract<SelectedTechnique, SepiaTechniqueSelection["techniques"][number]>((value) => value, (value) => value);

/* 规则导入 */
sameContract<PackImportDiff, SepiaPackImportDiff>((value) => value, (value) => value);

/* 卷级诊断 */
sameContract<VolumeDiagnostics, SepiaVolumeDiagnostics>((value) => value, (value) => value);

export {};
