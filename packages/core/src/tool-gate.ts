/**
 * Append-only session tool list.
 *
 * The catalog is the known set (name + one-line summary, no full schema).
 * `load()` places a full schema on the session list. The same id is a no-op
 * (idempotent) and never reorders. There is no remove/reorder API on the
 * session path — mid-session deletions or reshuffles can bill the whole
 * prefix as a prompt-cache miss.
 */

export type ToolId = string;

export type ToolCatalogEntry = {
  id: ToolId;
  name: string;
  summary: string;
};

export type LoadedTool = ToolCatalogEntry & {
  schema: unknown;
};

export type LoadResult = {
  /** True only when this call appended a new schema to the session list. */
  appended: boolean;
  /** Position in the loaded list (existing or newly appended). */
  index: number;
};

function isLoadedTool(entry: ToolCatalogEntry | LoadedTool): entry is LoadedTool {
  return "schema" in entry;
}

function summaryOf(entry: ToolCatalogEntry | LoadedTool): ToolCatalogEntry {
  return { id: entry.id, name: entry.name, summary: entry.summary };
}

export class ToolGate {
  private readonly known = new Map<ToolId, ToolCatalogEntry | LoadedTool>();
  private readonly loaded: LoadedTool[] = [];

  constructor(catalog: Iterable<ToolCatalogEntry | LoadedTool> = []) {
    for (const entry of catalog) this.addToCatalog(entry);
  }

  /** Full known set as summaries only — never includes schemas. */
  catalog(): ToolCatalogEntry[] {
    return [...this.known.values()].map(summaryOf);
  }

  /** Session-loaded schemas, in append order. Returns a copy. */
  listLoaded(): readonly LoadedTool[] {
    return this.loaded.map((tool) => ({ ...tool }));
  }

  /**
   * Record a catalog entry without putting its schema on the session list.
   * If the id is already known, the existing record is left unchanged so a
   * later catalog refresh cannot shuffle or silently replace a loaded tool.
   */
  addToCatalog(entry: ToolCatalogEntry | LoadedTool): void {
    if (this.known.has(entry.id)) return;
    this.known.set(entry.id, { ...entry });
  }

  /**
   * Append a full schema to the session list. Idempotent: a repeated id is
   * a no-op and does not move the tool. Accepts a loaded tool, or an id
   * whose catalog record already carries a schema.
   */
  load(tool: LoadedTool | ToolId): LoadResult {
    const resolved = this.resolveForLoad(tool);
    const existing = this.loaded.findIndex((item) => item.id === resolved.id);
    if (existing >= 0) return { appended: false, index: existing };
    this.addToCatalog(resolved);
    // Keep the catalog's stored record if it already had a schema; otherwise
    // upgrade the summary-only entry so later load(id) works.
    this.known.set(resolved.id, resolved);
    this.loaded.push(resolved);
    return { appended: true, index: this.loaded.length - 1 };
  }

  private resolveForLoad(tool: LoadedTool | ToolId): LoadedTool {
    if (typeof tool !== "string") {
      return { id: tool.id, name: tool.name, summary: tool.summary, schema: tool.schema };
    }
    const known = this.known.get(tool);
    if (!known || !isLoadedTool(known)) {
      throw new Error(
        `ToolGate: cannot load "${tool}" because the catalog has no schema for it`,
      );
    }
    return { id: known.id, name: known.name, summary: known.summary, schema: known.schema };
  }
}
