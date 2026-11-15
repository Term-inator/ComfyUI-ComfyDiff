import assert from "node:assert/strict";
import { test } from "node:test";
import { collectIssues } from "../web/issues.js";

const graph = (nodes) => ({ getNodeById: (id) => nodes.find((node) => node.id === id) });
const model = (nodeId, widgetName, name, directory = "checkpoints") => ({
  nodeId, nodeType: "Loader", widgetName, name, directory, isMissing: true,
});

test("groups missing models by category and path, counting both subgraph instances once each", () => {
  const subgraph = graph([{ id: "7", type: "Loader" }]);
  const root = graph([{ id: "1", subgraph }, { id: "2", subgraph }]);
  const pendingWarnings = { missingModelCandidates: [
    model("1:7", "primary", "portrait\\shared.safetensors"),
    model("1:7", "secondary", "portrait/shared.safetensors"),
    model("2:7", "model", "portrait/shared.safetensors"),
    model("2:7", "lora", "portrait/shared.safetensors", "loras"),
    model("2:7", "other", "landscape/shared.safetensors"),
  ] };

  const issues = collectIssues({ pendingWarnings }, root, {});
  assert.equal(issues.length, 3);
  assert.deepEqual(issues[0].targets.map(({ id, details, canLocate }) => [id, details, canLocate]), [
    ["1:7", ["primary", "secondary"], true],
    ["2:7", ["model"], true],
  ]);
  assert.equal(issues[1].directory, "loras");
  assert.equal(issues[2].message, "landscape/shared.safetensors");
});

test("preserves individual node references when grouping the same missing type", () => {
  const root = graph([{ id: "4", type: "Tuple" }, { id: "5", type: "Tuple", title: "Input tuple" },
    { id: "6", type: "Tuple", mode: 4 }]);
  const pendingWarnings = { missingNodeTypes: [
    { type: "Tuple", nodeId: 4, cnrId: "tuple-pack" },
    { type: "Tuple", nodeId: 5 },
    { type: "Tuple", nodeId: 6 },
    "Tuple",
    "UnknownExtension",
  ] };

  const issues = collectIssues({ pendingWarnings }, root, {});
  assert.deepEqual(issues.map(({ message }) => message), ["Tuple", "UnknownExtension"]);
  assert.deepEqual(issues[0].targets.map(({ id, node, canLocate }) => [id, node, canLocate]), [
    ["4", "Tuple", true],
    ["5", "Input tuple", true],
    ["", "Tuple", false],
  ]);
});
