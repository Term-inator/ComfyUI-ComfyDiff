export const ROOT = "";

const id = (value) => String(value);
const list = (value) => Array.isArray(value) ? value : [];
const has = (object, key) => Object.hasOwn(object ?? {}, key);
const record = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const nodeId = (value) => typeof value === "string" || Number.isInteger(value);
const optionalList = (value, check) => value === undefined || (Array.isArray(value) && value.every(check));

export function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((key) => has(b, key) && equal(a[key], b[key]));
}

export function parseWorkflow(text, source) {
  try {
    const workflow = JSON.parse(text);
    if (!validGraph(workflow)) throw new Error();
    return workflow;
  } catch {
    throw new Error(`${source}的文件不是有效的编辑器工作流 JSON。`);
  }
}

function linkData(value) {
  return Array.isArray(value) ? {
    id: value[0], origin_id: value[1], origin_slot: value[2],
    target_id: value[3], target_slot: value[4], type: value[5],
  } : value;
}

function validLink(value) {
  const link = linkData(value);
  const index = (slot) => (typeof slot === "number" || typeof slot === "string" && slot.trim()) &&
    Number.isInteger(Number(slot)) && Number(slot) >= 0;
  return record(link) && nodeId(link.id) && nodeId(link.origin_id) && nodeId(link.target_id) &&
    index(link.origin_slot) && index(link.target_slot);
}

function validGraph(graph) {
  const slots = (item) => optionalList(item.inputs, record) && optionalList(item.outputs, record);
  const boundary = (item) => item === undefined ||
    (record(item) && nodeId(item.id) && (item.bounding === undefined || Array.isArray(item.bounding)));
  return record(graph) && Array.isArray(graph.nodes) && graph.nodes.every((node) =>
    record(node) && nodeId(node.id) && typeof node.type === "string" && slots(node)) &&
    slots(graph) && boundary(graph.inputNode) && boundary(graph.outputNode) &&
    optionalList(graph.links, validLink) && optionalList(graph.reroutes ?? graph.extra?.reroutes, record) &&
    optionalList(graph.extra?.linkExtensions, record) &&
    optionalList(graph.definitions?.subgraphs, (subgraph) =>
      record(subgraph) && typeof subgraph.id === "string" && validGraph(subgraph));
}

function slots(node, side) {
  const entries = list(node[side]);
  const counts = new Map();
  for (const slot of entries) counts.set(slot.name, (counts.get(slot.name) ?? 0) + 1);
  return entries.map((slot, index) => ({
    ...slot,
    index,
    key: slot.id != null ? `id:${slot.id}` :
      slot.name && counts.get(slot.name) === 1 ? `name:${slot.name}` : `index:${index}`,
  }));
}

function normalizeNode(raw, restoreNamed) {
  return {
    id: id(raw.id), type: raw.type, title: raw.title, raw, restoreNamed,
    inputs: slots(raw, "inputs"), outputs: slots(raw, "outputs"),
    mode: raw.mode ?? 0,
  };
}

function boundary(raw, portList, input) {
  if (!raw) return null;
  const type = input ? "子图输入" : "子图输出";
  return normalizeNode({
    id: raw.id, type, boundary: true,
    pos: raw.bounding?.slice(0, 2), size: raw.bounding?.slice(2, 4),
    [input ? "outputs" : "inputs"]: portList,
  });
}

function normalizeGraph(raw, key, restoreNamed) {
  const nodes = new Map(list(raw.nodes).map((node) => [id(node.id), normalizeNode(node, restoreNamed)]));
  const input = boundary(raw.inputNode, raw.inputs, true);
  const output = boundary(raw.outputNode, raw.outputs, false);
  for (const node of [input, output]) if (node) nodes.set(node.id, node);
  const extensions = new Map(list(raw.extra?.linkExtensions).map((link) => [id(link.id), link]));
  const reroutes = new Map(list(raw.reroutes ?? raw.extra?.reroutes).map((route) => [id(route.id), route]));
  const incoming = new Map();
  const incident = new Map();
  const edges = [];
  for (const value of list(raw.links)) {
    const link = linkData(value);
    const source = nodes.get(id(link.origin_id));
    const target = nodes.get(id(link.target_id));
    if (!source || !target) continue;
    const originSlot = Number(link.origin_slot);
    const targetSlot = Number(link.target_slot);
    const out = source.outputs[originSlot];
    const port = target.inputs[targetSlot];
    const points = [];
    const visited = new Set();
    let route = link.parentId ?? extensions.get(id(link.id))?.parentId;
    while (route != null && reroutes.has(id(route)) && !visited.has(id(route))) {
      visited.add(id(route));
      const reroute = reroutes.get(id(route));
      if (reroute.pos) points.unshift([reroute.pos[0], reroute.pos[1]]);
      route = reroute.parentId;
    }
    const edge = {
      id: id(link.id), nativeId: link.id, type: link.type, source, target, points,
      out: out ?? { key: `index:${originSlot}`, index: originSlot },
      port: port ?? { key: `index:${targetSlot}`, index: targetSlot },
    };
    edges.push(edge);
    if (!incoming.has(target.id)) incoming.set(target.id, new Map());
    incoming.get(target.id).set(edge.port.key, edge);
    for (const nodeId of new Set([source.id, target.id])) {
      if (!incident.has(nodeId)) incident.set(nodeId, []);
      incident.get(nodeId).push(edge);
    }
  }
  return { key, name: raw.name, nodes, edges, incoming, incident, input, output };
}

