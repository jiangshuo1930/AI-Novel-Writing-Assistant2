-- sepia 生成前门：书级开关（null = 默认 write 模式拦截；off=不拦；all=所有模式都拦）
ALTER TABLE "Novel" ADD COLUMN "sepiaBlueprintGate" TEXT;
