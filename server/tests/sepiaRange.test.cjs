/**
 * sepia 报告项 → 字符区间 的换算测试
 *
 * 只测纯函数，不碰编辑器。重点锁三件事：
 *   1. quote 找不到时返回 null，不许就地猜；
 *   2. 行号 1 起、越界返回 null；
 *   3. quote + line 同时给时，优先取该行内的那次出现。
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { lineStartOffsets, rangeOfLine, resolveSepiaRange } = require(
  path.resolve(__dirname, "..", "..", "shared", "dist", "utils", "sepiaRange.js"),
);

test("lineStartOffsets 按 \\n 切且含首行 0", () => {
  assert.deepEqual(lineStartOffsets("ab\ncd\n\nef"), [0, 3, 6, 7]);
  assert.deepEqual(lineStartOffsets(""), [0]);
});

test("rangeOfLine 是 1 起且不含换行", () => {
  const text = "第一行\n第二行\n第三行";
  assert.deepEqual(rangeOfLine(text, 1), { from: 0, to: 3 });
  assert.deepEqual(rangeOfLine(text, 2), { from: 4, to: 7 });
  const last = rangeOfLine(text, 3);
  assert.equal(text.slice(last.from, last.to), "第三行");
});

test("rangeOfLine 越界与空行返回 null", () => {
  assert.equal(rangeOfLine("只有一行", 2), null);
  assert.equal(rangeOfLine("只有一行", 0), null);
  assert.equal(rangeOfLine("只有一行", 1.5), null);
  assert.equal(rangeOfLine("a\n\nb", 2), null);
});

test("rangeOfLine 去掉行尾 \\r", () => {
  const text = "abc\r\ndef";
  const range = rangeOfLine(text, 1);
  assert.equal(text.slice(range.from, range.to), "abc");
});

test("quote 命中返回首次出现", () => {
  const text = "他忽然停下忽然又走";
  const range = resolveSepiaRange(text, { quote: "忽然" });
  assert.equal(range.from, 1);
  assert.equal(text.slice(range.from, range.to), "忽然");
});

test("quote 找不到返回 null，不做模糊匹配", () => {
  assert.equal(resolveSepiaRange("他忽然停下", { quote: "突然" }), null);
  assert.equal(resolveSepiaRange("他忽然停下", { quote: "忽" }), null);
  assert.equal(resolveSepiaRange("他忽然停下", { quote: "" }), null);
});

test("只有行号时定位整行", () => {
  const text = "第一行\n第二行有破折号——这里\n第三行";
  const range = resolveSepiaRange(text, { line: 2 });
  assert.equal(text.slice(range.from, range.to), "第二行有破折号——这里");
});

test("quote + line 同时给：优先取该行内的那次出现", () => {
  const text = "忽然有一次\n中间段落\n这一行也有忽然";
  const range = resolveSepiaRange(text, { quote: "忽然", line: 3 });
  assert.equal(range.from, text.lastIndexOf("忽然"));
});

test("quote + line 但该行内没有 quote：退回首次出现", () => {
  const text = "忽然有一次\n中间段落\n这一行没有";
  const range = resolveSepiaRange(text, { quote: "忽然", line: 3 });
  assert.equal(range.from, 0);
});

test("行号越界但有 quote：仍按 quote 定位", () => {
  const text = "忽然有一次";
  const range = resolveSepiaRange(text, { quote: "忽然", line: 99 });
  assert.deepEqual(range, { from: 0, to: 2 });
});

test("什么都没给返回 null", () => {
  assert.equal(resolveSepiaRange("任意正文", {}), null);
  assert.equal(resolveSepiaRange("任意正文", { quote: "  ", line: null }), null);
});