export function snapshot(workflow, { restoreNamed = false } = {}) {
  const graphs = new Map();
  if (workflow) {
    const collect = (raw, key) => {
      if (graphs.has(key)) return;
      graphs.set(key, normalizeGraph(raw, key, restoreNamed));
      for (const definition of list(raw.definitions?.subgraphs)) collect(definition, id(definition.id));
    };
    collect(workflow, ROOT);
  }
  const paths = new Map();
  for (const graph of graphs.values()) {
    for (const node of graph.nodes.values()) node.subgraph = graphs.has(node.type);
  }
  if (graphs.has(ROOT)) {
    paths.set(ROOT, []);
    const queue = [ROOT];
    for (const key of queue) {
      for (const node of graphs.get(key).nodes.values()) {
        if (!graphs.has(node.type) || paths.has(node.type)) continue;
        paths.set(node.type, [...paths.get(key), {
          id: node.id, graph: node.type, name: node.title || graphs.get(node.type).name || "子图",
        }]);
        queue.push(node.type);
      }
    }
  }
  return { graphs, paths };
}

export function nodeName(node, graphSnapshot) {
  return node.title || graphSnapshot?.graphs.get(node.type)?.name || node.type;
}

export function sourceLabel(edge) {
  const { source, out } = edge;
  const id = source.raw.boundary ? "" : `#${source.id} `;
  return `${id}${nodeName(source)}.${out.name || `输出 ${out.index + 1}`}`;
}

export function compatibleWidgetSchema(left, right) {
  const a = left.raw.properties;
  const b = right.raw.properties;
  return left.type === right.type &&
    ["cnr_id", "aux_id", "ver"].every((key) => !a?.[key] || !b?.[key] || a[key] === b[key]);
}

export function nodeProvider(node, module) {
  const { cnr_id: registry, aux_id: source } = node.raw.properties ?? {};
  if (registry === "comfy-core") return null;
  if (typeof registry === "string" && registry) return registry;
  if (typeof source === "string" && source) return source;
  const prefix = "custom_nodes.";
  return module?.startsWith(prefix) ? module.slice(prefix.length) : null;
}

// Custom Scripts appends a read-only "result" widget after execution.
// Older files store it as the sixth value alongside the five actual inputs.
const stringFunctionInputs = ["action", "tidy_tags", "text_a", "text_b", "text_c"];

function namedWidgets(node) {
  const values = node.raw.widgets_values;
  const named = node.raw.widgets_values_named ?? (!Array.isArray(values) ? values : undefined);
  return named && typeof named === "object" && !Array.isArray(named) ? Object.entries(named) : [];
}

function namesInOrder(positional, named) {
  return named.length && named.length === positional.length &&
    (named.length === 1 || named.every(([, value], index) => equal(value, positional[index])))
    ? named.map(([name]) => name) : null;
}

function restoresByName(node, positional, named) {
  return named.length > 0 && (node.restoreNamed || !positional.length);
}

