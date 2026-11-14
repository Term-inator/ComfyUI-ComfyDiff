import { nodeProvider } from "./diff.js";

export class NodeIdentity {
  modules = new Map();
  candidates;
  loading;

  setDefinitions(definitions) {
    this.modules = new Map(definitions.map(({ name, python_module }) => [name, python_module]));
  }

  identify(node) {
    if (node.subgraph || node.raw.boundary) return null;
    const module = this.modules.get(node.type);
    const provider = nodeProvider(node, module === "custom_nodes.frontend_only" ? undefined : module);
    const registered = this.modules.has(node.type) ||
      Object.hasOwn(window.LiteGraph?.registered_node_types ?? {}, node.type);
    if (provider) {
      return { label: provider, detail: registered ? "" : "当前 ComfyUI 未注册此类型" };
    }
    if (module === "custom_nodes.frontend_only") return { label: "前端节点", detail: "扩展包未声明" };
    if (registered) return null;

    const candidates = this.candidates?.get(node.type) ?? [];
    const detail = "当前 ComfyUI 未注册此类型";
    if (candidates.length === 1) return { label: `候选扩展 · ${candidates[0]}`, detail };
    if (candidates.length > 1) {
      return { label: `来源有 ${candidates.length} 个候选`, detail, candidates };
    }
    return { label: detail, unresolved: true };
  }

  async loadCandidates(api) {
    if (this.candidates) return;
    this.loading ??= (async () => {
      const index = new Map();
      try {
        const response = await api.fetchApi("/v2/customnode/getmappings?mode=local");
        if (response.ok) {
          for (const [pack, entry] of Object.entries(await response.json())) {
            if (!Array.isArray(entry?.[0])) continue;
            const label = entry[1]?.title_aux || entry[1]?.title || pack;
            for (const type of entry[0]) {
              if (!index.has(type)) index.set(type, new Set());
              index.get(type).add(label);
            }
          }
        }
      } catch {
        // Manager is optional. Workflow types are still available.
      }
      this.candidates = new Map([...index].map(([type, names]) => [type, [...names].sort()]));
    })();
    await this.loading;
  }

  needsIndex(changes) {
    return !this.candidates && changes.some((change) =>
      this.identify(change.after ?? change.before)?.unresolved);
  }
}
