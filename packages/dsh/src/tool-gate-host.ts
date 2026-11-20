/**
 * Host adapter that applies Residual's append-only ToolGate to a DSH
 * `ctx.tools` / `agent.ctx.tools` surface.
 *
 * Official KV-cache guidance is append-only: newly visible tools may follow
 * a reusable prefix, but hiding a tool mid-session can invalidate the cache.
 * This adapter snapshots definitions, may hide unused `mcp__*` tools once
 * before the first model call, and then only registers newly loaded tools
 * in the agent scope. It never unloads, never rebuilds a deny list, and
 * never reorders.
 */

import { ToolGate, type ToolCatalogEntry } from "@residualhq/core";

export type ToolSchemaView = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type ToolsHost = {
  schemas?: (scope?: unknown) => ToolSchemaView[];
  get?: (name: string, scope?: unknown) => unknown;
  register?: (definition: unknown, options?: unknown) => unknown;
  restrict?: (filter: { deny?: string[]; allow?: string[] }) => unknown;
};

export type HideOptions = {
  /** Tool ids that stay visible even if they have not been load()ed yet. */
  eager?: string[];
};

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line;
}

export class ResidualToolGateHost {
  readonly gate: ToolGate;
  private readonly definitions = new Map<string, unknown>();
  private readonly sessionsHidden = new WeakSet<object>();

  constructor(gate = new ToolGate()) {
    this.gate = gate;
  }

  /** Capture the current global (or provided) registry as a catalog. */
  snapshotCatalog(tools: ToolsHost): ToolCatalogEntry[] {
    const schemas = tools.schemas?.() ?? [];
    for (const schema of schemas) {
      const definition = tools.get?.(schema.name);
      if (definition !== undefined) this.definitions.set(schema.name, definition);
      const knownSchema = definition ?? schema.parameters ?? schema;
      this.gate.addToCatalog({
        id: schema.name,
        name: schema.name,
        summary: oneLine(schema.description ?? schema.name),
        schema: knownSchema,
      });
    }
    return this.gate.catalog();
  }

  /**
   * Once per session object, hide unused MCP tools. Safe only before the
   * first model-facing tool list is sent. Subsequent calls are no-ops.
   */
  hideUnloadedMcpTools(session: object, agentTools: ToolsHost, options: HideOptions = {}): string[] {
    if (this.sessionsHidden.has(session)) return [];
    if (typeof agentTools.restrict !== "function") {
      throw new Error(
        "Residual tool gate: host tools.restrict is unavailable; cannot hide unused MCP tools",
      );
    }
    const eager = new Set([
      ...this.gate.listLoaded().map((tool) => tool.id),
      ...(options.eager ?? []),
    ]);
    const deny = this.gate
      .catalog()
      .map((entry) => entry.id)
      .filter((id) => id.startsWith("mcp__") && !eager.has(id));
    if (deny.length > 0) agentTools.restrict({ deny });
    this.sessionsHidden.add(session);
    return deny;
  }

  /**
   * Append a tool to the session list and, when the host allows it, register
   * the original definition on the agent-scoped registry. Never touches deny.
   */
  load(agentTools: ToolsHost, toolId: string): { appended: boolean; index: number } {
    const definition = this.definitions.get(toolId);
    const result = this.gate.load(toolId);
    if (result.appended && definition !== undefined && typeof agentTools.register === "function") {
      agentTools.register(definition);
    }
    return result;
  }

  search(query: string): ToolCatalogEntry[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return this.gate.catalog();
    return this.gate.catalog().filter((entry) => {
      return entry.id.toLowerCase().includes(needle) || entry.summary.toLowerCase().includes(needle);
    });
  }
}