export function widgetSlots(node, names, positionalOnly = false) {
  const positional = list(node.raw.widgets_values);
  const named = namedWidgets(node);
  const stringFunction = node.type === "StringFunction|pysssss";
  if (!positionalOnly && restoresByName(node, positional, named)) {
    return new Map(named.filter(([name]) => !stringFunction || name !== "result")
      .map(([name, value]) => [`widget:${name}`, { name, value }]));
  }
  if (stringFunction && (positional.length === 5 || positional.length === 6)) {
    return new Map(stringFunctionInputs.map((name, index) => [
      `widget:${name}`, { name, index, value: positional[index] },
    ]));
  }
  const promoted = node.inputs.filter((port) => fieldName(port)).map(fieldName);
  if (!positionalOnly && node.subgraph && positional.length && promoted.length === positional.length &&
    new Set(promoted).size === promoted.length) {
    return new Map(promoted.map((name, index) => [`widget:${name}`, { name, index, value: positional[index] }]));
  }
  const order = positionalOnly ? null : names ?? namesInOrder(positional, named);
  return new Map(positional.map((value, index) => {
    const name = order?.length === positional.length ? order[index] : null;
    return [name ? `widget:${name}` : `position:${index}`, { name, index, value }];
  }));
}

function fieldName(port) {
  return typeof port?.widget?.name === "string" ? port.widget.name : null;
}

function inputSources(graph, node, widgets, otherInputs) {
  const result = new Map();
  const edges = graph.incoming.get(node.id);
  const otherByKey = new Map(otherInputs.map((port) => [port.key, port]));
  const ports = node.inputs.slice();
  for (const { port } of edges?.values() ?? []) {
    if (!node.inputs[port.index]) ports.push(port);
  }
  for (const slot of ports) {
    const port = node.inputs[slot.index] ?? otherInputs[slot.index] ?? slot;
    const name = fieldName(port) ?? fieldName(otherByKey.get(port.key));
    const key = name ? `widget:${name}` : `port:${port.key}`;
    const edge = edges?.get(slot.key);
    if (edge) {
      result.set(key, { kind: "link", edge, port, name });
    } else if (port.widget && (!widgets.has(key) || port.widget.config?.[1]?.forceInput === true ||
      port.widget.options?.forceInput === true)) {
      result.set(key, { kind: "exposed", port, name });
    }
  }
  for (const [key, widget] of widgets) {
    if (!result.has(key)) result.set(key, { kind: "value", ...widget });
  }
  return result;
}

function sameSource(left, right) {
  if (left?.kind !== right?.kind) return false;
  if (!left) return true;
  if (left.kind === "link") {
    const a = left.edge.out;
    const b = right.edge.out;
    return left.edge.source.id === right.edge.source.id && (
      a.key === b.key || (a.key.startsWith("index:") || b.key.startsWith("index:")) && a.index === b.index
    );
  }
  return left.kind !== "value" || equal(left.value, right.value);
}

function widgetNames(left, right, live, getNames) {
  const names = [left, right].map((node) => {
    const values = node.raw.widgets_values;
    if (!Array.isArray(values)) return null;
    return namesInOrder(values, namedWidgets(node)) ?? getNames?.(live, node) ?? null;
  });
  if (compatibleWidgetSchema(left, right) &&
    Array.isArray(left.raw.widgets_values) && Array.isArray(right.raw.widgets_values) &&
    left.raw.widgets_values.length === right.raw.widgets_values.length &&
    ["inputs", "outputs"].every((side) => equal(left[side].map((slot) => slot.name), right[side].map((slot) => slot.name)))) {
    return [names[0] ?? names[1], names[1] ?? names[0]];
  }
  // A complete widget-port layout can corroborate the order even across a
  // version change. A partial layout cannot identify unnamed widget values.
  const portNames = [left, right].map((node) => node.inputs.map(fieldName).filter(Boolean));
  if (equal(portNames[0], portNames[1]) && names.some((order) => equal(order, portNames[0]))) {
    for (const [i, node] of [left, right].entries()) {
      if (node.raw.widgets_values?.length === portNames[i].length) names[i] ??= portNames[i];
    }
  }
  return names;
}

