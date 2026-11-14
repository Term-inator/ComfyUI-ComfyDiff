import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { compare, equal, nodeLabel, nodeProvider, parseWorkflow, ROOT, snapshot, sourceLabel, widgetSlots } from "./diff.js";
import { CanvasReview, liveSnapshot, namesOnCanvas } from "./canvas.js";
import { element } from "./graph-view.js";

const TAB = "comfydiff";
const fileByInstance = new Map();
const nodeModules = new Map();
const pathLabel = (path) => ["主图", ...path.map((step) => `${step.name} #${step.id}`)].join(" › ");
const errorText = (error) => error instanceof Error ? error.message : String(error);
const modeNames = new Map([[0, "始终"], [1, "事件时"], [2, "停用"], [3, "触发时"], [4, "旁路"]]);

async function request(operation, params = {}, body) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null));
  const response = await api.fetchApi(`/comfydiff/${operation}?${query}`, body ? {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "ComfyDiff 请求失败。");
  return data;
}

function button(label, action, className) {
  const control = element("button", className, label);
  control.type = "button";
  control.onclick = action;
  return control;
}

function formDialog(title, label, input, confirm, action) {
  const dialog = element("dialog", "comfydiff-form");
  const heading = element("h3", "", title);
  dialog.setAttribute("aria-label", title);
  const form = element("form");
  const field = element("label", "", label);
  field.append(input);
  const actions = element("div", "cd-actions");
  const submit = element("button", "cd-primary", confirm);
  submit.type = "submit";
  actions.append(button("取消", () => dialog.close()), submit);
  const status = element("p", "cd-error");
  status.setAttribute("role", "alert");
  form.append(field, status, actions);
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = "";
    try {
      await action(input.value);
      dialog.close();
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      submit.disabled = false;
    }
  };
  dialog.append(heading, form);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function display(value) {
  return typeof value === "string" ? value : value === undefined ? "无" : JSON.stringify(value);
}

function sourceText(source, missing = "未连接") {
  if (!source) return missing;
  if (source.kind === "link") return sourceLabel(source.edge);
  if (source.kind === "exposed") return "已暴露，未连接";
  return display(source.value);
}

function description(change, result) {
  const { kind, from, to, before, after } = change;
  const node = nodeLabel(after ?? before, after ? result.after : result.before);
  if (kind === "added") return { label: "＋ 新增节点", color: "green", node };
  if (kind === "deleted") return { label: "− 删除节点", color: "red", node };
  if (kind === "replaced") return { label: "替换", node, a: before.type, b: after.type };
  if (kind === "mode") return { label: "运行模式", node, a: modeNames.get(from) ?? from, b: modeNames.get(to) ?? to };
  if (kind === "boundary") return {
    label: "子图端口", node,
    a: from ? `${from.label || from.name} · ${display(from.type)}` : "无",
    b: to ? `${to.label || to.name} · ${display(to.type)}` : "无",
  };
  const label = kind === "parameter" ? "参数" :
    from?.kind === "value" || to?.kind === "value" ? "来源变化" : "接线";
  const missing = kind === "parameter" ? "无" : "未连接";
  return { label, node: `${node} · ${change.field}`, a: sourceText(from, missing), b: sourceText(to, missing) };
}

function deletedDetails(change, result, canOpen, onOpen) {
  const graph = result.before.graphs.get(change.graph);
  const node = change.before;
  const details = element("details", "cd-details");
  details.append(element("summary", "", "旧节点详情"));
  const body = element("ul");
  body.append(element("li", "", `运行模式 ${modeNames.get(node.mode) ?? node.mode}`));
  let index = 0;
  for (const value of widgetSlots(node).values()) {
    body.append(element("li", "", `${value.name || `参数 ${index + 1}`}  ${display(value.value)}`));
    index++;
  }
  for (const edge of graph.incident.get(node.id) ?? []) {
    const target = `${nodeLabel(edge.target, result.before)}.${edge.port.name ?? `输入 ${edge.port.index + 1}`}`;
    body.append(element("li", "", `${sourceLabel(edge)} → ${target}`));
  }
  details.append(body);
  if (canOpen) details.append(button("查看已删除子图", onOpen));
  return details;
}

