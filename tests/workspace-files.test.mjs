import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceFiles } from "../web/workspace-files.js";

const graph = (width) => ({ nodes: [{ id: 1, type: "EmptyLatentImage", widgets_values: [width] }] });

function temporary(file, saved, width = saved) {
  return {
    path: "workflows/" + file,
    instanceId: file,
    isTemporary: true,
    isLoaded: true,
    isModified: width !== saved,
    originalContent: JSON.stringify(graph(saved)),
    activeState: graph(width),
    initialState: graph(saved),
    changeTracker: {},
  };
}

function fixture(tabs, active = tabs[0]) {
  const store = {
    openWorkflows: [...tabs],
    activeWorkflow: active,
    createNewTemporary(file, data) {
      const path = "workflows/" + file;
      const used = this.openWorkflows.some((tab) => tab.path === path);
      return temporary(used ? file.replace(/\.json$/, " (2).json") : file, data.nodes[0].widgets_values[0]);
    },
  };
  let canvas;
  const app = {
    extensionManager: { workflow: store },
    async loadGraphData(data, clean, restoreView, workflow) {
      canvas = data;
      if (!store.openWorkflows.includes(workflow)) store.openWorkflows.push(workflow);
      store.activeWorkflow = workflow;
      return true;
    },
  };
  const request = async () => ({ native: null, version: "disk-version", content: JSON.stringify(graph(640)) });
  return { files: new WorkspaceFiles(app, request, () => "test-user"), store, canvas: () => canvas };
}

test("opening a repository workflow activates an existing imported tab with its unsaved canvas", async () => {
  const imported = temporary("portrait.json", 640, 704);
  const other = temporary("other.json", 512);
  const { files, store, canvas } = fixture([imported, other], other);

  assert.equal(await files.open("/repo", "portrait.json", () => true), true);
  assert.deepEqual(store.openWorkflows, [imported, other]);
  assert.equal(store.activeWorkflow, imported);
  assert.deepEqual(canvas(), graph(704));
  assert.equal(imported.isModified, true);
});

test("a workflow opened from a different repository keeps its original association", async () => {
  const { files, store } = fixture([]);
  await files.open("/first", "portrait.json", () => true);
  const first = store.activeWorkflow;
  await files.open("/second", "portrait.json", () => true);
  const second = store.activeWorkflow;

  assert.notEqual(first, second);
  assert.equal(files.managed(first, "/first").file, "portrait.json");
  assert.equal(files.managed(second, "/second").file, "portrait.json");
  await files.open("/second", "portrait.json", () => true);
  assert.equal(store.activeWorkflow, second);
  assert.equal(store.openWorkflows.length, 2);
});

test("a different relative path is a different workflow even if the filename matches", async () => {
  const imported = temporary("portrait.json", 640, 704);
  const { files, store } = fixture([imported]);
  await files.open("/repo", "variants/portrait.json", () => true);

  assert.notEqual(store.activeWorkflow, imported);
  assert.equal(store.activeWorkflow.path, "workflows/variants/portrait.json");
  assert.equal(store.openWorkflows.length, 2);
});
