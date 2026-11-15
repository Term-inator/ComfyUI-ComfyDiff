import { element } from "./graph-view.js";

export function openWorkspacePicker(load, saveWorkspace) {
  const dialog = element("dialog", "comfydiff-form cd-workspace-picker");
  const title = element("h3", "", "选择 Git 工作区");
  title.tabIndex = -1;
  title.autofocus = true;
  dialog.setAttribute("aria-label", title.textContent);
  const help = element("p", "cd-form-help", "请选择 ComfyUI 服务器上的 Git 工作区根目录。");
  const location = element("code", "cd-directory-path");
  location.tabIndex = -1;
  const up = element("button", "", "上一级");
  const toolbar = element("div", "cd-directory-toolbar");
  toolbar.append(up, location);
  const list = element("ul", "cd-directories");
  list.setAttribute("aria-label", "文件夹");
  const status = element("p", "cd-form-help cd-directory-status");
  status.setAttribute("role", "status");
  const error = element("p", "cd-error");
  error.setAttribute("role", "alert");
  const cancel = element("button", "", "取消");
  const save = element("button", "cd-primary", "选择此文件夹");
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
      if (dialog.open) error.textContent = failure.message || "操作失败，请重试。";
    } finally {
      pending = null;
      if (dialog.open) {
        up.disabled = current?.parent == null;
        save.disabled = !current?.path;
        cancel.disabled = list.inert = false;
        status.textContent = current?.folders.length === 0 ? "没有子文件夹。" : "";
        if (action === "save") save.focus();
      }
    }
  }

  function browse(path) {
    return run("browse", "正在读取文件夹…", async () => {
      const directory = await load(path);
      if (!dialog.open) return;
      current = directory;
      location.textContent = directory.path ?? "磁盘";
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
  save.onclick = () => run("save", "正在保存…", async () => {
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
