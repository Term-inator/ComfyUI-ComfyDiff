import { parseWorkflow } from "./diff.js";

export class WorkspaceFiles {
  constructor(app, request, user) {
    this.app = app;
    this.request = request;
    this.user = user;
    this.opened = new Map();
    this.bindings = new Map();
  }

  get store() { return this.app.extensionManager.workflow; }

  key(workflow, workspace) {
    return JSON.stringify([this.user(), workspace, workflow?.instanceId]);
  }

  origin(workflow) {
    const entry = this.opened.get(workflow?.instanceId);
    return workflow?.isTemporary && entry && entry.user === this.user() && entry.path === workflow.path ? entry : null;
  }

  managed(workflow, workspace) {
    const entry = this.origin(workflow);
    return entry?.workspace === workspace ? entry : null;
  }

  association(workflow, workspace) {
    const entry = this.managed(workflow, workspace);
    return entry ? { file: entry.file, source: "workspace" } :
      this.bindings.get(this.key(workflow, workspace));
  }

  bind(workflow, workspace, file) {
    this.bindings.set(this.key(workflow, workspace), { file, source: "binding" });
  }

  baseline(workflow) {
    // The frontend resets its change tracker during tab activation. The
    // workflow's original content still holds the loaded or saved version.
    return workflow?.originalContent ? parseWorkflow(workflow.originalContent, "打开或保存时") : workflow?.initialState;
  }

  async activate(workflow, current) {
    if (!workflow) throw new Error("ComfyUI 中找不到该工作流。");
    if (!current()) return false;
    if (this.store.activeWorkflow?.instanceId === workflow.instanceId) return true;
    const loaded = workflow.isLoaded;
    if (!loaded) await workflow.load();
    if (!current()) return false;

    const { changeTracker: tracker, initialState, originalContent, isModified } = workflow;
    const data = JSON.parse(JSON.stringify(workflow.activeState));
    const opened = await this.app.loadGraphData(data, true, true, workflow, {
      checkForRerouteMigration: false,
      skipAssetScans: loaded,
    });
    if (loaded && workflow.changeTracker === tracker && tracker && workflow.originalContent === originalContent) {
      tracker.initialState = initialState;
      workflow.isModified = isModified;
    }
    return !!opened && this.store.activeWorkflow?.instanceId === workflow.instanceId;
  }

  async open(workspace, file, current) {
    const tabs = this.store.openWorkflows;
    const existing = tabs.find((workflow) => this.managed(workflow, workspace)?.file === file);
    if (existing) return this.activate(existing, current);
    const data = await this.request("file", {
      workspace, file, open: tabs.filter((workflow) => !workflow.isTemporary).map(({ path }) => path),
    });
    if (!current()) return false;
    const path = "workflows/" + file;
    if (!data.native || data.native === path) {
      const imported = this.store.openWorkflows.find((workflow) =>
        workflow.isTemporary && workflow.path === path && !this.origin(workflow) &&
        (this.bindings.get(this.key(workflow, workspace))?.file ?? file) === file);
      if (imported) return this.activate(imported, current);
    }

    if (data.native) {
      let workflow = this.store.getWorkflowByPath(data.native);
      if (!workflow) {
        const directory = data.native.slice("workflows/".length).split("/").slice(0, -1).join("/");
        await this.store.syncWorkflows(directory);
        workflow = this.store.getWorkflowByPath(data.native);
      }
      if (workflow?.isTemporary) throw new Error("同路径的临时工作流已打开。请先保存或关闭该标签页。");
      return this.activate(workflow, current);
    }

    const workflow = this.store.createNewTemporary(file, parseWorkflow(data.content, "已保存文件"));
    const { instanceId, path: tabPath } = workflow;
    this.opened.set(instanceId, { user: this.user(), workspace, file, path: tabPath, version: data.version });
    try {
      return await this.activate(workflow, current);
    } finally {
      if (!this.store.openWorkflows.some((tab) => tab.instanceId === instanceId)) this.opened.delete(instanceId);
    }
  }

  async save(workflow, workspace) {
    const entry = this.managed(workflow, workspace);
    const tracker = workflow?.changeTracker;
    if (!entry || !tracker || this.store.activeWorkflow?.instanceId !== workflow.instanceId) {
      throw new Error("请选择要保存的仓库工作流。");
    }
    tracker.prepareForSave();
    const content = JSON.stringify(workflow.activeState);
    const result = await this.request("save", {}, { workspace, file: entry.file, expected: entry.version, content });
    entry.version = result.version;
    workflow.originalContent = content;
    if (workflow.changeTracker === tracker) {
      // Keep edits made while the request was in flight.
      tracker.prepareForSave();
      tracker.initialState = JSON.parse(content);
      workflow.isModified = JSON.stringify(workflow.activeState) !== content;
    }
  }

  adoptDisk(workflow, workspace, version) {
    const entry = this.managed(workflow, workspace);
    if (entry) entry.version = version;
  }
}
