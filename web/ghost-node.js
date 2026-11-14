import { nodeLabel } from "./diff.js";
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
    add(node, snapshot) {
      const [x, y, width] = bounds(node);
      const card = element("section", "cd-ghost-node");
      card.dataset.cdOldNode = node.id;
      Object.assign(card.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(width, 190)}px` });
      const title = element("header", "cd-ghost-title", `− ${nodeLabel(node, snapshot)}`);
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
      card.append(title, ports);
      layer.append(card);
      cards.set(node.id, { card, dots });
      return card;
    },
    position(node, port, input) {
      const dot = cards.get(node.id)?.dots.get(`${input ? "in" : "out"}:${port.key}`);
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
