import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { compare, equal, nodeName, parseWorkflow, ROOT, snapshot, sourceLabel, widgetSlots } from "./diff.js";
import { CanvasReview, liveSnapshot, namesOnCanvas, restoresNamedWidgets } from "./canvas.js";
import { element, nodeIdButton } from "./graph-view.js";
import { collectIssues } from "./issues.js";
import { NodeIdentity } from "./node-identity.js";
import { createSidebarSplit } from "./sidebar-split.js";
import { reconcileAssociation } from "./workflow-association.js";
import { openWorkspacePicker } from "./workspace-picker.js";
import { SourceControl } from "./source-control.js";
import { WorkspaceFiles } from "./workspace-files.js";
import { apiError, setLocale, t } from "./i18n.js";

const TAB = "comfydiff";
const nodeIdentity = new NodeIdentity();
const pathLabel = (path) => [t("common.rootGraph"), ...path.map((step) => `${step.name} #${step.id}`)].join(" › ");
const errorText = (error) => error instanceof Error ? error.message : String(error);
const modeNames = new Map([[0, "mode.always"], [1, "mode.event"], [2, "mode.never"], [3, "mode.trigger"], [4, "mode.bypass"]]);
const modeName = (mode) => modeNames.has(mode) ? t(modeNames.get(mode)) : mode;
const ALL_GRAPHS = "*";
const ISSUES = "issues";
const sources = {
  changed: { label: "scm.unstaged", before: "version.index", after: "version.disk", help: "diff.unstagedHelp" },
  staged: { label: "scm.staged", before: "version.head", after: "version.index", help: "diff.stagedHelp" },
  canvas: { label: "scm.unsaved", before: "version.baseline", after: "version.canvas", help: "diff.unsavedHelp" },
};
const changeCategories = [
  { id: "all", label: "diff.all" },
  { id: "fields", label: "diff.parameters", title: "diff.parametersAndMode", kinds: ["parameter", "mode"] },
  { id: "links", label: "diff.links", title: "diff.linksAndSources", kinds: ["input"] },
  { id: "nodes", label: "diff.nodes", kinds: ["added", "deleted", "replaced"] },
  { id: "ports", label: "diff.ports", title: "diff.subgraphPorts", kinds: ["boundary"] },
];
const issueCategories = {
  model: { label: "issue.missingModel", icon: "database", resource: true },
  node: { label: "issue.missingNode", icon: "box" },
  media: { label: "issue.missingMedia", icon: "image", resource: true },
  validation: { label: "issue.validationFailed", icon: "sliders-h" },
  runtime: { label: "issue.executionFailed", icon: "bolt" },
};
const MAX_EXPANDED_ISSUES = 6;

function searchIssues(issues, terms) {
  if (!terms.length) return issues;
  return issues.flatMap((issue) => {
    const summary = [t(issueCategories[issue.group].label), issue.message, issue.directory].join(" ").toLowerCase();
    const matches = (target) => {
      const id = target.id?.toLowerCase();
      const localId = id?.split(":").at(-1);
      const text = [summary, target.node, id, target.detail, ...(target.details ?? [])].join(" ").toLowerCase();
      return terms.every((term) => term.startsWith("#")
        ? id && (term === `#${id}` || term === `#${localId}`) : text.includes(term));
    };
    if (!issue.targets) return matches(issue) ? [issue] : [];
    const matchingTargets = issue.targets.filter(matches);
    const openMatches = terms.some((term) => term.startsWith("#") || !summary.includes(term));
    return matchingTargets.length ? [{ ...issue, matchingTargets, openMatches }] : [];
  });
}

function issueFile(path) {
  const file = element("code", "cd-issue-file");
  const cutoff = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  if (cutoff) file.append(element("span", "cd-issue-directory", path.slice(0, cutoff)), element("wbr"));
  file.append(element("span", "", path.slice(cutoff)));
  return file;
}

function issueNodeTitle(name, id, locate) {
  const title = element("div", "cd-issue-title");
  if (name) title.append(element("strong", "", name));
  if (id) title.append(nodeIdButton(id, locate, "cd-issue-id"));
  return title;
}

async function request(operation, params = {}, body) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value != null) query.set(key, value);
  }
  const response = await api.fetchApi(`/comfydiff/${operation}?${query}`, body ? {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(apiError(data));
  if (data.blocked) data.blocked = t(data.blocked);
  return data;
}

const workspaceFiles = new WorkspaceFiles(app, request, () => api.user);

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
  actions.append(button(t("common.cancel"), () => dialog.close()), submit);
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
  return typeof value === "string" ? value : value === undefined ? t("common.none") : JSON.stringify(value);
}

function sourceText(source, missing = t("common.disconnected")) {
  if (!source) return missing;
  if (source.kind === "link") return sourceLabel(source.edge);
  if (source.kind === "exposed") return t("diff.exposedDisconnected");
  return display(source.value);
}

function preview(value) {
  const text = String(value);
  const [first] = text.split("\n", 1);
  return first.length <= 54 && first === text ? first : `${first.slice(0, 54)}…`;
}

function appendEndpoint(target, node, port, input, locate, graphSnapshot, compact = false) {
  if (!node.raw.boundary) {
    target.append(nodeIdButton(node.id, () => locate(node)));
    if (compact) return;
    target.append(" ");
  }
  const name = nodeName(node, graphSnapshot);
  target.append(compact ? name : `${name}.${port.name || t(input ? "common.inputNumber" : "common.outputNumber", { number: port.index + 1 })}`);
}

function changeNodeName(change, result) {
  const { before, after } = change;
  return nodeName(after ?? before, after ? result.after : result.before);
}

