import { element } from "./graph-view.js";
import { t } from "./i18n.js";

function button(label, action, className) {
  const control = element("button", className, label);
  control.type = "button";
  control.onclick = action;
  return control;
}

const fileStates = { A: "scm.added", M: "scm.modified", D: "scm.deleted", T: "scm.typeChanged", U: "scm.untracked", "!": "scm.conflict" };

export class SourceControl {
  constructor(request, { open, settings, currentWorkflow }) {
    this.request = request;
    this.open = open;
    this.root = element("section", "cd-scm");
    this.root.hidden = true;
    this.root.setAttribute("aria-label", t("scm.title"));
    this.branch = element("code");
    const header = element("header", "cd-header");
    header.append(element("h2", "", t("scm.title")), this.branch);
    const tools = element("div", "cd-scm-tools");
    this.currentButton = button(t("scm.currentWorkflow"), currentWorkflow);
    this.refreshButton = button(t("scm.refresh"), () => this.refresh(true));
    tools.append(this.currentButton, this.refreshButton, button(t("workspace.settings"), settings));
    this.message = element("p", "cd-scm-message");
    this.message.setAttribute("role", "status");
    this.composer = element("form", "cd-scm-composer");
    this.input = element("textarea");
    this.input.rows = 2;
    this.input.placeholder = t("scm.commitMessage");
    this.input.setAttribute("aria-label", t("scm.commitMessage"));
    this.input.oninput = () => this.updateControls();
    this.commitButton = element("button", "cd-primary", t("scm.commit"));
    this.commitButton.type = "submit";
    this.composer.onsubmit = (event) => {
      event.preventDefault();
      if (this.commitButton.disabled) return;
      const expected = this.state.commitToken;
      this.perform(t("scm.committing"), async (workspace) => {
        const state = await this.request("commit", {}, { workspace, expected, message: this.input.value.trim() });
        if (workspace !== this.workspace) return;
        this.input.value = "";
        this.updateState(state);
        return state.head ? t("scm.committedHash", { hash: state.head.slice(0, 7) }) : t("scm.committed");
      });
    };
    this.composer.append(this.input, this.commitButton);
    const groups = [
      ["staged", "scm.staged", "scm.stagedFiles"],
      ["changed", "scm.changes", "scm.changedFiles"],
      ["canvas", "scm.unsaved", "scm.canvasFiles"],
    ];
    this.groups = new Map(groups.map(([key, title, files]) => {
      const group = element("details", "cd-scm-group");
      group.open = true;
      group.dataset.group = key;
      const summary = element("summary", "", t(title));
      const count = element("span", "cd-tab-count");
      summary.append(count);
      const list = element("ul");
      list.setAttribute("aria-label", t(files));
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
      this.setMessage(workspace ? "" : t("scm.selectWorkspace"));
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
    if (announce) this.setMessage(t("scm.readingStatus"), "pending");
    this.nextRead = Date.now() + 2500;
    this.updateControls();
    try {
      const state = await this.request("status", { workspace });
      if (this.pendingRead !== ticket) return;
      const previous = this.readError ?? this.state?.blocked;
      this.readError = null;
      this.updateState(state);
      if (state.blocked) this.setMessage(state.blocked, "error");
      else if (manual) this.setMessage(t("scm.refreshed"), "success");
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
    this.branch.textContent = state?.branch === "(detached)" ? t("scm.detached") : state?.branch ?? "";
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
    const pending = t(mode === "staged" || code === "D" ? "scm.readingDiff" : "scm.openingFile", { file });
    const label = isWorkflow && code !== "!" ?
      button(file, () => this.perform(pending, () => this.open(row, mode)), "cd-scm-file-name") :
      element("span", "cd-scm-file-name", file);
    label.title = file;
    const state = element("span", "cd-scm-state", mode === "canvas" ? t("scm.unsaved") : code);
    state.title = fileStates[code] ? t(fileStates[code]) : state.textContent;
    item.append(label, state);
    if (mode !== "canvas") {
      const stage = mode === "changed";
      const description = t(stage ? "scm.stage" : "scm.unstage");
      const control = button(stage ? "+" : "−", () => this.perform(t(stage ? "scm.stagingFile" : "scm.unstagingFile", { file }), async (workspace) => {
        const next = await this.request(stage ? "stage" : "unstage", {}, { workspace, file });
        if (workspace !== this.workspace) return;
        this.updateState(next);
        const destination = this.groups.get(stage ? "staged" : "changed").group;
        destination.open = true;
        const name = Array.from(destination.querySelectorAll("button.cd-scm-file-name")).find((entry) => entry.title === file);
        (name ?? destination.querySelector("summary")).focus({ preventScroll: true });
        return t(stage ? "scm.stagedFile" : "scm.unstagedFile", { file });
      }), "cd-scm-index");
      control.title = description;
      control.setAttribute("aria-label", t(stage ? "scm.stageFile" : "scm.unstageFile", { file }));
      item.append(control);
    }
    return item;
  }

  updateControls() {
    const blocked = this.busy || !!this.state?.blocked;
    this.refreshButton.disabled = !this.workspace || !!this.pendingRead || !!this.busy;
    this.input.disabled = this.busy === true;
    this.commitButton.textContent = this.state?.staged.length ? t("scm.commitCount", { count: this.state.staged.length }) : t("scm.commit");
    this.commitButton.disabled = blocked || !this.state?.staged.length || !this.input.value.trim();
    for (const control of this.root.querySelectorAll(".cd-scm-index")) control.disabled = blocked;
    for (const control of this.root.querySelectorAll("button.cd-scm-file-name")) control.disabled = !!this.busy;
  }
}
