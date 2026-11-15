import { element } from "./graph-view.js";

function button(label, action, className) {
  const control = element("button", className, label);
  control.type = "button";
  control.onclick = action;
  return control;
}

const fileStates = { A: "新增", M: "已修改", D: "已删除", T: "类型变化", U: "未跟踪", "!": "有冲突" };

export class SourceControl {
  constructor(request, { open, settings, currentWorkflow }) {
    this.request = request;
    this.open = open;
    this.root = element("section", "cd-scm");
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "源代码管理");
    this.branch = element("code");
    const header = element("header", "cd-header");
    header.append(element("h2", "", "源代码管理"), this.branch);
    const tools = element("div", "cd-scm-tools");
    this.currentButton = button("当前工作流", currentWorkflow);
    this.refreshButton = button("刷新", () => this.refresh(true));
    tools.append(this.currentButton, this.refreshButton, button("Git 工作区设置", settings));
    this.message = element("p", "cd-scm-message");
    this.message.setAttribute("role", "status");
    this.composer = element("form", "cd-scm-composer");
    this.input = element("textarea");
    this.input.rows = 2;
    this.input.placeholder = "提交说明";
    this.input.setAttribute("aria-label", "提交说明");
    this.input.oninput = () => this.updateControls();
    this.commitButton = element("button", "cd-primary", "提交");
    this.commitButton.type = "submit";
    this.composer.onsubmit = (event) => {
      event.preventDefault();
      if (this.commitButton.disabled) return;
      const expected = this.state.commitToken;
      this.perform("正在提交…", async (workspace) => {
        const state = await this.request("commit", {}, { workspace, expected, message: this.input.value.trim() });
        if (workspace !== this.workspace) return;
        this.input.value = "";
        this.updateState(state);
        return state.head ? "已提交 " + state.head.slice(0, 7) : "已提交。";
      });
    };
    this.composer.append(this.input, this.commitButton);
    this.groups = new Map([["staged", "已暂存"], ["changed", "更改"], ["canvas", "未保存"]].map(([key, title]) => {
      const group = element("details", "cd-scm-group");
      group.open = true;
      group.dataset.group = key;
      const summary = element("summary", "", title);
      const count = element("span", "cd-tab-count");
      summary.append(count);
      const list = element("ul");
      list.setAttribute("aria-label", title + "的文件");
      group.append(summary, list);
      return [key, { group, count, list }];
    }));
    const changes = element("div", "cd-scm-changes");
    changes.append(...[...this.groups.values()].map(({ group }) => group));
    this.root.append(header, tools, this.message, this.composer, changes);
  }

  configure(workspace, unsaved, hasWorkflow) {
    if (workspace !== this.workspace) {
      this.workspace = workspace;
      this.pendingRead = null;
      this.nextRead = 0;
      this.readError = null;
      this.input.value = "";
      this.setMessage(workspace ? "" : "请先选择 Git 工作区。");
      this.updateState(null);
    }
    this.currentButton.hidden = !hasWorkflow;
    this.updateGroup("canvas", unsaved);
  }

  show() {
    this.root.hidden = false;
    this.refresh();
  }

  tick() {
    if (!this.root.hidden && Date.now() >= this.nextRead) this.refresh();
  }

  setMessage(text, tone = "") {
    this.message.textContent = text;
    this.message.dataset.tone = tone;
  }

  async refresh(manual = false) {
    if (!this.workspace || this.pendingRead || this.busy) return;
    const workspace = this.workspace;
    const ticket = this.pendingRead = Symbol();
    const announce = manual || !this.state;
    if (announce) this.setMessage("正在读取 Git 状态…", "pending");
    this.nextRead = Date.now() + 2500;
    this.updateControls();
    try {
      const state = await this.request("status", { workspace });
      if (this.pendingRead !== ticket) return;
      const previous = this.readError ?? this.state?.blocked;
      this.readError = null;
      this.updateState(state);
      if (state.blocked) this.setMessage(state.blocked, "error");
      else if (manual) this.setMessage("已刷新 Git 状态。", "success");
      else if (announce || this.message.textContent === previous) this.setMessage("");
    } catch (error) {
      if (this.pendingRead !== ticket) return;
      this.readError = error.message;
      this.setMessage(this.readError, "error");
    } finally {
      if (this.pendingRead === ticket) {
        this.pendingRead = null;
        this.updateControls();
      }
    }
  }

  async perform(pending, action) {
    if (this.busy) return;
    const workspace = this.workspace;
    this.busy = true;
    this.pendingRead = null;
    this.setMessage(pending, "pending");
    this.updateControls();
    try {
      const success = await action(workspace);
      if (workspace === this.workspace) this.setMessage(success ?? "", success ? "success" : "");
    } catch (error) {
      if (workspace === this.workspace) this.setMessage(error.message, "error");
    } finally {
      this.busy = false;
      this.nextRead = 0;
      this.updateControls();
    }
  }

  updateState(state) {
    this.state = state;
    this.branch.textContent = state?.branch === "(detached)" ? "分离 HEAD" : state?.branch ?? "";
    this.composer.hidden = !this.workspace;
    this.updateGroup("staged", state?.staged ?? []);
    this.updateGroup("changed", state?.changed ?? []);
    this.updateControls();
  }

  updateGroup(mode, rows) {
    const view = this.groups.get(mode);
    view.group.hidden = mode === "canvas" ? rows.length === 0 : !this.workspace;
    const signature = JSON.stringify(rows.map(({ file, code, workflow }) => [file, code, workflow?.instanceId]));
    if (view.signature === signature) return;
    view.signature = signature;
    view.count.textContent = " " + rows.length;
    view.list.replaceChildren(...rows.map((row) => this.renderRow(row, mode)));
  }

  renderRow(row, mode) {
    const { file, code } = row;
    const item = element("li", "cd-scm-file");
    const isWorkflow = mode === "canvas" || /\.json$/i.test(file);
    const pending = mode === "staged" || code === "D" ? "正在查看 " + file + " 的差异…" : "正在打开 " + file + "…";
    const label = isWorkflow && code !== "!" ?
      button(file, () => this.perform(pending, () => this.open(row, mode)), "cd-scm-file-name") :
      element("span", "cd-scm-file-name", file);
    label.title = file;
    const state = element("span", "cd-scm-state", mode === "canvas" ? "未保存" : code);
    state.title = fileStates[code] ?? state.textContent;
    item.append(label, state);
    if (mode !== "canvas") {
      const stage = mode === "changed";
      const description = stage ? "暂存" : "取消暂存";
      const control = button(stage ? "+" : "−", () => this.perform("正在" + description + " " + file + "…", async (workspace) => {
        const next = await this.request(stage ? "stage" : "unstage", {}, { workspace, file });
        if (workspace !== this.workspace) return;
        this.updateState(next);
        const destination = this.groups.get(stage ? "staged" : "changed").group;
        destination.open = true;
        const name = Array.from(destination.querySelectorAll("button.cd-scm-file-name")).find((entry) => entry.title === file);
        (name ?? destination.querySelector("summary")).focus({ preventScroll: true });
        return "已" + description + " " + file;
      }), "cd-scm-index");
      control.title = description;
      control.setAttribute("aria-label", description + " " + file);
      item.append(control);
    }
    return item;
  }

  updateControls() {
    const blocked = this.busy || !!this.state?.blocked;
    this.refreshButton.disabled = !this.workspace || !!this.pendingRead || !!this.busy;
    this.input.disabled = this.busy === true;
    this.commitButton.textContent = this.state?.staged.length ? "提交（" + this.state.staged.length + "）" : "提交";
    this.commitButton.disabled = blocked || !this.state?.staged.length || !this.input.value.trim();
    for (const control of this.root.querySelectorAll(".cd-scm-index")) control.disabled = blocked;
    for (const control of this.root.querySelectorAll("button.cd-scm-file-name")) control.disabled = !!this.busy;
  }
}
