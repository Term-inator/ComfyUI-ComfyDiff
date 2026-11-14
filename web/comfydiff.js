import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { compare, equal, nodeLabel, parseWorkflow, ROOT, snapshot, sourceLabel, widgetSlots } from "./diff.js";
import { CanvasReview, liveSnapshot, namesOnCanvas } from "./canvas.js";
import { element } from "./graph-view.js";
import { NodeIdentity } from "./node-identity.js";

const TAB = "comfydiff";
const fileByInstance = new Map();
const nodeIdentity = new NodeIdentity();
const pathLabel = (path) => ["主图", ...path.map((step) => `${step.name} #${step.id}`)].join(" › ");
const errorText = (error) => error instanceof Error ? error.message : String(error);
const modeNames = new Map([[0, "始终"], [1, "事件时"], [2, "停用"], [3, "触发时"], [4, "旁路"]]);
const ALL_GRAPHS = "*";
const changeCategories = [
  { id: "all", label: "全部" },
  { id: "nodes", label: "节点", kinds: ["added", "deleted", "replaced"] },
  { id: "links", label: "接线", title: "接线与来源", kinds: ["input"] },
  { id: "fields", label: "参数", title: "参数与模式", kinds: ["parameter", "mode"] },
  { id: "ports", label: "端口", title: "子图端口", kinds: ["boundary"] },
];

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

function preview(value) {
  const text = String(value);
  const [first] = text.split("\n", 1);
  return first.length <= 54 && first === text ? first : `${first.slice(0, 54)}…`;
}

function description(change, result) {
  const { kind, from, to, before, after } = change;
  const node = nodeLabel(after ?? before, after ? result.after : result.before);
  if (kind === "added") return { label: "＋ 新增节点", color: "green", node };
  if (kind === "deleted") return { label: "− 删除节点", color: "red", node };
  if (kind === "replaced") return { label: "替换", node, a: before.type, b: after.type };
  if (kind === "mode") return { label: "运行模式", node, a: modeNames.get(from) ?? from, b: modeNames.get(to) ?? to };
  if (kind === "boundary") {
    const port = to ?? from;
    return {
      label: !from ? "新增端口" : !to ? "移除端口" : "端口变更",
      color: !from ? "green" : !to ? "red" : undefined,
      node: `${node} · ${port.label || port.name}`,
      a: from ? `${from.label || from.name} · ${display(from.type)}` : "无",
      b: to ? `${to.label || to.name} · ${display(to.type)}` : "无",
    };
  }
  let label = "参数";
  if (kind === "input") {
    if (from?.kind === "value" || to?.kind === "value") label = "来源变化";
    else if (from?.kind !== "link" && to?.kind === "link") label = "新增接线";
    else if (from?.kind === "link" && to?.kind !== "link") label = "移除接线";
    else if (from?.kind === "link" && to?.kind === "link") label = "改接线";
    else label = "端口来源";
  }
  const missing = kind === "parameter" ? "无" : "未连接";
  return { label, node: `${node} · ${change.field}`, a: sourceText(from, missing), b: sourceText(to, missing) };
}

