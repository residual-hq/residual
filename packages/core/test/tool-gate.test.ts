import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolGate, type LoadedTool } from "../src/tool-gate.ts";

const search: LoadedTool = {
  id: "mcp__docs__search",
  name: "mcp__docs__search",
  summary: "Search documentation",
  schema: { type: "object", properties: { query: { type: "string" } } },
};

const fetchTool: LoadedTool = {
  id: "mcp__docs__fetch",
  name: "mcp__docs__fetch",
  summary: "Fetch a page",
  schema: { type: "object", properties: { url: { type: "string" } } },
};

const list: LoadedTool = {
  id: "mcp__docs__list",
  name: "mcp__docs__list",
  summary: "List pages",
  schema: { type: "object" },
};

test("catalog is summaries only and is distinct from the loaded list", () => {
  const gate = new ToolGate([search, { id: "idle", name: "idle", summary: "Not loaded yet" }]);
  assert.deepEqual(gate.catalog(), [
    { id: "mcp__docs__search", name: "mcp__docs__search", summary: "Search documentation" },
    { id: "idle", name: "idle", summary: "Not loaded yet" },
  ]);
  assert.deepEqual(gate.listLoaded(), []);
  for (const entry of gate.catalog()) {
    assert.equal("schema" in entry, false);
  }
});

test("load is append-only and preserves first-seen order", () => {
  const gate = new ToolGate();
  assert.deepEqual(gate.load(search), { appended: true, index: 0 });
  assert.deepEqual(gate.load(fetchTool), { appended: true, index: 1 });
  assert.deepEqual(gate.load(list), { appended: true, index: 2 });
  assert.deepEqual(
    gate.listLoaded().map((tool) => tool.id),
    ["mcp__docs__search", "mcp__docs__fetch", "mcp__docs__list"],
  );
});

test("load is idempotent and does not reorder an already loaded tool", () => {
  const gate = new ToolGate();
  gate.load(search);
  gate.load(fetchTool);
  const again = gate.load({
    ...search,
    schema: { type: "object", properties: { rewritten: { type: "string" } } },
  });
  assert.deepEqual(again, { appended: false, index: 0 });
  assert.equal(gate.listLoaded().length, 2);
  assert.deepEqual(
    gate.listLoaded().map((tool) => tool.id),
    ["mcp__docs__search", "mcp__docs__fetch"],
  );
  // The original schema stays; a repeat must not replace it.
  assert.deepEqual(gate.listLoaded()[0]?.schema, search.schema);
});

test("load by catalog id works once a schema is known, and is idempotent", () => {
  const gate = new ToolGate([search]);
  assert.deepEqual(gate.load("mcp__docs__search"), { appended: true, index: 0 });
  assert.deepEqual(gate.load("mcp__docs__search"), { appended: false, index: 0 });
});

test("load by id refuses a catalog entry that has no schema", () => {
  const gate = new ToolGate([{ id: "idle", name: "idle", summary: "summary only" }]);
  assert.throws(() => gate.load("idle"), /no schema/);
  assert.equal(gate.listLoaded().length, 0);
});

test("session path has no remove or reorder API", () => {
  const gate = new ToolGate();
  const proto = Object.getPrototypeOf(gate) as Record<string, unknown>;
  for (const name of ["remove", "unload", "delete", "clear", "reorder", "move", "splice", "shift", "pop"]) {
    assert.equal(typeof (gate as unknown as Record<string, unknown>)[name], "undefined", name);
    assert.equal(typeof proto[name], "undefined", `prototype.${name}`);
  }
});

test("mutating a listLoaded copy cannot change the session list", () => {
  const gate = new ToolGate();
  gate.load(search);
  const copy = gate.listLoaded() as LoadedTool[];
  copy.pop();
  assert.equal(gate.listLoaded().length, 1);
});

test("addToCatalog does not overwrite an existing id or load it", () => {
  const gate = new ToolGate([search]);
  gate.addToCatalog({ ...search, summary: "rewritten" });
  assert.equal(gate.catalog()[0]?.summary, "Search documentation");
  assert.equal(gate.listLoaded().length, 0);
});
