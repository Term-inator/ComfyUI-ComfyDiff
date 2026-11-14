import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, snapshot, validateChange } from "../web/diff.js";

const source = {
  id: 1, type: "TextSource", outputs: [{ name: "TEXT" }], widgets_values_named: { text: "旧文本" },
};
const port = (name, link) => ({ name, widget: { name }, link });
const graph = (input, links = [], upstream = source) => snapshot({ nodes: [upstream, input], links });
const firstLink = [7, 1, 0, 2, 0, "STRING"];
const secondLink = [8, 1, 0, 2, 1, "STRING"];

test("two local inputs becoming wires produce one change per destination", () => {
  const node = { id: 2, type: "TwoTexts", widgets_values: ["一", "二"] };
  const before = graph(node);
  const after = graph({
    ...node, inputs: [port("first", 7), port("second", 8)], widgets_values: [],
  }, [firstLink, secondLink]);

  const rows = compare(before, after, (_graph, expected) =>
    expected.raw.widgets_values?.length === 2 ? ["first", "second"] : null);
  assert.deepEqual(rows.map(({ field, from, to }) => [field, from?.value, to?.kind]), [
    ["first", "一", "link"], ["second", "二", "link"],
  ]);
  assert.deepEqual(rows.map((row) => validateChange(row, after.graphs.get("")).source.port.index), [0, 1]);
});

test("a changed saved copy of a wired input does not hide a real local edit", () => {
  const node = {
    id: 2, type: "TwoTexts", inputs: [port("first", 7), port("second", null)],
    properties: { ver: "old" }, widgets_values: ["旧副本", "本地文本"],
  };
  const before = graph(node, [firstLink]);
  const after = graph({
    ...node, properties: { ver: "new" }, widgets_values: ["新副本", "本地修改"],
    widgets_values_named: { first: "新副本", second: "本地修改" },
  }, [firstLink], { ...source, widgets_values_named: { text: "新文本" } });

  const rows = compare(before, after);
  assert.deepEqual(rows.map(({ node, field, to }) => [node, field, to.value]), [
    ["1", "text", "新文本"], ["2", "second", "本地修改"],
  ]);
  const downstream = after.graphs.get("").nodes.get("2").raw;
  const unchangedLocal = graph({
    ...downstream, widgets_values: ["新副本", "本地文本"],
    widgets_values_named: { first: "新副本", second: "本地文本" },
  }, [firstLink], { ...source, widgets_values_named: { text: "新文本" } });
  assert.deepEqual(compare(before, unchangedLocal).map(({ node, field }) => [node, field]), [["1", "text"]]);
});

test("String Function compares input sources and omits saved execution output", () => {
  const node = {
    id: 2, type: "StringFunction|pysssss",
    inputs: [port("text_a", 7), port("text_b", 8), port("text_c", null)],
    widgets_values: ["append", "yes", "旧副本", "旧备用", "本地文本"],
  };
  const before = graph(node, [firstLink, secondLink]);
  const after = graph({
    ...node, inputs: [port("text_a", 7), port("text_b", null), port("text_c", null)],
    widgets_values: ["append", "yes", "新副本", "新备用", "本地文本", "运行结果"],
  }, [firstLink]);

  const rows = compare(before, after);
  assert.deepEqual(rows.map(({ field, from, to }) => [field, from.kind, to.value]), [
    ["text_b", "link", "新备用"],
  ]);
  const named = graph({
    ...after.graphs.get("").nodes.get("2").raw,
    widgets_values_named: {
      action: "append", tidy_tags: "yes", text_a: "新副本", text_b: "新备用", text_c: "本地文本",
      result: "另一份运行结果",
    },
  }, [firstLink]);
  assert.deepEqual(compare(after, named), []);
});
