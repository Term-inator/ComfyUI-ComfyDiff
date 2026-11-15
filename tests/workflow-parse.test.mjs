import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflow } from "../web/diff.js";

test("invalid workflow structures report the side that could not be read", () => {
  const invalid = [
    '{"nodes":[null]}',
    '{"nodes":[{}]}',
    '{"nodes":[],"links":{}}',
    '{"nodes":[],"definitions":{"subgraphs":[null]}}',
  ];
  for (const source of ["HEAD", "工作区"]) {
    for (const text of invalid) {
      assert.throws(() => parseWorkflow(text, source), new RegExp(`${source}的文件不是有效`));
    }
  }
});

test("a workflow may omit slot metadata and use object links in subgraphs", () => {
  const workflow = {
    nodes: [{ id: 1, type: "subgraph" }],
    definitions: {
      subgraphs: [{
        id: "subgraph", nodes: [{ id: 2, type: "TextSource" }, { id: 3, type: "TextConsumer" }],
        links: [{ id: 4, origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0, type: "STRING" }],
      }],
    },
  };
  assert.deepEqual(parseWorkflow(JSON.stringify(workflow), "HEAD"), workflow);
});