function description(change, result) {
  const { kind, from, to, before, after } = change;
  const node = changeNodeName(change, result);
  if (kind === "added") {
    const summary = t("diff.nodePorts", { inputs: after.inputs.length, outputs: after.outputs.length });
    return { label: t("diff.addedNode"), color: "green", node, summary };
  }
  if (kind === "deleted") return { label: t("diff.deletedNode"), color: "red", node };
  if (kind === "replaced") return { label: t("diff.replacedNode"), node, a: before.type, b: after.type };
  if (kind === "mode") return { label: t("diff.executionMode"), node, a: modeName(from), b: modeName(to) };
  if (kind === "boundary") {
    const port = to ?? from;
    const field = port.label || port.name;
    return {
      label: !from ? t("diff.addedPort") : !to ? t("diff.removedPort") : t("diff.changedPort"),
      color: !from ? "green" : !to ? "red" : undefined,
      node: `${node} · ${field}`,
      field,
      a: from ? `${from.label || from.name} · ${display(from.type)}` : t("common.none"),
      b: to ? `${to.label || to.name} · ${display(to.type)}` : t("common.none"),
    };
  }
  let label = t("diff.parameter");
  if (kind === "input") {
    if (from?.kind === "value" || to?.kind === "value") label = t("diff.sourceChanged");
    else if (from?.kind !== "link" && to?.kind === "link") label = t("diff.addedLink");
    else if (from?.kind === "link" && to?.kind !== "link") label = t("diff.removedLink");
    else if (from?.kind === "link" && to?.kind === "link") label = t("diff.changedLink");
    else label = t("diff.portSource");
  }
  const missing = kind === "parameter" ? t("common.none") : t("common.disconnected");
  return {
    label, node: `${node} · ${change.field}`, field: change.field,
    a: sourceText(from, missing), b: sourceText(to, missing),
  };
}

function changeKey(change) {
  const field = change.kind === "boundary" ? (change.to ?? change.from).key : change.fieldKey;
  return JSON.stringify([change.graph, change.node, change.fieldKey ? "field" : change.kind, change.side, field]);
}

function deletedDetails(change, result, canOpen, onOpen, locate) {
  const graph = result.before.graphs.get(change.graph);
  const node = change.before;
  const details = element("div", "cd-details");
  details.append(element("strong", "", t("diff.oldNodeDetails")));
  const body = element("ul");
  body.append(element("li", "", t("diff.executionModeValue", { mode: modeName(node.mode) })));
  let index = 0;
  for (const value of widgetSlots(node).values()) {
    body.append(element("li", "", `${value.name || t("common.parameterNumber", { number: index + 1 })}  ${display(value.value)}`));
    index++;
  }
  for (const edge of graph.incident.get(node.id) ?? []) {
    const line = element("li");
    appendEndpoint(line, edge.source, edge.out, false, locate, result.before);
    line.append(" → ");
    appendEndpoint(line, edge.target, edge.port, true, locate, result.before);
    body.append(line);
  }
  details.append(body);
  if (canOpen) details.append(button(t("canvas.viewDeletedSubgraph"), onOpen));
  return details;
}

