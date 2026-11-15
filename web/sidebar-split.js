import { element } from "./graph-view.js";

export function createSidebarSplit(panes, inspector) {
  const handle = element("div", "cd-split");
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "horizontal");
  handle.setAttribute("aria-label", "调整差异详情高度");
  handle.setAttribute("aria-controls", inspector.id);
  handle.title = "上下拖动，或用方向键调整详情高度";

  function updateValue() {
    if (inspector.hidden || !panes.clientHeight) return;
    const percent = Math.round(100 * inspector.offsetHeight / panes.clientHeight);
    handle.setAttribute("aria-valuenow", String(percent));
    handle.setAttribute("aria-valuetext", `详情占列表和详情区域的 ${percent}%`);
  }

  function resize(height) {
    if (!panes.clientHeight) return;
    const percent = Math.max(0, Math.min(100, 100 * height / panes.clientHeight));
    panes.style.setProperty("--cd-details-size", `${percent}%`);
  }

  let drag;
  handle.onpointerdown = (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, y: event.clientY, height: inspector.offsetHeight };
  };
  handle.onpointermove = (event) => {
    if (event.pointerId === drag?.pointer) resize(drag.height + drag.y - event.clientY);
  };
  handle.onlostpointercapture = (event) => {
    if (event.pointerId === drag?.pointer) drag = null;
  };
  handle.onkeydown = (event) => {
    const step = event.shiftKey ? 48 : 16;
    const height = inspector.offsetHeight;
    const sizes = { ArrowUp: height + step, ArrowDown: height - step, Home: 0, End: panes.clientHeight };
    if (!Object.hasOwn(sizes, event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    resize(sizes[event.key]);
  };

  const observer = new ResizeObserver(updateValue);
  observer.observe(panes);
  observer.observe(inspector);
  return handle;
}
