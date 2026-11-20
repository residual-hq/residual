import assert from "node:assert/strict";
import { test } from "node:test";
import { ResidualToolGateHost, type ToolsHost } from "../src/tool-gate-host.ts";

type FakeTool = { name: string; description: string; execute?: () => string };

function fakeTools(initial: FakeTool[]): ToolsHost & {
  visible: FakeTool[];
  denied: string[];
  registered: FakeTool[];
} {
  const visible = [...initial];
  const denied: string[] = [];
  const registered: FakeTool[] = [];
  const host: ToolsHost & { visible: FakeTool[]; denied: string[]; registered: FakeTool[] } = {
    visible,
    denied,
    registered,
    schemas: () =>
      visible
        .filter((tool) => !denied.includes(tool.name))
        .map((tool) => ({ name: tool.name, description: tool.description, parameters: { type: "object" } })),
    get: (name) => initial.find((tool) => tool.name === name),
    register: (definition) => {
      registered.push(definition as FakeTool);
      const tool = definition as FakeTool;
      if (!visible.some((item) => item.name === tool.name)) visible.push(tool);
    },
    restrict: (filter) => {
      denied.push(...(filter.deny ?? []));
    },
  };
  return host;
}

const mcpSearch = { name: "mcp__docs__search", description: "Search docs", execute: () => "s" };
const mcpFetch = { name: "mcp__docs__fetch", description: "Fetch a page", execute: () => "f" };
const bash = { name: "bash", description: "Run a shell command", execute: () => "b" };

test("snapshot catalogs summaries and load appends without touching deny", () => {
  const tools = fakeTools([mcpSearch, mcpFetch, bash]);
  const host = new ResidualToolGateHost();
  const catalog = host.snapshotCatalog(tools);
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    ["mcp__docs__search", "mcp__docs__fetch", "bash"],
  );
  const session = {};
  const denied = host.hideUnloadedMcpTools(session, tools);
  assert.deepEqual(denied, ["mcp__docs__search", "mcp__docs__fetch"]);
  assert.deepEqual(tools.denied, denied);

  const first = host.load(tools, "mcp__docs__fetch");
  const again = host.load(tools, "mcp__docs__fetch");
  assert.deepEqual(first, { appended: true, index: 0 });
  assert.deepEqual(again, { appended: false, index: 0 });
  assert.deepEqual(
    host.gate.listLoaded().map((tool) => tool.id),
    ["mcp__docs__fetch"],
  );
  assert.equal(tools.registered.length, 1);
  assert.equal(tools.registered[0]?.name, "mcp__docs__fetch");
  // Deny list is not rebuilt or reduced after a load — append-only.
  assert.deepEqual(tools.denied, ["mcp__docs__search", "mcp__docs__fetch"]);
});

test("hideUnloadedMcpTools is once per session and never hides eager or native tools", () => {
  const tools = fakeTools([mcpSearch, mcpFetch, bash]);
  const host = new ResidualToolGateHost();
  host.snapshotCatalog(tools);
  const session = {};
  const first = host.hideUnloadedMcpTools(session, tools, { eager: ["mcp__docs__search"] });
  const second = host.hideUnloadedMcpTools(session, tools);
  assert.deepEqual(first, ["mcp__docs__fetch"]);
  assert.deepEqual(second, []);
  assert.equal(tools.denied.includes("bash"), false);
  assert.equal(tools.denied.includes("mcp__docs__search"), false);
});

test("search filters the catalog without loading schemas into the session", () => {
  const tools = fakeTools([mcpSearch, mcpFetch, bash]);
  const host = new ResidualToolGateHost();
  host.snapshotCatalog(tools);
  assert.deepEqual(
    host.search("fetch").map((entry) => entry.id),
    ["mcp__docs__fetch"],
  );
  assert.equal(host.gate.listLoaded().length, 0);
});

test("hide refuses to invent a restrict API when the host cannot filter tools", () => {
  const host = new ResidualToolGateHost();
  assert.throws(
    () => host.hideUnloadedMcpTools({}, { schemas: () => [] }),
    /tools.restrict is unavailable/,
  );
});
