import { element } from "./graph-view.js";
import { t } from "./i18n.js";

export function openWorkspacePicker(load, saveWorkspace) {
  const dialog = element("dialog", "comfydiff-form cd-workspace-picker");
  const title = element("h3", "", t("workspace.select"));
  title.tabIndex = -1;
  title.autofocus = true;
  dialog.setAttribute("aria-label", title.textContent);
  const help = element("p", "cd-form-help", t("workspace.selectHelp"));
  const location = element("code", "cd-directory-path");
  location.tabIndex = -1;
  const up = element("button", "", t("workspace.parentFolder"));
  const toolbar = element("div", "cd-directory-toolbar");
  toolbar.append(up, location);
  const list = element("ul", "cd-directories");
  list.setAttribute("aria-label", t("workspace.folders"));
  const status = element("p", "cd-form-help cd-directory-status");
  status.setAttribute("role", "status");
  const error = element("p", "cd-error");
  error.setAttribute("role", "alert");
  const cancel = element("button", "", t("common.cancel"));
  const save = element("button", "cd-primary", t("workspace.selectFolder"));
  const actions = element("div", "cd-actions");
  actions.append(cancel, save);
  dialog.append(title, help, toolbar, list, status, error, actions);

  let current;
  let pending;
  async function run(action, message, operation) {
    pending = action;
    up.disabled = save.disabled = list.inert = true;
    cancel.disabled = action === "save";
    status.textContent = message;
    error.textContent = "";
    try {
      await operation();
    } catch (failure) {
      if (dialog.open) error.textContent = failure.message || t("workspace.actionFailed");
    } finally {
      pending = null;
      if (dialog.open) {
        up.disabled = current?.parent == null;
        save.disabled = !current?.path;
        cancel.disabled = list.inert = false;
        status.textContent = current?.folders.length === 0 ? t("workspace.noSubfolders") : "";
        if (action === "save") save.focus();
      }
    }
  }

  function browse(path) {
    return run("browse", t("workspace.readingFolders"), async () => {
      const directory = await load(path);
      if (!dialog.open) return;
      current = directory;
      location.textContent = directory.path ?? t("workspace.drives");
      const entries = document.createDocumentFragment();
      for (const folder of directory.folders) {
        const entry = element("li");
        const open = element("button", "", folder.name);
        const icon = element("i", "pi pi-folder");
        icon.setAttribute("aria-hidden", "true");
        open.prepend(icon);
        open.onclick = () => browse(folder.path);
        entry.append(open);
        entries.append(entry);
      }
      list.replaceChildren(entries);
      list.scrollTop = 0;
      if (path != null) location.focus();
    });
  }

  up.onclick = () => browse(current.parent);
  save.onclick = () => run("save", t("common.saving"), async () => {
    await saveWorkspace(current.path);
    dialog.close();
  });
  cancel.onclick = () => dialog.close();
  dialog.oncancel = (event) => {
    if (pending === "save") event.preventDefault();
  };
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  browse();
}