class Sidebar {
  constructor(root) {
    this.root = root;
    this.canvas = new CanvasReview(app, root);
    this.mode = "disk";
    this.config = {};
    this.sequence = 0;
    this.reading = false;
    this.nextRead = 0;

    const heading = element("header", "cd-header");
    heading.append(element("h2", "", "工作流差异"), button("设置", () => this.settings()));
    const paths = element("div", "cd-path");
    this.path = element("span", "", "正在读取 Git 工作区…");
    this.bindButton = button("选择对应文件", () => this.safe(() => this.chooseFile(false)));
    paths.append(this.path, this.bindButton);
    const sources = element("div", "cd-sources");
    this.diskButton = button("对比磁盘文件", () => this.setMode("disk"));
    this.canvasButton = button("对比当前画布", () => this.setMode("canvas"));
    const actions = element("div", "cd-actions");
    this.openButton = button("打开仓库文件", () => this.safe(() => this.chooseFile(true)));
    this.refreshButton = button("刷新", () => this.refresh());
    actions.append(this.openButton, this.refreshButton);
    sources.append(this.diskButton, this.canvasButton);
    this.provenance = element("p", "cd-provenance");
    this.status = element("p", "cd-status");
    this.status.setAttribute("role", "status");
    this.reloadButton = button("在当前标签页载入磁盘版本", () => this.safe(() => this.reloadDisk()));
    this.reloadButton.hidden = true;
    this.items = element("div", "cd-items");
    root.replaceChildren(heading, paths, sources, actions, this.provenance, this.status, this.reloadButton, this.items);
    this.render();
  }

  get workflow() { return app.extensionManager.workflow.activeWorkflow; }
  get supported() { return app.extensionManager.setting.get("Comfy.VueNodes.Enabled") === true; }
  get visible() { return this.root.isConnected && app.extensionManager.sidebarTab.activeSidebarTabId === TAB; }

  get file() {
    const inSession = fileByInstance.get(this.workflow?.instanceId)?.get(this.config.workspace);
    return this.config.automatic ? this.config.file : inSession ?? this.config.file;
  }

  remember(workflow, file, workspace = this.config.workspace) {
    if (!fileByInstance.has(workflow.instanceId)) fileByInstance.set(workflow.instanceId, new Map());
    fileByInstance.get(workflow.instanceId).set(workspace, file);
  }

  currentContext() {
    const workflow = this.workflow;
    const root = app.rootGraphOrUndefined;
    return [
      this.sequence, api.user, workflow?.instanceId, workflow?.path, workflow?.isTemporary,
      root, root?.state,
    ];
  }

  current(context) {
    const latest = this.currentContext();
    return this.visible && this.supported && latest.every((value, index) => value === context[index]);
  }

  async safe(action) {
    try {
      await action();
    } catch (error) {
      this.message(errorText(error), true);
    }
  }

  message(value, error = false) {
    this.status.textContent = value;
    this.status.classList.toggle("cd-error", error);
  }

  reset() {
    this.sequence++;
    this.canvas.clear();
    this.result = null;
    this.selected = null;
    this.reloadButton.hidden = true;
    this.items.replaceChildren();
    this.provenance.textContent = "";
  }

  tick() {
    if (!this.visible) {
      if (this.wasVisible) this.reset();
      this.wasVisible = false;
      return;
    }
    const workflow = this.workflow;
    const stamp = [this.supported, api.user, workflow?.instanceId, workflow?.path, workflow?.isTemporary];
    if (!this.wasVisible || !equal(stamp, this.stamp) || this.graph !== app.rootGraphOrUndefined) {
      this.wasVisible = true;
      this.stamp = stamp;
      this.graph = app.rootGraphOrUndefined;
      this.refresh();
    } else if (this.mode === "disk" && this.file && !this.reading && Date.now() >= this.nextRead) {
      this.read(false);
    }
  }

  setMode(mode) {
    if (this.mode === mode && mode === "disk") return;
    this.mode = mode;
    this.refresh();
  }

  refresh() {
    this.reset();
    return this.read(true);
  }

