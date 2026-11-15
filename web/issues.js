import { t } from "./i18n.js";

export function resolveExecutionNode(root, id) {
  if (id == null) return null;
  const ids = String(id).split(":");
  const nodeId = ids.pop();
  const route = [];
  let graph = root;
  for (const instanceId of ids) {
    const instance = graph?.getNodeById(instanceId);
    if (!instance?.subgraph) return null;
    graph = instance.subgraph;
    route.push({ graph, node: instance });
  }
  const node = graph?.getNodeById(nodeId);
  return node ? { node, graph, route } : null;
}

function activeTarget(target) {
  const isActive = (node) => node.mode !== 2 && node.mode !== 4;
  return target && isActive(target.node) && target.route.every(({ node }) => isActive(node));
}

function mergeMissingIssues(issues) {
  const merged = [];
  const groups = new Map();
  for (const issue of issues) {
    const { group, id, node, message, detail, canLocate, directory } = issue;
    if (group !== "model" && group !== "node") {
      merged.push(issue);
      continue;
    }
    // Model categories may contain files with the same relative name.
    const name = group === "model" ? message.replaceAll("\\", "/") : message;
    const key = JSON.stringify([group, directory, name]);
    let entry = groups.get(key);
    if (!entry) {
      entry = { key, group, message, directory, targets: new Map() };
      groups.set(key, entry);
      merged.push(entry);
    }
    const targetKey = id || node;
    if (!entry.targets.has(targetKey)) entry.targets.set(targetKey, { id, node, canLocate, details: [] });
    const target = entry.targets.get(targetKey);
    if (detail && !target.details.includes(detail)) target.details.push(detail);
  }
  return merged.map((entry) => entry.targets ? { ...entry, targets: [...entry.targets.values()] } : entry);
}

export function collectIssues(workflow, root, { lastNodeErrors, lastExecutionError }) {
  if (!workflow || !root) return [];
  const warnings = workflow.pendingWarnings;
  const issues = [];
  const resources = new Set();
  const seen = new Set();
  function add(group, id, nodeType, message, detail, target = resolveExecutionNode(root, id), directory) {
    const key = JSON.stringify([group, id ?? nodeType, message, detail, directory]);
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({
      group, id: id == null ? "" : String(id), node: target?.node.title || nodeType || target?.node.type,
      message, detail, canLocate: !!target, directory,
    });
  }
  for (const [group, candidates] of [
    ["model", warnings?.missingModelCandidates], ["media", warnings?.missingMediaCandidates],
  ]) {
    for (const candidate of candidates ?? []) {
      if (candidate.isMissing !== true) continue;
      const { nodeId, nodeType, widgetName, name } = candidate;
      const target = resolveExecutionNode(root, nodeId);
      if (nodeId != null && !activeTarget(target)) continue;
      const widget = target?.node.widgets?.find(({ name }) => name === widgetName);
      if (widget && widget.value !== name) continue;
      resources.add(JSON.stringify([String(nodeId), widgetName, name]));
      add(group, nodeId, nodeType, name, widgetName, target, group === "model" ? candidate.directory : undefined);
    }
  }
  for (const missing of warnings?.missingNodeTypes ?? []) {
    const { type, nodeId, cnrId } = typeof missing === "string" ? { type: missing } : missing;
    const target = resolveExecutionNode(root, nodeId);
    if (nodeId != null && (!activeTarget(target) || target.node.type !== type)) continue;
    add("node", nodeId, type, type, cnrId, target);
  }
  for (const [id, entry] of Object.entries(lastNodeErrors ?? {})) {
    for (const error of entry.errors) {
      const { input_name, received_value } = error.extra_info ?? {};
      if (error.type === "value_not_in_list" &&
          resources.has(JSON.stringify([id, input_name, received_value]))) continue;
      add("validation", id, entry.class_type, error.message || error.type, error.details);
    }
  }
  if (lastExecutionError) {
    const { node_id, node_type, exception_type, exception_message } = lastExecutionError;
    add("runtime", node_id, node_type, exception_message || exception_type || t("issue.executionFailed"));
  }
  return mergeMissingIssues(issues);
}