class Sidebar {
  constructor(root) {
    this.root = root;
    this.canvas = new CanvasReview(app, root);
    this.mode = "auto";
    this.config = {};
    this.sequence = 0;
    this.reading = false;
    this.nextRead = 0;
    this.category = "all";
    this.scope = ALL_GRAPHS;
    this.rows = [];
    this.expandedNodes = new Set();
    this.issues = [];
    this.issueGroupOpen = new Map();
    this.issueItemOpen = new Set();

    const heading = element("header", "cd-header");
    const headingTitle = element("div", "cd-header-title");
    this.backButton = iconButton("arrow-left", t("scm.back"), () => this.showSourceControl());
    headingTitle.append(this.backButton, element("h2", "", t("diff.title")));
    const headerActions = element("div", "cd-header-actions");
    this.refreshButton = iconButton("refresh", t("diff.refresh"), () => this.refresh({ preserve: true }));
    const menu = element("div", "cd-menu");
    menu.setAttribute("popover", "auto");
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", t("diff.moreOptions"));
    this.menu = menu;
    const more = iconButton("ellipsis-h", t("diff.moreOptions"));
    more.popoverTargetElement = menu;
    this.openButton = button(t("workspace.openRepositoryWorkflow"), () => {
      menu.hidePopover();
      more.focus({ preventScroll: true });
      this.safe(() => this.chooseFile(true));
    });
    this.openButton.title = t("workspace.openRepositoryWorkflowHelp");
    menu.append(this.openButton, button(t("workspace.settings"), () => {
      menu.hidePopover();
      more.focus({ preventScroll: true });
      this.settings();
    }));
    headerActions.append(this.refreshButton, more, menu);
    heading.append(headingTitle, headerActions);

    const comparison = element("div", "cd-comparison");
    const active = element("p", "cd-path");
    this.activePath = element("strong");
    active.append(element("span", "", t("workspace.activeTab")), this.activePath);
    const paths = element("p", "cd-path");
    this.path = element("code");
    this.bindButton = button(t("workspace.bindFile"), () => this.safe(() => this.chooseFile(false)));
    this.bindButton.title = t("workspace.bindFileHelp");
    paths.append(element("span", "", t("workspace.repositoryFile")), this.path);
    this.sourcePicker = element("div", "cd-sources");
    this.sourcePicker.setAttribute("role", "group");
    this.sourcePicker.setAttribute("aria-label", t("diff.source"));
    this.sourceButtons = new Map(Object.entries(sources).map(([mode, source]) => {
      const control = button(t(source.label), () => this.safe(() => this.selectSource(mode)));
      control.title = t(source.help);
      this.sourcePicker.append(control);
      return [mode, control];
    }));
    this.canvasButton = this.sourceButtons.get("canvas");
    this.sourceSummary = element("p", "cd-source-summary");
    this.saveButton = button(t("workspace.save"), () => this.safe(() => this.saveWorkspace()));
    comparison.append(active, paths, this.bindButton, this.sourcePicker, this.sourceSummary, this.saveButton);
    this.status = element("p", "cd-status");
    this.status.setAttribute("role", "status");
    const controls = element("div", "cd-review-header");
    controls.append(heading, comparison, this.status);

    this.results = element("section", "cd-results");
    this.results.hidden = true;
    const searchField = element("div", "cd-search");
    this.search = element("input");
    this.search.type = "search";
    this.search.placeholder = t("diff.searchPlaceholder");
    this.search.setAttribute("aria-label", t("diff.search"));
    this.search.oninput = () => this.renderResults({ resetScroll: true });
    this.issueSearch = element("input", "cd-issue-search");
    this.issueSearch.type = "search";
    this.issueSearch.placeholder = t("issue.searchPlaceholder");
    this.issueSearch.setAttribute("aria-label", t("issue.search"));
    this.issueSearch.oninput = () => {
      this.list.scrollTop = 0;
      this.renderIssueList();
    };
    searchField.append(icon("search"), this.search, this.issueSearch);
    this.scopePicker = element("select", "cd-scope");
    this.scopePicker.setAttribute("aria-label", t("diff.scope"));
    this.scopePicker.onchange = () => {
      this.scope = this.scopePicker.value;
      this.renderResults({ resetScroll: true });
    };
    this.tabList = element("div", "cd-tabs");
    this.tabList.setAttribute("role", "tablist");
    this.tabList.setAttribute("aria-label", t("diff.review"));
    this.tabList.onkeydown = (event) => this.handleTabKey(event);
    const filters = element("div", "cd-filters");
    filters.append(searchField, this.scopePicker, this.tabList);
    this.list = element("div", "cd-list");
    this.results.append(filters);
    this.tabs = [...changeCategories, { id: ISSUES, label: "issue.title" }].map((category) => {
      const control = button("", () => this.activateCategory(category.id), "cd-tab");
      const count = element("span", "cd-tab-count");
      const panel = element("div", "cd-items");
      control.id = `cd-category-${category.id}`;
      control.title = t(category.title ?? category.label);
      control.setAttribute("role", "tab");
      panel.id = `cd-panel-${category.id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", control.id);
      control.setAttribute("aria-controls", panel.id);
      control.append(element("span", "", t(category.label)), count);
      this.tabList.append(control);
      this.list.append(panel);
      return { ...category, control, count, panel };
    });
    this.issueTab = this.tabs.at(-1);
    this.issueTab.count.textContent = " 0";
    this.issueStatus = element("p", "cd-empty cd-issue-status");
    this.issueStatus.setAttribute("role", "status");

    this.inspector = element("section", "cd-inspector");
    this.inspector.id = "cd-inspector";
    this.inspector.hidden = true;
    this.inspector.setAttribute("aria-label", t("diff.selectedChange"));
    this.detailBody = element("div", "cd-inspector-body");
    this.locateStatus = element("p", "cd-locate-status");
    this.locateStatus.setAttribute("role", "status");
    this.detailContent = element("div", "cd-inspector-content");
    this.useCanvasButton = button(t("diff.compareCanvasAndLocate"), () => this.setMode("canvas", true), "cd-primary");
    this.reloadButton = button(t("workspace.reloadDisk"), () => this.safe(() => this.reloadDisk()));
    const recover = element("div", "cd-actions cd-locate-actions");
    recover.append(this.useCanvasButton, this.reloadButton);
    this.detailBody.append(this.locateStatus, recover, this.detailContent);
    this.inspector.append(this.detailBody);
    const panes = element("div", "cd-panes");
    this.panes = panes;
    this.split = createSidebarSplit(panes, this.inspector);
    this.split.hidden = true;
    panes.append(this.list, this.split, this.inspector);
    this.results.append(panes);
    this.diff = element("section", "cd-diff");
    this.diff.append(controls, this.results);
    this.scm = new SourceControl(request, {
      settings: () => this.settings(),
      open: (row, mode) => this.openChange(row, mode),
      currentWorkflow: () => this.showDiff(true),
    });
    root.replaceChildren(this.diff, this.scm.root);
    this.render();
  }

  get workflow() { return app.extensionManager.workflow.activeWorkflow; }
  get supported() { return app.extensionManager.setting.get("Comfy.VueNodes.Enabled") === true; }
  get visible() { return this.root.isConnected && app.extensionManager.sidebarTab.activeSidebarTabId === TAB; }

  get tabKey() {
    const workflow = this.workflow;
    return [api.user, workflow?.instanceId, workflow?.path, workflow?.isTemporary];
  }

  get reviewKey() {
    return [this.supported, restoresNamedWidgets(app), ...this.tabKey];
  }

  get association() {
    if (!equal(this.configTab, this.tabKey)) return null;
    return (this.workflow?.isTemporary && workspaceFiles.association(this.workflow, this.config.workspace)) || this.config;
  }

  get file() { return this.pinned?.file ?? this.association?.file; }

  get sameWorkflow() { return !!this.workflow && (!this.pinned || this.pinned.file === this.association?.file); }

  get comparisonMode() { return this.mode === "auto" ? this.result?.mode ?? "changed" : this.mode; }

  currentContext() {
    return [this.sequence, ...this.reviewKey, app.rootGraphOrUndefined];
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
  }

  clearResults() {
    this.providerLabels = [];
    this.rows = [];
    this.list.scrollTop = 0;
    this.renderResults();
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

  showLocateStatus(message = "", error = false, canRecover = true) {
    this.locateStatus.textContent = message;
    this.locateStatus.classList.toggle("cd-error", error);
    const diskMismatch = error && canRecover && this.comparisonMode === "changed" && this.sameWorkflow;
    this.reloadButton.hidden = !diskMismatch || !!this.workflow?.isModified;
    this.useCanvasButton.hidden = !diskMismatch;
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
        row.locator.focus({ preventScroll: true });
        void this.locate();
      }
    } else if (locate) {
      this.message(t("diff.changeMissingOnCanvas"));
    }
  }

  setResultsBusy(busy) {
    this.resultsBusy = busy;
    this.updateResultsBusy();
  }

  updateResultsBusy() {
    const busy = !!this.resultsBusy && this.category !== ISSUES;
    this.panes.inert = busy;
    this.panes.setAttribute("aria-busy", String(busy));
  }

  tick() {
    if (!this.visible) {
      if (this.wasVisible) {
        this.reset();
        this.scmTab = null;
      }
      this.wasVisible = false;
      return;
    }
    const stamp = this.reviewKey;
    const tabChanged = !equal(stamp, this.stamp);
    if (this.opening) return;
    if (tabChanged) {
      this.issueSearch.value = "";
      this.issueGroupOpen.clear();
      this.issueItemOpen.clear();
    }
    if (tabChanged && this.stamp) {
      this.mode = "auto";
      this.pinned = null;
    }
    if ((!this.wasVisible || tabChanged) && !equal(this.scmTab, this.tabKey)) {
      this.diff.hidden = false;
      this.scm.root.hidden = true;
    }
    if (!this.wasVisible || tabChanged || this.graph !== app.rootGraphOrUndefined) {
      this.issueStatus.textContent = "";
      this.wasVisible = true;
      this.stamp = stamp;
      this.graph = app.rootGraphOrUndefined;
      this.refresh();
    } else if (!this.diff.hidden && !this.reading && (
      (this.mode !== "canvas" && this.file && Date.now() >= this.nextRead) ||
      (this.mode === "canvas" && this.canvasBase !== this.workflow?.originalContent)
    )) {
      this.read(false);
    }
    if (!this.scm.root.hidden) {
      this.configureSourceControl();
      this.scm.tick();
    } else if (this.modified !== this.workflow?.isModified) {
      this.render();
    }
    this.canvas.syncHighlight();
    this.updateIssues(tabChanged);
  }

  configureSourceControl() {
    const workspace = this.config.workspace ?? "";
    const unsaved = workspaceFiles.store.openWorkflows.filter((workflow) =>
      this.supported && workflow.isModified && (workflow.originalContent || workflow.initialState)
    ).map((workflow) => ({
      workflow, file: workspaceFiles.managed(workflow, workspace)?.file ?? workflow.path.replace(/^workflows\//, ""),
    }));
    this.scm.configure(workspace, unsaved, !!this.workflow);
  }

  showSourceControl() {
    this.scmTab = this.tabKey;
    this.sequence++;
    this.canvas.clear();
    this.diff.hidden = true;
    this.configureSourceControl();
    this.scm.show();
    this.scm.currentButton.focus();
    if (!equal(this.configTab, this.tabKey)) this.refresh();
  }

  showDiff(follow = false) {
    if (follow && !this.sameWorkflow) {
      this.mode = "auto";
      this.pinned = null;
    }
    this.scmTab = null;
    this.diff.hidden = false;
    this.scm.root.hidden = true;
    this.backButton.focus({ preventScroll: true });
    return this.refresh({ preserve: true });
  }

  async openChange(row, mode) {
    if (!this.supported) throw new Error(t("canvas.enableNodes2"));
    const workspace = this.config.workspace;
    const previous = this.tabKey;
    const user = api.user;
    const current = () => this.visible && !this.scm.root.hidden && this.config.workspace === workspace && user === api.user;
    const beforeOpen = () => current() && equal(this.tabKey, previous);
    this.opening = true;
    try {
      let opened = true;
      if (mode === "canvas") opened = await workspaceFiles.activate(row.workflow, beforeOpen);
      if (mode === "changed" && row.code !== "D") opened = await workspaceFiles.open(workspace, row.file, beforeOpen);
      if (!opened && beforeOpen()) throw new Error(t("workspace.openFailed"));
      if (!opened || !current()) return;
      this.mode = mode;
      this.pinned = mode === "canvas" ? null : { workspace, file: row.file };
      if (this.category === ISSUES) this.category = "all";
      this.stamp = this.reviewKey;
      this.graph = app.rootGraphOrUndefined;
      await this.showDiff();
    } finally {
      this.opening = false;
    }
  }

  selectSource(mode) {
    if (mode === "canvas") this.pinned = null;
    return this.setMode(mode);
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
    if (force && !this.result) this.message(t("diff.loading"));
    const stillCurrent = () => this.readId === requestId && this.current(context);
    try {
      if (!this.supported) {
        this.message(t("canvas.enableNodes2"));
        return;
      }
      const settings = await request("settings", {
        native: workflow?.path,
        temporary: workflow?.isTemporary ? "1" : null,
      });
      if (!stillCurrent()) return;
      const previous = equal(this.configTab, this.tabKey) ? this.config : null;
      const config = reconcileAssociation(settings, previous);
      if (this.pinned && this.pinned.workspace !== config.workspace) {
        this.pinned = null;
        this.mode = "auto";
      }
      if (config.workspace !== this.config.workspace || config.file !== this.config.file) {
        this.clearSelection();
        this.result = null;
        this.clearResults();
      }
      this.config = config;
      this.configTab = this.tabKey;
      this.render();
      const file = this.file;
      const filterContext = [api.user, workflow?.instanceId, config.workspace, file];
      const sameFile = equal(this.filterContext, filterContext);
      const options = { restoreNamed: restoresNamedWidgets(app) };
      let data, before, after;
      if (this.mode === "canvas") {
        if (!workflow || !root) {
          this.message(t("diff.openAWorkflow"));
          return;
        }
        const saved = workspaceFiles.baseline(workflow);
        this.canvasBase = workflow.originalContent;
        if (!saved) {
          this.message(t("diff.baselineMissing"));
          return;
        }
        const gitStatus = this.scm.workspace === config.workspace ? this.scm.state : null;
        const staged = gitStatus ? gitStatus.staged.some((row) => row.file === file) : sameFile && !!this.result?.staged;
        data = { mode: "canvas", staged };
        before = snapshot(saved, options);
        after = liveSnapshot(app);
      } else {
        if (!config.workspace) {
          this.message(t("workspace.selectInSettings"));
          return;
        }
        if (!workflow && !this.pinned) {
          this.message(t("diff.openAWorkflow"));
          return;
        }
        if (!file) {
          this.message(t("workspace.pathNotRecognized"));
          return;
        }
        data = await request("compare", { workspace: config.workspace, file, mode: this.mode, known: force ? null : this.result?.token });
        if (!stillCurrent()) return;
        if (data.unchanged) return;
        const source = sources[data.mode];
        before = snapshot(data.before === null ? null : parseWorkflow(data.before, t(source.before)), options);
        after = snapshot(data.after === null ? null : parseWorkflow(data.after, t(source.after)), options);
      }
      const changes = compare(before, after, (graph, node) =>
        root && this.sameWorkflow ? namesOnCanvas(app, graph, node) : null);
      const position = sameFile ? this.reviewPosition() : null;
      if (!sameFile) {
        this.scope = ALL_GRAPHS;
        if (this.category !== ISSUES) this.category = "all";
        this.search.value = "";
        this.expandedNodes.clear();
        this.list.scrollTop = 0;
        this.filterContext = filterContext;
      }
      this.clearSelection();
      this.result = { mode: data.mode, staged: data.staged, token: data.token, removed: data.after === null,
        beforeLabel: t(sources[data.mode].before), afterLabel: t(sources[data.mode].after), before, after, changes };
      this.message(changes.length ? "" : t("diff.noChanges"));
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
    this.activePath.textContent = workflow?.fullFilename || native?.split("/").at(-1) || (workflow ? t("workspace.untitled") : t("common.none"));
    this.activePath.title = native || "";
    const association = this.association;
    this.path.textContent = this.file || this.unresolvedPath();
    this.path.title = this.file || "";
    this.bindButton.hidden = !this.config.workspace || !association || this.pinned || !workflow || !this.supported ||
      ["native", "workspace"].includes(association.source);
    this.bindButton.textContent = association?.file ? t("workspace.changeAssociation") : t("workspace.bindFile");
    this.openButton.disabled = !this.config.workspace || !this.supported;
    this.refreshButton.disabled = !this.supported;
    this.modified = workflow?.isModified;
    const mode = this.comparisonMode;
    let count = 0;
    for (const [source, control] of this.sourceButtons) {
      const canvas = source === "canvas";
      control.disabled = !this.supported || (canvas ? !workflow : !this.file);
      control.hidden = source !== mode && (canvas ? !this.modified : source === "staged" && !this.result?.staged);
      control.setAttribute("aria-pressed", String(mode === source));
      if (!control.hidden && !control.disabled) count++;
    }
    this.sourcePicker.hidden = count < 2;
    this.sourceSummary.textContent = t(sources[mode].help);
    this.sourceSummary.hidden = !this.supported || (mode === "canvas" ? !workflow : !this.file);
    this.saveButton.hidden = !this.sameWorkflow || !workspaceFiles.managed(workflow, this.config.workspace);
    this.saveButton.disabled = this.saving === true;
    this.saveButton.textContent = this.saving ? t("common.saving") : t("workspace.save");
    this.results.hidden = (!workflow && !this.pinned) || !this.supported;
  }

  unresolvedPath() {
    if (!this.workflow || !this.supported) return "—";
    if (!this.association) return t("workspace.resolving");
    return this.config.workspace ? t("workspace.unassociated") : t("workspace.notConfigured");
  }

  settings() {
    openWorkspacePicker((path) => request("directories", { path }), async (workspace) => {
      await request("settings", {}, { workspace });
      await this.refresh();
    });
  }

  async chooseFile(open) {
    const workspace = this.config.workspace;
    const workflow = this.workflow;
    const tab = this.tabKey;
    const current = () => this.visible && workspace === this.config.workspace && equal(tab, this.tabKey);
    const files = await request("files", { workspace });
    if (!current()) return;
    if (!files.length) throw new Error(t("workspace.noWorkflows"));
    const select = element("select");
    for (const file of files) {
      const option = element("option", "", file);
      option.value = file;
      select.append(option);
    }
    if (files.includes(this.file)) select.value = this.file;
    formDialog(open ? t("workspace.openRepositoryWorkflow") : t("workspace.associateTab"), t("workspace.relativePath"), select,
      open ? t("workspace.openWorkflow") : t("workspace.associate"), async (file) => {
        if (!current()) throw new Error(t("workspace.contextChanged"));
        if (open) {
          this.opening = true;
          try {
            if (!await workspaceFiles.open(workspace, file, current)) throw new Error(t("workspace.openFailed"));
            this.mode = "auto";
            this.pinned = null;
            this.stamp = this.reviewKey;
            this.graph = app.rootGraphOrUndefined;
            await this.showDiff();
          } finally {
            this.opening = false;
          }
        } else {
          if (workflow.isTemporary) workspaceFiles.bind(workflow, workspace, file);
          else await request("binding", {}, { workspace, file, native: workflow.path });
          await this.refresh();
        }
      }, open ? t("workspace.switchToExistingTab") : t("workspace.associateTabHelp"));
  }

  async saveWorkspace() {
    if (this.saving) return;
    const workflow = this.workflow;
    const workspace = this.config.workspace;
    const current = () => this.visible && this.workflow === workflow && this.config.workspace === workspace;
    this.saving = true;
    this.render();
    try {
      await workspaceFiles.save(workflow, workspace);
      if (current()) {
        if (this.mode === "canvas" && !workflow.isModified) this.mode = "auto";
        await this.refresh({ preserve: true });
        if (current() && !this.status.classList.contains("cd-error")) this.message(t("workspace.saved"));
      }
    } finally {
      this.saving = false;
      this.render();
    }
  }

  async reloadDisk() {
    const workflow = this.workflow;
    if (!this.selected || this.comparisonMode !== "changed" || !this.sameWorkflow) return;
    const workspace = this.config.workspace;
    const association = this.association?.source;
    const context = this.currentContext();
    const workflowState = workflow?.activeState;
    const click = this.click;
    if (workflow?.isModified) throw new Error(t("workspace.saveOrCompare"));
    const { content, version } = await request("file", { workspace, file: this.file });
    if (!this.current(context) || this.click !== click || workflow?.activeState !== workflowState) return;
    if (workflow.isModified) throw new Error(t("workspace.saveOrCompare"));
    const data = parseWorkflow(content, t("version.disk"));
    this.canvas.clear();
    const loaded = await app.loadGraphData(data, true, true, workflow);
    if (!loaded) throw new Error(t("workspace.reloadFailed"));
    if (["native", "workspace"].includes(association)) workflow.originalContent = content;
    workspaceFiles.adoptDisk(workflow, workspace, version);
    if (this.current(context)) await this.refresh();
  }

  renderScopes() {
    const { before, after, changes } = this.result;
    const graphs = new Map([[ALL_GRAPHS, t("diff.allGraphs")], [ROOT, t("diff.rootOnly")]]);
    for (const { graph } of changes) {
      if (!graphs.has(graph)) {
        const path = after.paths.get(graph) ?? before.paths.get(graph);
        graphs.set(graph, t("diff.subgraphScope", { path: path.map(({ name }) => name).join(" › ") }));
      }
    }
    if (!graphs.has(this.scope)) this.scope = ALL_GRAPHS;
    this.scopePicker.replaceChildren();
    const names = Map.groupBy(graphs, ([, label]) => label);
    for (const [value, label] of graphs) {
      const option = element("option", "", label);
      const matching = names.get(label);
      if (matching.length > 1) option.textContent += ` (${matching.findIndex(([key]) => key === value) + 1})`;
      option.value = value;
      this.scopePicker.append(option);
    }
    this.scopePicker.value = this.scope;
  }

  activateCategory(category, focus = false) {
    if (this.category !== category) {
      if (category === ISSUES || this.category === ISSUES) this.clearSelection();
      this.issueStatus.textContent = "";
      this.category = category;
      this.renderResults({ resetScroll: true });
      if (category === ISSUES) this.renderIssueList();
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
    const inScope = (result?.changes ?? []).filter((change) => this.scope === ALL_GRAPHS || change.graph === this.scope);
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
    this.updateResultsBusy();
    const scroll = resetScroll ? 0 : this.list.scrollTop;
    this.providerLabels = [];
    const showingIssues = this.category === ISSUES;
    this.search.hidden = this.scopePicker.hidden = showingIssues;
    this.issueSearch.hidden = !showingIssues;
    this.search.disabled = this.scopePicker.disabled = !result?.changes.length;
    let panel;
    let entries;
    for (const tab of this.tabs) {
      const active = tab.id === this.category;
      tab.control.setAttribute("aria-selected", String(active));
      tab.control.tabIndex = active ? 0 : -1;
      tab.panel.hidden = !active;
      if (tab.id === ISSUES) continue;
      const matches = tab.kinds ? scoped.filter((change) => tab.kinds.includes(change.kind)) : scoped;
      tab.count.textContent = ` ${matches.length}`;
      tab.panel.replaceChildren();
      if (active) {
        panel = tab.panel;
        entries = matches;
      }
    }
    this.rows = [];
    if (this.category === ISSUES) {
      this.list.scrollTop = scroll;
      return;
    }
    if (!entries.includes(selectedChange)) this.clearSelection();
    if (!entries.length) {
      panel.tabIndex = 0;
      if (result?.changes.length) panel.append(element("p", "cd-empty", t("diff.noMatchingChanges")));
      return;
    }
    panel.removeAttribute("tabindex");
    for (const [graph, changes] of Map.groupBy(entries, (change) => change.graph)) {
      const group = element("section", "cd-group");
      const historical = !result.after.paths.has(graph);
      const version = historical ? result.before : result.after;
      const path = version.paths.get(graph) ?? [];
      const heading = element("h3", "", t("common.rootGraph"));
      path.forEach((step, index) => {
        const parent = path[index - 1]?.graph ?? ROOT;
        const node = version.graphs.get(parent).nodes.get(step.id);
        heading.append(` › ${step.name} `, nodeIdButton(step.id, () =>
          this.locateReference({ graph: parent, node, historical, path: path.slice(0, index) })));
      });
      heading.append(element("span", "", t("diff.changeCount", { count: changes.length })));
      group.append(heading);
      for (const nodeChanges of Map.groupBy(changes, (change) => change.node).values()) {
        group.append(this.renderNodeChanges(nodeChanges, result, terms.length > 0));
      }
      panel.append(group);
    }
    this.list.scrollTop = scroll;
    const row = this.rows.find(({ change }) => change === selectedChange);
    if (row) {
      this.selected = row;
      row.control.setAttribute("aria-pressed", "true");
    }
    this.updateProviders();
  }

  updateIssues(tabChanged) {
    const issues = collectIssues(this.workflow, app.rootGraphOrUndefined, app.extensionManager);
    if (!tabChanged && equal(issues, this.issues)) return;
    this.issues = issues;
    this.issueTab.count.textContent = ` ${issues.length}`;
    if (this.category === ISSUES) this.renderIssueList();
  }

  renderIssueList() {
    const terms = this.issueSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const issues = searchIssues(this.issues, terms);
    const panel = this.issueTab.panel;
    panel.replaceChildren(this.issueStatus);
    panel.tabIndex = 0;
    if (!issues.length) {
      const hasIssues = this.issues.length > 0;
      const empty = element("p", "cd-issues-empty", hasIssues ? t("issue.noMatches") : t("issue.empty"));
      if (!hasIssues) empty.prepend(icon("check-circle"));
      panel.append(empty);
      return;
    }
    const groups = element("div", "cd-issue-groups");
    for (const [id, category] of Object.entries(issueCategories)) {
      const entries = issues.filter((issue) => issue.group === id);
      if (!entries.length) continue;
      const group = element("details", "cd-issue-group");
      group.dataset.kind = id;
      const header = element("summary", "cd-issue-group-heading");
      header.append(icon(category.icon), element("span", "", t(category.label)),
        element("span", "cd-issue-count", entries.length), icon("chevron-right"));
      group.append(header);
      const addRows = () => {
        if (group.childElementCount > 1) return;
        for (const issue of entries) {
          group.append(issue.targets ? this.renderGroupedIssue(issue, !!terms.length) : this.renderIssue(issue, category));
        }
      };
      group.open = terms.length > 0 || (this.issueGroupOpen.get(id) ?? entries.length <= MAX_EXPANDED_ISSUES);
      let open = group.open;
      if (group.open) addRows();
      group.ontoggle = () => {
        if (!group.isConnected) return;
        if (!terms.length && group.open !== open) this.issueGroupOpen.set(id, group.open);
        open = group.open;
        if (group.open) addRows();
      };
      groups.append(group);
    }
    panel.append(groups);
  }

  renderGroupedIssue(issue, searching) {
    const entry = element("details", "cd-issue-entry");
    const header = element("summary", "cd-issue-entry-heading");
    const title = element("div", "cd-issue-entry-title");
    title.append(issue.group === "model" ? issueFile(issue.message) : element("strong", "", issue.message));
    if (issue.directory) title.append(element("span", "cd-issue-detail", issue.directory));
    const affected = issue.targets.filter(({ id }) => id).length;
    const qualifier = affected === issue.targets.length ? "issue.affectedNodes" : "issue.knownNodes";
    const count = affected ? t(qualifier, { count: affected }) : t("issue.unknownCount");
    header.append(title, element("span", "cd-issue-affected", count), icon("chevron-right"));
    entry.append(header);
    const addTargets = () => {
      if (entry.childElementCount > 1) return;
      for (const target of issue.matchingTargets ?? issue.targets) {
        const row = element("div", "cd-entry cd-issue cd-issue-target");
        const content = element("div", "cd-issue-content");
        const name = target.node || (target.id ? "" : t("issue.unknownNode"));
        content.append(issueNodeTitle(name, target.id, () => this.locateIssue(target.id)));
        if (!target.id) content.append(element("span", "cd-issue-detail", t("issue.noNodeId")));
        if (target.details.length) content.append(element("code", "cd-issue-field", target.details.join(" · ")));
        row.append(content);
        if (target.canLocate) row.append(this.rowLocator(t("canvas.locateNode", { id: target.id }), () => this.locateIssue(target.id)));
        entry.append(row);
      }
    };
    entry.open = issue.openMatches || this.issueItemOpen.has(issue.key);
    let open = entry.open;
    if (open) addTargets();
    entry.ontoggle = () => {
      if (!entry.isConnected) return;
      if (!searching && entry.open !== open) {
        if (entry.open) this.issueItemOpen.add(issue.key);
        else this.issueItemOpen.delete(issue.key);
      }
      open = entry.open;
      if (open) addTargets();
    };
    return entry;
  }

  renderIssue(issue, category) {
    const row = element("div", "cd-entry cd-issue");
    const content = element("div", "cd-issue-content");
    const title = issueNodeTitle(issue.node, issue.id, () => this.locateIssue(issue.id));
    if (title.hasChildNodes()) content.append(title);
    if (category.resource) {
      content.append(issueFile(issue.message));
    } else if (issue.message !== issue.node) {
      content.append(element("p", "cd-issue-message", issue.message));
    }
    if (issue.detail && issue.group === "validation") {
      const detail = element("details", "cd-issue-detail");
      detail.append(element("summary", "", t("common.detail")), element("p", "cd-issue-message", issue.detail));
      content.append(detail);
    } else if (issue.detail) {
      content.append(element("code", "cd-issue-field", issue.detail));
    }
    row.append(content);
    if (issue.canLocate) {
      row.append(this.rowLocator(t("canvas.locate"), () => this.locateIssue(issue.id)));
    }
    return row;
  }

  async locateIssue(id) {
    if (!this.visible || this.category !== ISSUES || !equal(this.stamp, this.reviewKey) ||
      this.graph !== app.rootGraphOrUndefined) return;
    const context = this.currentContext();
    this.issueStatus.textContent = "";
    try {
      await this.canvas.locateIssue(id);
    } catch (error) {
      if (this.current(context) && this.category === ISSUES) this.issueStatus.textContent = errorText(error);
    }
  }

  updateProviders() {
    for (const { node, label } of this.providerLabels) {
      const info = nodeIdentity.identify(node);
      label.hidden = !info;
      label.textContent = info?.label ?? "";
      label.title = [info?.detail, ...(info?.candidates ?? [])].filter(Boolean).join("\n");
    }
  }

  providerLabel(node) {
    const label = element("span", "cd-node-provider");
    this.providerLabels.push({ node, label });
    return label;
  }

  renderNodeChanges(changes, result, searching) {
    const first = changes[0];
    if (changes.length === 1) {
      const row = this.renderChange(first, result);
      this.rows.push(row);
      return row.container;
    }
    const node = first.after ?? first.before;
    const group = element("details", "cd-node-changes");
    const header = element("summary", "cd-node-changes-heading");
    const title = element("div", "cd-row-copy");
    const name = element("span", "cd-node-changes-title");
    const nodeName = changeNodeName(first, result);
    name.title = nodeName;
    name.append(element("strong", "", nodeName));
    if (!node.raw.boundary) {
      name.append(" ", nodeIdButton(first.node, () =>
        this.locateReference({ graph: first.graph, node }), "cd-node-id"));
    }
    title.append(name, this.providerLabel(node));
    const count = element("span", "cd-node-changes-count", t("diff.changeCount", { count: changes.length }));
    count.title = t("diff.changeCountTitle", { count: changes.length });
    header.append(icon("chevron-right"), title, count);
    const children = element("div", "cd-node-change-children");
    group.append(header, children);
    for (const change of changes) {
      const row = this.renderChange(change, result, group);
      this.rows.push(row);
      children.append(row.container);
    }
    const key = JSON.stringify([first.graph, first.node]);
    group.open = searching || this.expandedNodes.has(key) || changes.includes(this.selected?.change);
    let open = group.open;
    group.ontoggle = () => {
      if (!group.isConnected || open === group.open) return;
      open = group.open;
      if (!searching) {
        if (open) this.expandedNodes.add(key);
        else this.expandedNodes.delete(key);
      }
      if (!open && this.selected?.group === group) this.clearSelection();
    };
    return group;
  }

  renderChange(change, result, group) {
    const detail = description(change, result);
    const container = element("div", group ? "cd-entry cd-node-change" : "cd-entry");
    const control = button("", () => this.selectRow(row), "cd-change-select");
    const content = element("div", "cd-change");
    const label = change.kind === "deleted" ? t("canvas.locateDeletion") : t("canvas.locate");
    const select = () => {
      if (this.selected !== row) this.selectRow(row);
    };
    const locator = this.rowLocator(label, () => {
      select();
      void this.locate();
    });
    const row = { change, detail, control, container, locator, group };
    control.setAttribute("aria-pressed", "false");
    const symbol = element("span", `cd-change-symbol cd-${detail.color ?? "yellow"}`,
      detail.color === "green" ? "+" : detail.color === "red" ? "−" : "↔");
    symbol.setAttribute("aria-hidden", "true");
    const { from, to } = change;
    const values = [detail.a, detail.b];
    const hasDelta = values.every((value) => value !== undefined);
    const delta = element("span", group ? "cd-node-change-delta" : "cd-kind");
    if (hasDelta) {
      [from, to].forEach((source, index) => {
        if (index) delta.append(element("span", "cd-node-change-arrow", " → "));
        const value = element("span", group ? index ? "cd-new" : "cd-old" : "");
        this.appendValue(value, values[index], source, change, index === 0, {
          compact: from?.kind === "link" && to?.kind === "link",
          short: true,
          select,
        });
        delta.append(value);
      });
    }
    control.setAttribute("aria-label", [detail.node, detail.label, hasDelta ? values.join(" → ") : detail.summary]
      .filter(Boolean).map(preview).join(" · "));
    if (group) {
      const field = element("strong", "cd-node-change-field", detail.field ?? detail.label);
      field.title = detail.field ? `${detail.field} · ${detail.label}` : detail.label;
      delta.title = hasDelta ? values.map(String).join(" → ") : detail.label;
      content.append(symbol, field, delta);
    } else {
      const copy = element("span", "cd-row-copy");
      const node = change.after ?? change.before;
      if (!hasDelta) delta.textContent = detail.summary ?? detail.label;
      copy.append(element("strong", "", detail.node), delta, this.providerLabel(node));
      const inRemovedGraph = !result.after.paths.has(change.graph);
      content.append(symbol, copy, node.raw.boundary ? element("span", "cd-node-id", detail.label) :
        nodeIdButton(change.node, () => {
          select();
          if (change.kind === "deleted") void this.locate(inRemovedGraph);
          else void this.locateReference({ graph: change.graph, node });
        }, "cd-node-id"));
    }
    container.append(control, content, locator);
    return row;
  }

  appendValue(target, value, source, change, historical, { compact, short, select } = {}) {
    if (source?.kind !== "link") {
      target.append(short ? preview(value) : value);
      return;
    }
    appendEndpoint(target, source.edge.source, source.edge.out, false, (node) => {
      select?.();
      this.locateReference({ graph: change.graph, node, historical });
    }, undefined, compact);
  }

  rowLocator(label, action) {
    const locator = iconButton("map-marker", label, action);
    locator.classList.add("cd-row-locate");
    return locator;
  }

  selectRow(row) {
    if (this.selected === row) {
      this.clearSelection();
      return;
    }
    this.clearLocation();
    if (row.group) row.group.open = true;
    this.selected?.control.setAttribute("aria-pressed", "false");
    this.selected = row;
    row.control.setAttribute("aria-pressed", "true");
    if (this.sameWorkflow && !this.result.removed && app.rootGraphOrUndefined) this.canvas.highlight(row.change, this.result);
    const heading = element("div", "cd-inspector-heading");
    heading.append(element("strong", "", row.detail.node), element("span", "", row.detail.label));
    this.detailContent.replaceChildren(heading, this.renderDetails(row.change, this.result, row.detail));
    this.detailBody.scrollTop = 0;
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

  renderDetails(change, result, row) {
    const content = document.createDocumentFragment();
    if (row.a !== undefined || row.b !== undefined) {
      const delta = element("dl", "cd-delta");
      for (const [label, value, color, source] of [
        ["− " + this.result.beforeLabel, row.a, "old", change.from],
        ["+ " + this.result.afterLabel, row.b, "new", change.to],
      ]) {
        if (value === undefined) continue;
        const pair = element("div", `cd-${color}`);
        const entry = element("dd");
        this.appendValue(entry, value, source, change, color === "old");
        pair.append(element("dt", "", label), entry);
        delta.append(pair);
      }
      content.append(delta);
    } else if (change.kind === "added") {
      content.append(element("p", "cd-node-summary", row.summary));
    }
    if (change.kind === "deleted") {
      const canOpen = result.before.graphs.has(change.before.type) ||
        (change.graph !== ROOT && !result.after.paths.has(change.graph));
      content.append(deletedDetails(change, result, canOpen, () => this.locate(true),
        (node) => this.locateReference({ graph: change.graph, node, historical: true })));
    }
    return content;
  }

  locateReference(reference) {
    return this.runLocation(async () => {
      if (!this.sameWorkflow || this.result.removed) return this.canvas.previewNode(reference, this.result);
      try {
        return await this.canvas.locateNode(reference, this.result);
      } catch (error) {
        if (this.comparisonMode !== "staged") throw error;
        return this.canvas.previewNode(reference, this.result);
      }
    }, false);
  }

  locate(openOld = false) {
    if (!this.selected || !this.visible) return;
    return this.runLocation(async () => {
      const { change } = this.selected;
      if (!this.sameWorkflow || this.result.removed) return this.canvas.previewChange(change, this.result);
      try {
        return await this.canvas.locate(change, this.result, openOld);
      } catch (error) {
        if (this.comparisonMode !== "staged") throw error;
        return this.canvas.previewChange(change, this.result);
      }
    }, true);
  }

  async runLocation(action, canRecover) {
    if (!this.visible || !this.result || !equal(this.stamp, this.reviewKey) ||
      this.graph !== app.rootGraphOrUndefined) return;
    const result = this.result;
    const context = this.currentContext();
    const click = Symbol();
    this.click = click;
    this.showLocateStatus();
    try {
      const note = await action();
      if (this.click !== click || !this.current(context) || this.result !== result) return;
      if (note !== undefined) {
        if (this.selected) this.showLocateStatus(note || t("canvas.located"));
        else this.message("");
      }
    } catch (error) {
      if (this.click !== click || !this.current(context) || this.result !== result) return;
      const hadFocus = document.activeElement === this.selected?.locator;
      if (this.selected) this.showLocateStatus(errorText(error), true, canRecover);
      else this.message(errorText(error), true);
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
    setLocale(app.extensionManager.setting.get("Comfy.Locale"));
    document.head.append(style);
    let sidebar;
    app.extensionManager.registerSidebarTab({
      id: TAB,
      icon: "pi pi-code",
      title: t("diff.title"),
      tooltip: t("diff.tabTooltip"),
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
        if (sidebar) {
          sidebar.wasVisible = false;
          sidebar.scmTab = null;
        }
      },
    });
    setInterval(() => sidebar?.tick(), 300);
  },
});
