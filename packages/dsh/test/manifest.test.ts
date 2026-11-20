import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseYaml } from "../../core/src/yaml.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package manifest uses Residual ids and the current DSH engine range", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string;
    main: string;
    exports: Record<string, string>;
    engines: { node: string; dsh: string };
    dsh: { manifestVersion: number; bundle: { patch: string } };
    peerDependencies: Record<string, string>;
  };
  assert.equal(pkg.name, "@residualhq/dsh");
  assert.equal(pkg.dsh.manifestVersion, 1);
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.engines.dsh, ">=0.2.2-0 <0.3.0-0");
  assert.ok(pkg.exports["."]);
  assert.ok(pkg.exports["./engine"]);
  assert.notEqual(pkg.exports["."], pkg.exports["./engine"]);
  assert.match(pkg.peerDependencies["@deepseek-ai/dsh-compaction-basic"], /0\.2\.2/);
  const body = JSON.stringify(pkg);
  assert.equal(body.includes("compaction-control"), false);
  assert.equal(body.includes("compaction-control-settings"), false);
});

test("bundle patch inserts residual-engine disabled and residual-settings enabled", () => {
  const raw = parseYaml(readFileSync(join(root, "cordis.patch.yml"), "utf8")) as unknown;
  assert.ok(Array.isArray(raw));
  const rows: Array<Record<string, unknown>> = [];
  for (const item of raw as Array<{ insert?: Array<Record<string, unknown>> }>) {
    for (const row of item.insert ?? []) rows.push(row);
  }
  const engine = rows.find((row) => row.id === "residual-engine");
  const settings = rows.find((row) => row.id === "residual-settings");
  assert.ok(engine, "residual-engine row");
  assert.ok(settings, "residual-settings row");
  assert.equal(engine.name, "@residualhq/dsh/engine");
  assert.equal(engine.disabled, true);
  assert.equal(settings.name, "@residualhq/dsh");
  assert.equal(settings.disabled, undefined);
  const ids = rows.map((row) => row.id);
  assert.equal(ids.includes("compaction-control"), false);
  assert.equal(ids.includes("compaction-control-settings"), false);
});

test("source entries keep the companion and engine on separate modules", () => {
  const companion = readFileSync(join(root, "src/index.ts"), "utf8");
  const engine = readFileSync(join(root, "src/engine.ts"), "utf8");
  assert.match(companion, /ResidualSettings/);
  assert.doesNotMatch(companion, /from "\.\/engine/);
  assert.match(engine, /extends BasicCompactionEngine/);
  assert.match(engine, /static Config/);
  assert.match(engine, /static inject = BasicCompactionEngine.inject/);
  assert.match(engine, /formatRecordLine/);
  assert.match(engine, /residualSavingsPath/);
  assert.match(engine, /toBootOfficialConfig/);
  assert.match(engine, /tokensAfter < before/);
});
