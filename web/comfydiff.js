import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { compare, equal, nodeLabel, parseWorkflow, ROOT, snapshot, sourceLabel, widgetSlots } from "./diff.js";
import { CanvasReview, liveSnapshot, namesOnCanvas } from "./canvas.js";
import { element } from "./graph-view.js";
import { NodeIdentity } from "./node-identity.js";
import { createSidebarSplit } from "./sidebar-split.js";

const TAB = "comfydiff";
const fileByInstance = new Map();
const nodeIdentity = new NodeIdentity();
const subgraphLabel = (path) => path.map((step) => `${step.name} #${step.id}`).join(" › ");
const pathLabel = (path) => path.length ? `主图 › ${subgraphLabel(path)}` : "主图";
const errorText = (error) => error instanceof Error ? error.message : String(error);
const modeNames = new Map([[0, "始终"], [1, "事件时"], [2, "停用"], [3, "触发时"], [4, "旁路"]]);
const ALL_GRAPHS = "*";
const changeCategories = [
  { id: "all", label: "全部" },
  { id: "fields", label: "参数", title: "参数与模式", kinds: ["parameter", "mode"] },
  { id: "links", label: "接线", title: "接线与来源", kinds: ["input"] },
  { id: "nodes", label: "节点", kinds: ["added", "deleted", "replaced"] },
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

function icon(name) {
  const glyph = element("i", `pi pi-${name}`);
  glyph.setAttribute("aria-hidden", "true");
  return glyph;
}

function iconButton(name, label, action) {
  const control = button("", action, "cd-icon-button");
  control.setAttribute("aria-label", label);
  control.title = label;
  control.append(icon(name));
  return control;
}

function formDialog(title, label, input, confirm, action, help) {
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
  if (help) form.append(element("p", "cd-form-help", help));
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
  const target = after ?? before;
  const { graphs } = after ? result.after : result.before;
  const node = target.title || graphs.get(target.type)?.name || target.type;
  if (kind === "added") {
    const summary = `${target.inputs.length} 个输入 · ${target.outputs.length} 个输出`;
    return { label: "新增节点", color: "green", node, summary };
  }
  if (kind === "deleted") return { label: "删除节点", color: "red", node };
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
  const summary = from?.kind === "link" && to?.kind === "link"
    ? `#${from.edge.source.id} → #${to.edge.source.id}` : undefined;
  return { label, node: `${node} · ${change.field}`, a: sourceText(from, missing), b: sourceText(to, missing), summary };
}

function changeKey(change) {
  const field = change.kind === "boundary" ? (change.to ?? change.from).key : change.fieldKey;
  return JSON.stringify([change.graph, change.node, change.fieldKey ? "field" : change.kind, change.side, field]);
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
    this.rows = [];

    const heading = element("header", "cd-header");
    const headerActions = element("div", "cd-header-actions");
    this.refreshButton = iconButton("refresh", "刷新比较", () => this.refresh({ preserve: true }));
    const menu = element("div", "cd-menu");
    menu.setAttribute("popover", "auto");
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", "更多比较选项");
    this.menu = menu;
    const more = iconButton("ellipsis-h", "更多比较选项");
    more.popoverTargetElement = menu;
    this.openButton = button("在新标签页打开仓库文件", () => {
      menu.hidePopover();
      more.focus({ preventScroll: true });
      this.safe(() => this.chooseFile(true));
    });
    this.openButton.title = "从 Git 工作区读取文件，并在 ComfyUI 新标签页打开。";
    menu.append(this.openButton, button("Git 工作区设置", () => {
      menu.hidePopover();
      more.focus({ preventScroll: true });
      this.settings();
    }));
    headerActions.append(this.refreshButton, more, menu);
    heading.append(element("h2", "", "工作流差异"), headerActions);

    const comparison = element("div", "cd-comparison");
    const active = element("p", "cd-path");
    this.activePath = element("strong");
    active.append(element("span", "", "当前标签页"), this.activePath);
    const paths = element("p", "cd-path");
    this.path = element("code");
    this.bindButton = button("关联仓库文件", () => this.safe(() => this.chooseFile(false)));
    this.bindButton.title = "只设置当前标签页的比较对象。";
    paths.append(element("span", "", "仓库文件"), this.path);
    const baseline = element("p", "cd-baseline");
    this.baseline = baseline;
    this.provenance = element("code");
    baseline.append(element("span", "", "基准版本"), this.provenance);
    const sources = element("div", "cd-sources");
    sources.setAttribute("role", "group");
    sources.setAttribute("aria-label", "与基准版本比较的对象");
    this.diskButton = button("磁盘文件", () => this.setMode("disk"));
    this.diskButton.title = "与 Git 工作区里已保存的文件比较。";
    this.diskButton.prepend(icon("database"));
    this.canvasButton = button("当前画布", () => this.setMode("canvas"));
    this.canvasButton.title = "与当前标签页里的工作流比较，包含未保存修改。";
    this.canvasButton.prepend(icon("sitemap"));
    sources.append(this.diskButton, this.canvasButton);
    comparison.append(active, paths, this.bindButton, baseline, sources);
    this.status = element("p", "cd-status");
    this.status.setAttribute("role", "status");
    const controls = element("div", "cd-review-header");
    controls.append(heading, comparison, this.status);

    this.results = element("section", "cd-results");
    this.results.hidden = true;
    const searchField = element("div", "cd-search");
    this.search = element("input");
    this.search.type = "search";
    this.search.placeholder = "节点、参数或 ID";
    this.search.setAttribute("aria-label", "搜索差异");
    this.search.oninput = () => this.renderResults({ resetScroll: true });
    searchField.append(icon("search"), this.search);
    this.scopePicker = element("select", "cd-scope");
    this.scopePicker.setAttribute("aria-label", "差异范围");
    this.scopePicker.onchange = () => {
      this.scope = this.scopePicker.value;
      this.renderResults({ resetScroll: true });
    };
    this.tabList = element("div", "cd-tabs");
    this.tabList.setAttribute("role", "tablist");
    this.tabList.setAttribute("aria-label", "差异类型");
    this.tabList.onkeydown = (event) => this.handleTabKey(event);
    const filters = element("div", "cd-filters");
    filters.append(searchField, this.scopePicker, this.tabList);
    this.list = element("div", "cd-list");
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
      this.list.append(panel);
      return { ...category, control, count, panel };
    });

    this.inspector = element("section", "cd-inspector");
    this.inspector.id = "cd-inspector";
    this.inspector.hidden = true;
    this.inspector.setAttribute("aria-label", "所选差异");
    this.detailBody = element("div", "cd-inspector-body");
    this.locateStatus = element("p", "cd-locate-status");
    this.locateStatus.setAttribute("role", "status");
    this.detailContent = element("div", "cd-inspector-content");
    this.locateButton = button("", () => this.locate(), "cd-primary");
    this.useCanvasButton = button("比较当前画布并定位", () => this.setMode("canvas", true), "cd-primary");
    this.reloadButton = button("在当前标签页载入磁盘版本", () => this.safe(() => this.reloadDisk()));
    this.detailBody.append(this.locateStatus, this.reloadButton, this.detailContent);
    const pager = element("div", "cd-pager");
    pager.setAttribute("role", "group");
    pager.setAttribute("aria-label", "审查顺序");
    this.previousButton = iconButton("chevron-left", "上一处差异", () => this.step(-1));
    this.nextButton = iconButton("chevron-right", "下一处差异", () => this.step(1));
    this.position = element("output");
    this.position.setAttribute("aria-label", "当前差异序号");
    pager.append(this.previousButton, this.position, this.nextButton);
    const inspectActions = element("div", "cd-inspector-actions");
    inspectActions.append(this.locateButton, this.useCanvasButton, pager);
    this.inspector.append(this.detailBody, inspectActions);
    const panes = element("div", "cd-panes");
    this.split = createSidebarSplit(panes, this.inspector);
    this.split.hidden = true;
    panes.append(this.list, this.split, this.inspector);
    this.results.append(panes);
    root.replaceChildren(controls, this.results);
    this.render();
  }

  get workflow() { return app.extensionManager.workflow.activeWorkflow; }
  get supported() { return app.extensionManager.setting.get("Comfy.VueNodes.Enabled") === true; }
  get visible() { return this.root.isConnected && app.extensionManager.sidebarTab.activeSidebarTabId === TAB; }

  get tabKey() {
    const workflow = this.workflow;
    return [api.user, workflow?.instanceId, workflow?.path, workflow?.isTemporary];
  }

  get association() {
    if (!equal(this.configTab, this.tabKey)) return null;
    const workflow = this.workflow;
    return (workflow?.isTemporary && fileByInstance.get(this.bindingKey(workflow))) || this.config;
  }

  get file() { return this.association?.file; }

  bindingKey(workflow) {
    return JSON.stringify([api.user, this.config.workspace, workflow?.instanceId]);
  }

  currentContext() {
    return [this.sequence, ...this.tabKey, app.rootGraphOrUndefined];
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
    if (this.menu.matches(":popover-open")) this.menu.hidePopover();
    this.setResultsBusy(false);
    this.clearSelection();
    this.result = null;
    this.clearResults();
    this.baseline.hidden = true;
  }

  clearResults() {
    this.providerLabels = [];
    this.rows = [];
    this.list.scrollTop = 0;
    this.results.hidden = true;
    for (const tab of this.tabs) tab.panel.replaceChildren();
  }

  clearSelection() {
    this.clearLocation();
    this.selected?.control.setAttribute("aria-pressed", "false");
    this.selected = null;
    this.split.hidden = true;
    this.inspector.hidden = true;
    this.detailContent.replaceChildren();
  }

  clearLocation() {
    this.click = null;
    this.canvas.clear();
    this.showLocateStatus();
  }

  showLocateStatus(message = "", error = false) {
    this.locateStatus.textContent = message;
    this.locateStatus.classList.toggle("cd-error", error);
    const diskMismatch = error && this.mode === "disk";
    this.reloadButton.hidden = !diskMismatch || !!this.workflow?.isModified;
    this.useCanvasButton.hidden = !diskMismatch;
    this.locateButton.hidden = diskMismatch;
  }

  reviewPosition() {
    if (!this.selected) return;
    return { key: changeKey(this.selected.change), scroll: this.list.scrollTop };
  }

  restorePosition(position, locate) {
    let row = this.rows.find(({ change }) => changeKey(change) === position.key);
    if (!row && locate && this.result.changes.some((change) => changeKey(change) === position.key)) {
      this.category = "all";
      this.renderResults();
      row = this.rows.find(({ change }) => changeKey(change) === position.key);
    }
    if (row) {
      this.list.scrollTop = position.scroll;
      this.selectRow(row);
      if (locate) {
        this.locateButton.focus({ preventScroll: true });
        void this.locate();
      }
    } else if (locate) {
      this.message("当前画布的比较结果中没有这处差异。");
    }
  }

  setResultsBusy(busy) {
    this.results.inert = busy;
    this.results.setAttribute("aria-busy", String(busy));
  }

  tick() {
    if (!this.visible) {
      if (this.wasVisible) this.reset();
      this.wasVisible = false;
      return;
    }
    const stamp = [this.supported, ...this.tabKey];
    if (!this.wasVisible || !equal(stamp, this.stamp) || this.graph !== app.rootGraphOrUndefined) {
      this.wasVisible = true;
      this.stamp = stamp;
      this.graph = app.rootGraphOrUndefined;
      this.refresh();
    } else if (this.mode === "disk" && this.file && !this.reading && Date.now() >= this.nextRead) {
      this.read(false);
    }
  }

  setMode(mode, locate = false) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.render();
    return this.refresh({ preserve: true, locate });
  }

  refresh({ preserve = false, locate = false } = {}) {
    if (preserve && this.result) {
      this.sequence++;
      if (this.results.contains(document.activeElement)) {
        (locate ? this.canvasButton : this.refreshButton).focus({ preventScroll: true });
      }
      this.setResultsBusy(true);
      this.click = null;
      this.canvas.clear();
    } else {
      this.reset();
      this.render();
    }
    return this.read(true, locate);
  }

  async read(force, locate = false) {
    const workflow = this.workflow;
    const root = app.rootGraphOrUndefined;
    const context = this.currentContext();
    const requestId = Symbol();
    this.readId = requestId;
    this.reading = true;
    this.nextRead = Date.now() + 2500;
    if (force && !this.result) this.message("正在读取差异…");
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
      this.configTab = this.tabKey;
      this.render();
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
        this.message("无法自动识别仓库路径，请为当前标签页关联文件。");
        return;
      }
      const data = await request("compare", {
        workspace: config.workspace, file, mode: this.mode, known: force ? null : this.result?.token,
      });
      if (!stillCurrent()) return;
      if (data.unchanged) return;
      const before = snapshot(data.before === null ? null : parseWorkflow(data.before, "HEAD"));
      const after = currentCanvas ?? snapshot(parseWorkflow(data.after, "工作区"));
      const changes = compare(before, after, (graph, node) => namesOnCanvas(app, graph, node));
      const filterContext = [api.user, workflow.instanceId, config.workspace, file];
      const sameFile = equal(this.filterContext, filterContext);
      const position = sameFile ? this.reviewPosition() : null;
      if (!sameFile) {
        this.scope = ALL_GRAPHS;
        this.category = "all";
        this.search.value = "";
        this.list.scrollTop = 0;
        this.filterContext = filterContext;
      }
      this.clearSelection();
      this.result = { ...data, before, after, changes };
      this.message(changes.length ? "" : "没有检测到工作流差异。");
      this.setResultsBusy(false);
      this.renderScopes();
      this.renderResults();
      if (position) this.restorePosition(position, locate);
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
        this.setResultsBusy(false);
        this.render();
      }
    }
  }

  render() {
    const workflow = this.workflow;
    const native = workflow?.path;
    this.activePath.textContent = workflow?.fullFilename || native?.split("/").at(-1) || (workflow ? "未命名工作流" : "无");
    this.activePath.title = native || "";
    const association = this.association;
    this.path.textContent = association?.file || this.unresolvedPath();
    this.path.title = association?.file || "";
    this.bindButton.hidden = !this.config.workspace || !association || association.automatic || !workflow || !this.supported;
    this.bindButton.textContent = association?.file ? "更改当前标签页关联" : "关联仓库文件";
    this.openButton.disabled = !this.config.workspace || !this.supported;
    this.refreshButton.disabled = !this.supported;
    this.diskButton.disabled = this.canvasButton.disabled = !this.file || !this.supported;
    this.diskButton.setAttribute("aria-pressed", String(this.mode === "disk"));
    this.canvasButton.setAttribute("aria-pressed", String(this.mode === "canvas"));
    const head = this.result?.head.slice(0, 7);
    this.baseline.hidden = !head;
    this.provenance.textContent = head ? `HEAD ${head}${this.result.before.graphs.size ? "" : " · 新文件"}` : "";
  }

  unresolvedPath() {
    if (!this.workflow || !this.supported) return "—";
    if (!this.association) return "正在识别…";
    return this.config.workspace ? "未关联" : "尚未设置 Git 工作区";
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
    const key = this.bindingKey(workflow);
    const tab = this.tabKey;
    const current = () => this.visible && workspace === this.config.workspace && equal(tab, this.tabKey);
    const files = await request("files", { workspace });
    if (!current()) return;
    if (!files.length) throw new Error("工作区没有可选择的 JSON 文件。");
    const select = element("select");
    for (const file of files) {
      const option = element("option", "", file);
      option.value = file;
      select.append(option);
    }
    if (files.includes(this.file)) select.value = this.file;
    formDialog(open ? "在新标签页打开仓库文件" : "关联当前标签页", "仓库相对路径", select,
      open ? "在新标签页打开" : "关联", async (file) => {
        if (!current()) {
          throw new Error("工作区或标签页已切换，请重新选择。");
        }
        if (open) {
          const { content } = await request("file", { workspace, file });
          if (!current()) {
            throw new Error("工作区或标签页已切换，请重新选择。");
          }
          const data = parseWorkflow(content, "工作区");
          const opened = app.extensionManager.workflow.createNewTemporary(file, data);
          fileByInstance.set(this.bindingKey(opened), { file, automatic: true });
          const loaded = await app.loadGraphData(data, true, true, opened);
          if (!loaded || this.workflow?.instanceId !== opened.instanceId) {
            throw new Error("ComfyUI 未能打开工作流。");
          }
        } else if (workflow.isTemporary) {
          fileByInstance.set(key, { file, automatic: false });
        } else {
          await request("binding", {}, { workspace, file, native: workflow.path });
        }
        await this.refresh();
      }, open ? "在新标签页载入文件并自动比较。" : "指定当前标签页的比较对象，画布内容保持原样。");
  }

  async reloadDisk() {
    const workflow = this.workflow;
    if (!this.selected || this.mode !== "disk") return;
    const context = this.currentContext();
    const graphState = app.rootGraphOrUndefined?.state;
    const click = this.click;
    if (workflow?.isModified) throw new Error("当前画布有未保存编辑，可切换到「对比当前画布」。");
    const { content } = await request("file", { workspace: this.config.workspace, file: this.file });
    if (!this.current(context) || this.click !== click || app.rootGraphOrUndefined?.state !== graphState) return;
    if (workflow.isModified) throw new Error("当前画布有未保存编辑，可切换到「对比当前画布」。");
    this.canvas.clear();
    const loaded = await app.loadGraphData(parseWorkflow(content, "工作区"), true, true, workflow);
    if (!loaded) throw new Error("ComfyUI 未能载入磁盘版本。");
    await this.refresh();
  }

  renderScopes() {
    const { before, after, changes } = this.result;
    const graphs = new Map([[ALL_GRAPHS, "主图和子图"], [ROOT, "仅主图"]]);
    for (const { graph } of changes) {
      if (!graphs.has(graph)) graphs.set(graph, `子图 · ${subgraphLabel(after.paths.get(graph) ?? before.paths.get(graph))}`);
    }
    if (!graphs.has(this.scope)) this.scope = ALL_GRAPHS;
    this.scopePicker.replaceChildren();
    for (const [value, label] of graphs) {
      const option = element("option", "", label);
      option.value = value;
      this.scopePicker.append(option);
    }
    this.scopePicker.value = this.scope;
  }

  activateCategory(category, focus = false) {
    if (!this.result) return;
    if (this.category !== category) {
      this.category = category;
      this.renderResults({ resetScroll: true });
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

  renderResults({ resetScroll = false } = {}) {
    const result = this.result;
    const terms = this.search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const inScope = result.changes.filter((change) => this.scope === ALL_GRAPHS || change.graph === this.scope);
    const scoped = terms.length ? inScope.filter((change) => {
      const { before, after } = change;
      const { node, label } = description(change, result);
      const text = [
        node, label, before?.type, after?.type, `#${change.node}`,
        pathLabel(result.after.paths.get(change.graph) ?? result.before.paths.get(change.graph) ?? []),
      ].join(" ").toLowerCase();
      return terms.every((term) => text.includes(term));
    }) : inScope;
    const selectedChange = this.selected?.change;
    const scroll = resetScroll ? 0 : this.list.scrollTop;
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
    this.rows = [];
    if (!entries.includes(selectedChange)) this.clearSelection();
    if (!entries.length) {
      panel.tabIndex = 0;
      panel.append(element("p", "cd-empty", "这个范围没有匹配的差异。"));
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
      const heading = element("h3", "", pathLabel(path));
      heading.append(element("span", "", `${changes.length} 处`));
      group.append(heading);
      for (const change of changes) {
        const row = this.renderChange(change, result);
        this.rows.push(row);
        group.append(row.control);
      }
      panel.append(group);
    }
    this.list.scrollTop = scroll;
    const row = this.rows.find(({ change }) => change === selectedChange);
    if (row) {
      this.selected = row;
      row.control.setAttribute("aria-pressed", "true");
      this.updatePager();
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
    const detail = description(change, result);
    const control = button("", () => this.selectRow(row), "cd-change");
    const row = { change, detail, control };
    control.setAttribute("aria-pressed", "false");
    const symbol = element("span", `cd-change-symbol cd-${detail.color ?? "yellow"}`,
      detail.color === "green" ? "+" : detail.color === "red" ? "−" : "↔");
    symbol.setAttribute("aria-hidden", "true");
    const copy = element("span", "cd-row-copy");
    const isNode = !(change.after ?? change.before).raw.boundary;
    const summary = detail.summary ?? (detail.a !== undefined && detail.b !== undefined
      ? `${preview(detail.a)} → ${preview(detail.b)}` : detail.label);
    copy.append(element("strong", "", detail.node), element("span", "cd-kind", summary));
    const label = element("span", "cd-node-provider");
    this.providerLabels.push({ node: change.after ?? change.before, label });
    copy.append(label);
    control.append(symbol, copy, element("span", "cd-node-id", isNode ? `#${change.node}` : detail.label));
    return row;
  }

  selectRow(row) {
    if (this.selected === row) {
      this.clearSelection();
      return;
    }
    this.clearLocation();
    this.selected?.control.setAttribute("aria-pressed", "false");
    this.selected = row;
    row.control.setAttribute("aria-pressed", "true");
    const heading = element("div", "cd-inspector-heading");
    heading.append(element("strong", "", row.detail.node), element("span", "", row.detail.label));
    this.detailContent.replaceChildren(heading, this.renderDetails(row.change, this.result, row.detail));
    this.detailBody.scrollTop = 0;
    this.locateButton.replaceChildren(icon("map-marker"), row.change.kind === "deleted" ? "在画布查看删除" : "定位到画布");
    this.updatePager();
    this.split.hidden = false;
    this.inspector.hidden = false;

    const viewport = this.list.getBoundingClientRect();
    const bounds = row.control.getBoundingClientRect();
    if (bounds.top < viewport.top || bounds.height > this.list.clientHeight) {
      this.list.scrollTop -= viewport.top - bounds.top;
    } else if (bounds.bottom > viewport.bottom) {
      this.list.scrollTop += bounds.bottom - viewport.bottom;
    }
  }

  updatePager() {
    const index = this.rows.indexOf(this.selected);
    this.previousButton.disabled = index <= 0;
    this.nextButton.disabled = index >= this.rows.length - 1;
    this.position.textContent = `${index + 1} / ${this.rows.length}`;
  }

  step(direction) {
    const row = this.rows[this.rows.indexOf(this.selected) + direction];
    if (!row) return;
    const active = document.activeElement;
    this.selectRow(row);
    if (active?.disabled) row.control.focus({ preventScroll: true });
  }

  renderDetails(change, result, row) {
    const content = document.createDocumentFragment();
    if (row.a !== undefined || row.b !== undefined) {
      const delta = element("dl", "cd-delta");
      for (const [label, value, color] of [["− HEAD", row.a, "old"], [this.mode === "disk" ? "+ 磁盘" : "+ 画布", row.b, "new"]]) {
        if (value === undefined) continue;
        const pair = element("div", `cd-${color}`);
        pair.append(element("dt", "", label), element("dd", "", value));
        delta.append(pair);
      }
      content.append(delta);
    } else if (change.kind === "added") {
      content.append(element("p", "cd-node-summary", row.summary));
    }
    if (change.kind === "deleted") {
      const canOpen = result.before.graphs.has(change.before.type) ||
        (change.graph !== ROOT && !result.after.paths.has(change.graph));
      content.append(deletedDetails(change, result, canOpen, () => this.locate(true)));
    }
    return content;
  }

  async locate(openOld = false) {
    if (!this.selected || !this.visible) return;
    const { change } = this.selected;
    const result = this.result;
    const context = this.currentContext();
    const click = Symbol();
    this.click = click;
    this.showLocateStatus();
    try {
      const note = await this.canvas.locate(change, result, openOld);
      if (this.click !== click || !this.current(context) || this.result !== result) return;
      if (note !== undefined) this.showLocateStatus(note || "已定位到画布。");
    } catch (error) {
      if (this.click !== click || !this.current(context) || this.result !== result) return;
      const hadFocus = document.activeElement === this.locateButton;
      this.showLocateStatus(errorText(error), true);
      this.detailBody.scrollTop = 0;
      if (hadFocus && !this.useCanvasButton.hidden) this.useCanvasButton.focus({ preventScroll: true });
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
        container.classList.add("comfydiff-mount");
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
