import { nodeLabel, widgetSlots } from "./diff.js";
import { bounds, element } from "./graph-view.js";

export function createGhostLayer(canvas) {
  const host = canvas.canvas.closest(".graph-canvas-container");
  const layer = element("div", "cd-ghost-layer");
  host.append(layer);
  const cards = new Map();

  function sync() {
    const [left, top] = canvas.ds.convertOffsetToCanvas([0, 0]);
    layer.style.transform = `translate(${left}px, ${top}px) scale(${canvas.ds.scale})`;
  }

  return {
    add(node, snapshot, { openSubgraph, selected, redraw }) {
      const [x, y, width] = bounds(node);
      const card = element("section", "cd-ghost-node");
      card.dataset.cdOldNode = node.id;
      card.tabIndex = 0;
      Object.assign(card.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(width, 190)}px` });
      const title = element("header", "cd-ghost-title");
      const toggle = element("button", "cd-ghost-toggle", "▾");
      toggle.type = "button";
      toggle.setAttribute("aria-label", "旧参数");
      title.append(element("span", "", `− ${nodeLabel(node, snapshot)}`), toggle);
      const ports = element("div", "cd-ghost-ports");
      const dots = new Map();
      for (const [side, entries] of [["in", node.inputs], ["out", node.outputs]]) {
        const column = element("div");
        for (const port of entries) {
          const label = port.label || port.name || `${side === "in" ? "输入" : "输出"} ${port.index + 1}`;
          const row = element("div", `cd-ghost-slot cd-ghost-${side}`, label);
          const dot = element("span", "cd-ghost-dot");
          dot.dataset.cdOldSlot = `${side}-${port.index}`;
          row.append(dot);
          column.append(row);
          dots.set(`${side}:${port.key}`, dot);
        }
        ports.append(column);
      }
      const params = element("div", "cd-ghost-params");
      const values = widgetSlots(node);
      if (!values.size) params.append(element("p", "", "没有保存的参数"));
      for (const [index, value] of [...values.values()].entries()) {
        const field = element("div", "cd-ghost-field");
        field.append(element("span", "", value.name || `参数 ${index + 1}`),
          element("pre", "", typeof value.value === "string" ? value.value : JSON.stringify(value.value)));
        params.append(field);
      }
      const expand = (expanded) => {
        params.hidden = !expanded;
        toggle.textContent = expanded ? "▾" : "▸";
        toggle.setAttribute("aria-expanded", String(expanded));
      };
      expand(selected);
      toggle.onclick = () => expand(params.hidden);
      card.append(title, ports, params);
      if (openSubgraph) {
        const button = element("button", "cd-ghost-button", "查看已删除子图");
        button.type = "button";
        button.onclick = openSubgraph;
        card.append(button);
      }
      let drag;
      title.onpointerdown = (event) => {
        if (event.button !== 0 || event.target.closest("button")) return;
        card.focus({ preventScroll: true });
        title.setPointerCapture(event.pointerId);
        drag = { x: event.clientX, y: event.clientY, left: card.offsetLeft, top: card.offsetTop };
      };
      title.onpointermove = (event) => {
        if (!drag) return;
        const scale = canvas.ds.scale;
        card.style.left = `${drag.left + (event.clientX - drag.x) / scale}px`;
        card.style.top = `${drag.top + (event.clientY - drag.y) / scale}px`;
        redraw();
      };
      title.onlostpointercapture = () => { drag = null; };
      card.onkeydown = (event) => {
        if (event.key !== "Escape") event.stopPropagation();
      };
      layer.append(card);
      cards.set(node.id, dots);
      return card;
    },
    position(node, port, input) {
      const dot = cards.get(node.id)?.get(`${input ? "in" : "out"}:${port.key}`);
      if (!dot) return null;
      return canvasPoint(canvas, dot, false);
    },
    sync,
    remove: () => layer.remove(),
  };
}

export function canvasPoint(canvas, element, leftEdge) {
  const box = element.getBoundingClientRect();
  const surface = canvas.canvas.getBoundingClientRect();
  return canvas.ds.convertCanvasToOffset([
    box.left + (leftEdge ? 0 : box.width / 2) - surface.left,
    box.top + box.height / 2 - surface.top,
  ]);
}
