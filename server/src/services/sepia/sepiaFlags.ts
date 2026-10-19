/**
 * sepia 合并层开关（唯一入口）
 *
 * 为什么要有这个文件：开关原来在 5 处各自读 `process.env.SEPIA_GATE_DISABLED`，
 * 名字说的是"门"，实际关掉的是**整套** sepia 合并功能（验收分级、写作契约、
 * 技法选择、生成前门、规则导入入口）。名字与语义不符，读代码的人会误以为
 * 只关了一层。这里把语义钉死，并把历史变量名保留为兼容别名。
 *
 * 语义：
 *   `SEPIA_DISABLED=1`        关掉 sepia 合并层全部功能，行为回到合并前
 *   `SEPIA_GATE_DISABLED=1`   旧名，等价；仍生效，只在第一次读取时打一次提示
 *
 * 不在这里做的是：单本书的架构表门模式（off/write/all）。
 * 那个是作者级数据（`Novel.sepiaBlueprintGate`），不是进程开关，混进来会让
 * "为什么这本书没被拦"变得没法回答。
 */

let legacyWarned = false;

function readFlag(raw: string | undefined): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/**
 * 合并层是否整体关闭。
 *
 * 每处调用都重新读 env（不缓存成模块常量）：测试会在同一个进程里改 env 验证
 * 开/关两条路径，缓存常量会让第二条用例读到第一次的值。
 */
export function isSepiaDisabled(): boolean {
  if (readFlag(process.env.SEPIA_DISABLED)) return true;
  const legacy = process.env.SEPIA_GATE_DISABLED;
  if (!readFlag(legacy)) return false;
  if (!legacyWarned) {
    legacyWarned = true;
    console.warn(
      "[sepia] SEPIA_GATE_DISABLED 是旧名，现在会关掉整套 sepia 功能；新配置请改用 SEPIA_DISABLED。",
    );
  }
  return true;
}

/** 仅供测试：重置"旧名已提示"标记 */
export function resetSepiaFlagWarningForTest(): void {
  legacyWarned = false;
}
