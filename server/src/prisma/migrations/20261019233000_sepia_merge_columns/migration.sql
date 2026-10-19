-- sepia 并入：章节侧保存架构表 / 机械门状态 / 技法选择
ALTER TABLE "Chapter"
ADD COLUMN "sepiaBlueprintJson" TEXT,
ADD COLUMN "sepiaGateStatus" TEXT,
ADD COLUMN "sepiaTechKeysJson" TEXT;

-- sepia 并入：规则来源（null = 用户手写规则）
ALTER TABLE "AntiAiRule"
ADD COLUMN "packKey" TEXT,
ADD COLUMN "packVersion" TEXT,
ADD COLUMN "ruleGroup" TEXT;