  async read(force) {
    const workflow = this.workflow;
    const root = app.rootGraphOrUndefined;
    const context = this.currentContext();
    const requestId = Symbol();
    this.readId = requestId;
    this.reading = true;
    this.nextRead = Date.now() + 2500;
    if (force) this.message("正在读取差异…");
    const stillCurrent = () => this.readId === requestId && this.current(context);
    try {
      if (!this.supported) {
        this.message("请在 ComfyUI 设置中启用 Nodes 2.0。");
        return;
      }
      const currentCanvas = this.mode === "canvas" && root ? liveSnapshot(app) : null;
      const config = await request("settings", { native: workflow?.isTemporary ? null : workflow?.path });
      if (!stillCurrent()) return;
      if (config.workspace !== this.config.workspace || config.file !== this.config.file) {
        this.canvas.clear();
        this.result = null;
        this.items.replaceChildren();
      }
      this.config = config;
      if (!config.workspace) {
        this.message("请在设置中填写 Git 工作区目录。");
        return;
      }
      if (!workflow || !root) {
        this.message("打开一个工作流后即可比较。");
        return;
      }
      const file = this.file;
      if (!file) {
        this.message("请选择当前标签页对应的仓库文件。");
        return;
      }
      const data = await request("compare", {
        workspace: config.workspace, file, mode: this.mode, known: this.result?.token,
      });
      if (!stillCurrent()) return;
      if (data.unchanged) return;
      const before = snapshot(data.before === null ? null : parseWorkflow(data.before, "HEAD"));
      const after = currentCanvas ?? snapshot(parseWorkflow(data.after, "工作区"));
      const changes = compare(before, after, (graph, node) => namesOnCanvas(app, graph, node));
      this.canvas.clear();
      this.reloadButton.hidden = true;
      this.result = { ...data, before, after, changes };
      this.selected = null;
      this.message(changes.length ? `${changes.length} 处差异` : "没有节点、参数或接线差异。");
      this.renderResults();
    } catch (error) {
      if (!stillCurrent()) return;
      this.canvas.clear();
      this.result = null;
      this.reloadButton.hidden = true;
      this.items.replaceChildren();
      this.message(errorText(error), true);
    } finally {
      if (this.readId === requestId) {
        this.reading = false;
        this.render();
      }
    }
  }

  render() {
    this.path.textContent = this.file || (this.config.workspace ? "尚未识别仓库文件" : "尚未设置 Git 工作区");
    this.bindButton.hidden = !this.config.workspace || this.config.automatic || !this.workflow || !this.supported;
    this.bindButton.textContent = this.file ? "更改对应文件" : "选择对应文件";
    this.openButton.disabled = !this.config.workspace || !this.supported;
    this.refreshButton.disabled = !this.supported;
    this.diskButton.disabled = this.canvasButton.disabled = !this.file || !this.supported;
    this.diskButton.setAttribute("aria-pressed", String(this.mode === "disk"));
    this.canvasButton.setAttribute("aria-pressed", String(this.mode === "canvas"));
    const head = this.result?.head.slice(0, 7);
    const source = this.mode === "disk" ? "工作区 · 磁盘 JSON" : "当前画布 · 快照";
    this.provenance.textContent = head ? `HEAD ${head} ↔ ${source}${this.result.before.graphs.size ? "" : " · 新文件"}` : "";
  }

  settings() {
    const input = element("input");
    input.required = true;
    input.value = this.config.workspace || "";
    input.placeholder = "/srv/ComfyUI/my_workflows";
    formDialog("工作流差异设置", "Git 工作区绝对路径", input, "保存", async (workspace) => {
      await request("settings", {}, { workspace: workspace.trim() });
      await this.refresh();
    });
  }

  async chooseFile(open) {
    const workspace = this.config.workspace;
    const workflow = this.workflow;
    const instance = workflow?.instanceId;
    const native = workflow?.path;
    const files = await request("files", { workspace });
    if (!this.visible || workspace !== this.config.workspace || instance !== this.workflow?.instanceId) return;
    if (!files.length) throw new Error("工作区没有可选择的 JSON 文件。");
    const select = element("select");
    for (const file of files) {
      const option = element("option", "", file);
      option.value = file;
      select.append(option);
    }
    if (files.includes(this.file)) select.value = this.file;
    formDialog(open ? "打开仓库文件" : "选择对应的仓库文件", "仓库相对路径", select,
      open ? "打开" : "确认", async (file) => {
        if (workspace !== this.config.workspace || (!open && instance !== this.workflow?.instanceId)) {
          throw new Error("工作区或标签页已切换，请重新选择。");
        }
        if (open) {
          const { content } = await request("file", { workspace, file });
          if (workspace !== this.config.workspace || instance !== this.workflow?.instanceId) {
            throw new Error("工作区或标签页已切换，请重新选择。");
          }
          const data = parseWorkflow(content, "工作区");
          const opened = app.extensionManager.workflow.createNewTemporary(file, data);
          this.remember(opened, file, workspace);
          const loaded = await app.loadGraphData(data, true, true, opened);
          if (!loaded || this.workflow?.instanceId !== opened.instanceId) {
            throw new Error("ComfyUI 未能打开工作流。");
          }
        } else if (workflow.isTemporary) {
          this.remember(workflow, file, workspace);
        } else {
          await request("binding", {}, { workspace, file, native });
          fileByInstance.get(instance)?.delete(workspace);
        }
        await this.refresh();
      });
  }