function deletedDetails(change, result, canOpen, onOpen) {
  const graph = result.before.graphs.get(change.graph);
  const node = change.before;
  const details = element("div", "cd-details");
  details.append(element("strong", "", "旧节点详情"));
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
    this.category = "all";
    this.scope = ALL_GRAPHS;

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
    const controls = element("div", "cd-review-header");
    controls.append(heading, paths, this.provenance, sources, actions);
    this.results = element("section", "cd-results");
    this.results.hidden = true;
    this.scopeField = element("label", "cd-scope");
    this.scopeField.append(element("span", "", "图层范围"));
    this.scopePicker = element("select");
    this.scopePicker.onchange = () => {
      this.scope = this.scopePicker.value;
      this.clearSelection();
      this.renderResults();
    };
    this.scopeField.append(this.scopePicker);
    this.tabList = element("div", "cd-tabs");
    this.tabList.setAttribute("role", "tablist");
    this.tabList.setAttribute("aria-label", "差异类型");
    this.tabList.onkeydown = (event) => this.handleTabKey(event);
    const filters = element("div", "cd-filters");
    filters.append(this.scopeField, this.tabList);
    this.results.append(filters);
    this.tabs = changeCategories.map((category) => {
      const control = button("", () => this.activateCategory(category.id), "cd-tab");
      const count = element("span", "cd-tab-count");
      const panel = element("div", "cd-items");
      control.id = `cd-category-${category.id}`;
      control.title = category.title ?? category.label;
      control.setAttribute("role", "tab");
      panel.id = `cd-panel-${category.id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", control.id);
      control.setAttribute("aria-controls", panel.id);
      control.append(element("span", "", category.label), count);
      this.tabList.append(control);
      this.results.append(panel);
      return { ...category, control, count, panel };
    });
    root.replaceChildren(controls, this.status, this.reloadButton, this.results);
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

  showChangeCount() {
    const count = this.result.changes.length;
    this.message(count ? `${count} 处差异` : "没有节点、参数或接线差异。");
  }

  reset() {
    this.sequence++;
    this.clearSelection();
    this.result = null;
    this.clearResults();
    this.provenance.textContent = "";
  }

  clearResults() {
    this.providerLabels = [];
    this.results.hidden = true;
    for (const tab of this.tabs) tab.panel.replaceChildren();
  }

  clearSelection() {
    this.click = null;
    this.canvas.clear();
    if (this.selected) {
      const { control, details } = this.selected;
      control.setAttribute("aria-expanded", "false");
      details.replaceChildren();
      details.hidden = true;
    }
    this.selected = null;
    this.reloadButton.hidden = true;
    if (this.result) this.showChangeCount();
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
        this.clearSelection();
        this.result = null;
        this.clearResults();
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
      this.clearSelection();
      const filterContext = [api.user, workflow.instanceId, config.workspace, file];
      if (!equal(this.filterContext, filterContext)) {
        this.scope = ALL_GRAPHS;
        this.category = "all";
        this.filterContext = filterContext;
      }
      this.result = { ...data, before, after, changes };
      this.showChangeCount();
      this.renderScopes();
      this.renderResults();
      const result = this.result;
      if (nodeIdentity.needsIndex(changes)) {
        nodeIdentity.loadCandidates(api).then(() => {
          if (this.result === result && this.visible) this.updateProviders();
        });
      }
    } catch (error) {
      if (!stillCurrent()) return;
      this.clearSelection();
      this.result = null;
      this.clearResults();
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

  renderScopes() {
    const { before, after, changes } = this.result;
    const graphs = new Map([[ALL_GRAPHS, "全部图层"], [ROOT, "主图"]]);
    for (const { graph } of changes) {
      if (!graphs.has(graph)) graphs.set(graph, pathLabel(after.paths.get(graph) ?? before.paths.get(graph) ?? []));
    }
    if (!graphs.has(this.scope)) this.scope = ALL_GRAPHS;
    this.scopePicker.replaceChildren();
    for (const [value, label] of graphs) {
      const option = element("option", "", label);
      option.value = value;
      this.scopePicker.append(option);
    }
    this.scopePicker.value = this.scope;
    this.scopeField.hidden = graphs.size === 2 && this.scope === ALL_GRAPHS;
  }

  activateCategory(category, focus = false) {
    if (!this.result) return;
    if (this.category !== category) {
      this.category = category;
      this.clearSelection();
      this.renderResults();
    }
    if (focus) this.tabs.find((tab) => tab.id === this.category).control.focus();
  }

  handleTabKey(event) {
    const index = this.tabs.findIndex((tab) => tab.control === event.target);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const last = this.tabs.length - 1;
    let next;
    if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.activateCategory(this.tabs[next].id, true);
  }

  renderResults() {
    const result = this.result;
    const scoped = result.changes.filter((change) => this.scope === ALL_GRAPHS || change.graph === this.scope);
    const groups = new Map();
    this.providerLabels = [];
    this.results.hidden = !result.changes.length;
    let panel;
    let entries;
    for (const tab of this.tabs) {
      const matches = tab.kinds ? scoped.filter((change) => tab.kinds.includes(change.kind)) : scoped;
      const active = tab.id === this.category;
      tab.count.textContent = ` ${matches.length}`;
      tab.control.setAttribute("aria-selected", String(active));
      tab.control.tabIndex = active ? 0 : -1;
      tab.panel.hidden = !active;
      tab.panel.replaceChildren();
      if (active) {
        panel = tab.panel;
        entries = matches;
      }
    }
    if (!entries.length) {
      panel.tabIndex = 0;
      panel.append(element("p", "cd-empty", "此范围没有这类差异。"));
      return;
    }
    panel.removeAttribute("tabindex");
    for (const change of entries) {
      if (!groups.has(change.graph)) groups.set(change.graph, []);
      groups.get(change.graph).push(change);
    }
    for (const [graph, changes] of groups) {
      const group = element("section", "cd-group");
      const path = result.after.paths.get(graph) ?? result.before.paths.get(graph) ?? [];
      group.append(element("h3", "", pathLabel(path)));
      for (const change of changes) group.append(this.renderChange(change, result));
      panel.append(group);
    }
    this.updateProviders();
  }

  updateProviders() {
    for (const { node, label } of this.providerLabels) {
      const info = nodeIdentity.identify(node);
      label.hidden = !info;
      label.textContent = info?.label ?? "";
      label.title = [info?.detail, ...(info?.candidates ?? [])].filter(Boolean).join("\n");
    }
  }

  renderChange(change, result) {
    const row = description(change, result);
    const container = element("div", "cd-entry");
    const details = element("div", "cd-change-details");
    details.id = `cd-change-details-${this.providerLabels.length}`;
    details.hidden = true;
    const select = button("", () => {
      if (this.selected?.control === select) {
        this.clearSelection();
        return;
      }
      this.clearSelection();
      this.selected = { control: select, details };
      select.setAttribute("aria-expanded", "true");
      details.append(this.renderDetails(change, result, row));
      details.hidden = false;
      this.locate(change, result);
    }, "cd-change");
    select.setAttribute("aria-expanded", "false");
    select.setAttribute("aria-controls", details.id);
    const icon = element("span", `cd-change-symbol cd-${row.color ?? "yellow"}`,
      row.color === "green" ? "+" : row.color === "red" ? "−" : "↔");
    icon.setAttribute("aria-hidden", "true");
    select.append(icon, element("strong", "", row.node));
    const summary = change.kind === "mode" || change.kind === "parameter"
      ? `${row.label} · ${preview(row.a)} → ${preview(row.b)}` : row.label;
    select.append(element("span", "cd-kind", summary));
    const label = element("span", "cd-node-provider");
    this.providerLabels.push({ node: change.after ?? change.before, label });
    select.append(label);
    container.append(select, details);
    return container;
  }

  renderDetails(change, result, row) {
    const content = document.createDocumentFragment();
    if (row.a !== undefined || row.b !== undefined) {
      const delta = element("dl", "cd-delta");
      for (const [label, value, color] of [["− 旧", row.a, "old"], ["＋ 新", row.b, "new"]]) {
        if (value === undefined) continue;
        const pair = element("div", `cd-${color}`);
        pair.append(element("dt", "", label), element("dd", "", value));
        delta.append(pair);
      }
      content.append(delta);
    } else if (change.kind === "added") {
      const { inputs, outputs } = change.after;
      content.append(element("p", "cd-node-summary", `${inputs.length} 个输入 · ${outputs.length} 个输出`));
    }
    if (change.kind === "deleted") {
      const canOpen = result.before.graphs.has(change.before.type) ||
        (change.graph !== ROOT && !result.after.paths.has(change.graph));
      content.append(deletedDetails(change, result, canOpen, () => this.locate(change, result, true)));
    }
    return content;
  }

  async locate(change, result, openOld) {
    if (this.result !== result || !this.visible) return;
    const context = this.currentContext();
    const click = Symbol();
    this.click = click;
    this.reloadButton.hidden = true;
    try {
      const note = await this.canvas.locate(change, result, openOld);
      if (this.click !== click || !this.current(context) || this.result !== result) return;
      if (note === undefined) return;
      if (note) this.message(note);
      else this.showChangeCount();
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
    nodeIdentity.setDefinitions(definitions);
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
