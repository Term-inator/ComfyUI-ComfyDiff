import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasReview } from "../web/canvas.js";
import { compare, snapshot } from "../web/diff.js";

function canvasApp(workflow) {
  const nodes = workflow.nodes.map((node) => ({
    ...node,
    widgets: Object.keys(node.widgets_values_named ?? {}).map((name) => ({
      name,
      get value() { return node.widgets_values_named[name]; },
    })),
  }));
  const rootGraph = {
    state: {},
    nodes,
    subgraphs: new Map(),
    getNodeById: (id) => nodes.find((node) => String(node.id) === id),
    serialize: () => workflow,
  };
  const surface = Object.assign(new EventTarget(), { closest: () => null });
  return {
    rootGraph, rootGraphOrUndefined: rootGraph,
    canvas: { graph: rootGraph, canvas: surface, ds: { scale: 1 }, setDirty() {} },
    extensionManager: {
      setting: { get: () => false }, workflow: { activeWorkflow: { activeState: structuredClone(workflow) } },
    },
  };
}

test("a removed subgraph can be previewed after its entry is replaced at the same ID", () => {
  const branch = "detail-graph";
  const before = snapshot({
    nodes: [{ id: 1, type: branch }],
    definitions: { subgraphs: [{ id: branch, nodes: [{ id: 7, type: "SaveImage" }] }] },
  });
  const edited = { nodes: [{ id: 1, type: "PreviewImage" }] };
  const after = snapshot(edited);
  const change = compare(before, after).find(({ graph }) => graph === branch);

  const review = new CanvasReview(canvasApp(edited));
  const preview = review.prepare(change, { before, after });
  assert.equal(preview.ghost.type, branch);
  assert.equal(preview.removedBranch.at(-1).graph, branch);
  assert.deepEqual(preview.focus, { node: "7" });

  const stale = new CanvasReview(canvasApp({ nodes: [{ id: 1, type: branch }] }));
  assert.throws(() => stale.prepare(change, { before, after }), /入口与比较结果不同/);
});

test("the selected highlight follows a widget edit before the workflow tracker captures it", () => {
  const workflow = (steps) => ({ nodes: [{ id: 1, type: "Sampler", widgets_values_named: { steps } }] });
  const before = snapshot(workflow(20));
  const edited = workflow(28);
  const after = snapshot(edited);
  const [change] = compare(before, after);
  const app = canvasApp(edited);
  const normalDraw = () => {};
  app.canvas.onDrawForeground = normalDraw;
  const review = new CanvasReview(app);
  review.highlight(change, { before, after });
  assert.notEqual(app.canvas.onDrawForeground, normalDraw);

  edited.nodes[0].widgets_values_named.steps = 32;
  review.syncHighlight();
  assert.equal(app.canvas.onDrawForeground, normalDraw);

  edited.nodes[0].widgets_values_named.steps = 28;
  review.syncHighlight();
  assert.notEqual(app.canvas.onDrawForeground, normalDraw);
  review.clear();
});