  async reloadDisk() {
    const workflow = this.workflow;
    const context = this.currentContext();
    if (workflow?.isModified) throw new Error("当前画布有未保存编辑，可切换到「对比当前画布」。");
    const { content } = await request("file", { workspace: this.config.workspace, file: this.file });
    if (!this.current(context)) return;
    if (workflow.isModified) throw new Error("当前画布有未保存编辑，可切换到「对比当前画布」。");
    this.canvas.clear();
    const loaded = await app.loadGraphData(parseWorkflow(content, "工作区"), true, true, workflow);
    if (!loaded) throw new Error("ComfyUI 未能载入磁盘版本。");
    await this.refresh();
  }

  renderResults() {
    const result = this.result;
    const groups = new Map();
    this.items.replaceChildren();
    for (const change of result.changes) {
      if (!groups.has(change.graph)) {
        const group = element("section", "cd-group");
        const path = result.after.paths.get(change.graph) ?? result.before.paths.get(change.graph) ?? [];
        group.append(element("h3", "", pathLabel(path)));
        groups.set(change.graph, group);
        this.items.append(group);
      }
      const row = description(change, result);
      const container = element("div", "cd-entry");
      const select = button("", () => this.locate(change, result, select), "cd-change");
      select.setAttribute("aria-pressed", "false");
      select.append(element("span", `cd-kind ${row.color ? `cd-${row.color}` : ""}`, row.label));
      select.append(element("strong", "", row.node));
      const node = change.after ?? change.before;
      const provider = nodeProvider(node, nodeModules.get(node.type));
      if (provider) select.append(element("span", "cd-node-provider", provider));
      if (row.a !== undefined || row.b !== undefined) {
        select.append(element("span", "cd-old", `− ${row.a}`), element("span", "cd-new", `＋ ${row.b}`));
      }
      container.append(select);
      if (change.kind === "deleted") {
        const canOpen = result.before.graphs.has(change.before.type) ||
          (change.graph !== ROOT && !result.after.paths.has(change.graph));
        container.append(deletedDetails(change, result, canOpen, () => this.locate(change, result, select, true)));
      }
      groups.get(change.graph).append(container);
    }
  }

  async locate(change, result, control, openOld) {
    if (this.result !== result || !this.visible) return;
    const context = this.currentContext();
    const click = Symbol();
    this.click = click;
    this.selected?.setAttribute("aria-pressed", "false");
    this.selected = null;
    this.reloadButton.hidden = true;
    try {
      const focused = await this.canvas.locate(change, result, openOld);
      if (this.click !== click || !this.current(context) || this.result !== result) return;
      if (!focused) return;
      control.setAttribute("aria-pressed", "true");
      this.selected = control;
      this.message(`${result.changes.length} 处差异`);
    } catch (error) {
      if (this.click !== click || !this.current(context) || this.result !== result) return;
      this.message(errorText(error), true);
      this.reloadButton.hidden = this.mode !== "disk" || !!this.workflow?.isModified;
    }
  }
}

app.registerExtension({
  name: "ComfyDiff.Workflows",
  beforeRegisterVueAppNodeDefs(definitions) {
    nodeModules.clear();
    for (const { name, python_module: module } of definitions) nodeModules.set(name, module);
  },
  setup() {
    const style = element("link");
    style.rel = "stylesheet";
    style.href = new URL("./comfydiff.css", import.meta.url).href;
    document.head.append(style);
    let sidebar;
    app.extensionManager.registerSidebarTab({
      id: TAB,
      icon: "pi pi-code",
      title: "工作流差异",
      tooltip: "比较工作流与 Git 提交",
      type: "custom",
      render(container) {
        const root = sidebar?.root ?? element("div", "comfydiff");
        container.append(root);
        sidebar ??= new Sidebar(root);
        sidebar.tick();
      },
      destroy() {
        sidebar?.reset();
        if (sidebar) sidebar.wasVisible = false;
      },
    });
    setInterval(() => sidebar?.tick(), 300);
  },
});