function changesForNode(before, after, left, right, getNames) {
  if (!left) return [{ kind: "added", after: right }];
  if (!right) return [{ kind: "deleted", before: left }];
  if (left.type !== right.type) return [{ kind: "replaced", before: left, after: right }];
  const rows = [];
  if (left.mode !== right.mode) rows.push({ kind: "mode", from: left.mode, to: right.mode });
  const [oldNames, newNames] = widgetNames(left, right, before.key, getNames);
  let a = widgetSlots(left, oldNames);
  let b = widgetSlots(right, newNames);
  const positional = (node) => Array.isArray(node.raw.widgets_values) &&
    !restoresByName(node, node.raw.widgets_values, namedWidgets(node));
  if (positional(left) && positional(right) &&
    [...a.keys(), ...b.keys()].some((key) => key.startsWith("position:"))) {
    a = widgetSlots(left, null, true);
    b = widgetSlots(right, null, true);
  }
  const oldSources = inputSources(before, left, a, right.inputs);
  const newSources = inputSources(after, right, b, left.inputs);
  for (const key of new Set([...oldSources.keys(), ...newSources.keys()])) {
    const from = oldSources.get(key);
    const to = newSources.get(key);
    if (sameSource(from, to)) continue;
    const port = to?.port ?? from?.port;
    const name = to?.name ?? from?.name;
    const index = to?.index ?? from?.index;
    const kind = port || from?.kind === "link" || to?.kind === "link" ? "input" : "parameter";
    rows.push({
      kind, from, to, name, port, index, names: newNames, fieldKey: key,
      field: name ?? port?.name ?? (port ? `输入 ${port.index + 1}` : `参数 ${index + 1}`),
    });
  }
  return rows.map((row) => ({ ...row, before: left, after: right }));
}

function changesForBoundary(before, after, left, right, getNames) {
  const rows = changesForNode(before, after, left, right, getNames);
  const side = left === before.input ? "outputs" : "inputs";
  const a = new Map(left[side].map((port) => [port.key, port]));
  const b = new Map(right[side].map((port) => [port.key, port]));
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const from = a.get(key);
    const to = b.get(key);
    if (from && to && from.name === to.name && from.label === to.label && equal(from.type, to.type)) continue;
    rows.push({ kind: "boundary", before: left, after: right, side, from, to });
  }
  return rows;
}

export function compare(before, after, getNames) {
  const result = [];
  const graphKeys = new Set([...after.paths.keys(), ...before.paths.keys()]);
  for (const graph of graphKeys) {
    const a = before.paths.has(graph) ? before.graphs.get(graph) : undefined;
    const b = after.paths.has(graph) ? after.graphs.get(graph) : undefined;
    const nodeIds = new Set([...(b?.nodes.keys() ?? []), ...(a?.nodes.keys() ?? [])]);
    for (const node of nodeIds) {
      const left = a?.nodes.get(node);
      const right = b?.nodes.get(node);
      if ((left ?? right).raw.boundary && (!left || !right)) continue;
      const rows = left?.raw.boundary && right?.raw.boundary ?
        changesForBoundary(a, b, left, right, getNames) : changesForNode(a, b, left, right, getNames);
      for (const row of rows) result.push({ ...row, graph, node });
    }
  }
  return result;
}

export function validateChange(change, graph) {
  const node = graph?.nodes.get(change.node);
  if (change.kind === "deleted") return node ? "当前画布仍有这个节点。" : "";
  if (!node) return "当前画布中找不到目标节点。";
  if (node.type !== change.after.type) return `当前画布中的节点类型是 ${node.type}。`;
  if (change.kind === "mode" && node.mode !== change.to) return "当前画布中的运行模式与比较结果不同。";
  if (change.kind === "boundary") {
    const port = node[change.side].find((entry) => entry.key === (change.to ?? change.from).key);
    if (change.to ? !port || port.name !== change.to.name || port.label !== change.to.label ||
      !equal(port.type, change.to.type) : !!port) return "当前画布中的子图端口与比较结果不同。";
  }
  if (change.fieldKey) {
    const widgets = widgetSlots(node, change.names, change.fieldKey.startsWith("position:"));
    let source = inputSources(graph, node, widgets, change.before.inputs).get(change.fieldKey);
    const index = change.port?.index;
    if (!source && index != null && change.fieldKey === `port:index:${index}`) {
      const port = node.inputs[index];
      const edge = port && graph.incoming.get(node.id)?.get(port.key);
      if (edge) source = { kind: "link", edge, port };
    }
    const differentSourceType = source?.kind === "link" && change.to?.kind === "link" &&
      source.edge.source.type !== change.to.edge.source.type;
    if (!sameSource(source, change.to) || differentSourceType) {
      if (source?.kind === "value" && change.to?.kind === "value") {
        const valueText = (value) => {
          const text = JSON.stringify(value) ?? "无";
          return text.length > 40 ? `${text.slice(0, 40)}…` : text;
        };
        return `当前画布的 ${change.field} 为 ${valueText(source.value)}，比较版本为 ${valueText(change.to.value)}。`;
      }
      return "当前画布中的参数值或接线来源与比较结果不同。";
    }
    return { source };
  }
  return "";
}
