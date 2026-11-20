import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  SettingsWatcher,
  applySettingsOverlay,
  parseSettingsFile,
  readResidualSection,
} from "../src/settings.ts";
import { parseYaml } from "../src/yaml.ts";
import type { PolicyDocument } from "../src/policy.ts";

const base: PolicyDocument = {
  default: { threshold: 0.8, retain: 0.16 },
  providers: { deepseek: { threshold: 0.5 } },
  models: [{ provider: "deepseek", model: "deepseek-chat", threshold: 0.9 }],
};

test("YAML parser reads residual settings with nested maps and model arrays", () => {
  const raw = parseYaml(`
# residual-settings.yaml
residual:
  default:
    threshold: 0.8
    retain: 0.16
  providers:
    deepseek:
      threshold: 0.5
  models:
    - provider: deepseek
      model: deepseek-chat
      thresholdTokens: 80000
`);
  const section = readResidualSection(raw);
  assert.equal(section?.default?.threshold, 0.8);
  assert.equal(section?.providers?.deepseek?.threshold, 0.5);
  assert.equal(section?.models?.[0]?.thresholdTokens, 80_000);
  assert.equal(section?.models?.[0]?.model, "deepseek-chat");
});

test("a bare policy document (no residual: wrapper) is accepted", () => {
  const section = parseSettingsFile(`
default:
  threshold: 0.4
`);
  assert.equal(section?.default?.threshold, 0.4);
});

test("partial file section cannot wipe model-specific policies", () => {
  const live = applySettingsOverlay(base, parseSettingsFile(`
residual:
  default:
    threshold: 0.25
`));
  assert.equal(live.origin, "residual-settings.yaml");
  assert.equal(live.document.default?.threshold, 0.25);
  assert.equal(live.document.default?.retain, 0.16);
  assert.equal(live.document.providers?.deepseek?.threshold, 0.5);
  assert.equal(live.document.models?.[0]?.threshold, 0.9);
});

test("watcher hot-reloads a partial overlay and keeps last good policy on bad YAML", async () => {
  const dir = mkdtempSync(join(tmpdir(), "residual-settings-"));
  const file = join(dir, "residual-settings.yaml");
  writeFileSync(
    file,
    `residual:\n  default:\n    threshold: 0.4\n`,
    "utf8",
  );

  const seen: number[] = [];
  const errors: string[] = [];
  const watcher = new SettingsWatcher({
    base,
    file,
    intervalMs: 25,
    onChange: (live) => {
      if (live.document.default?.threshold !== undefined) {
        seen.push(live.document.default.threshold);
      }
    },
    onError: (error) => errors.push(error.message),
  });

  const stop = watcher.start();
  try {
    assert.equal(watcher.current().document.default?.threshold, 0.4);
    assert.equal(watcher.current().document.models?.[0]?.model, "deepseek-chat");

    writeFileSync(
      file,
      `residual:\n  default:\n    threshold: 0.2\n`,
      "utf8",
    );
    await delay(80);
    assert.equal(watcher.current().document.default?.threshold, 0.2);
    assert.equal(watcher.current().document.models?.[0]?.threshold, 0.9);

    writeFileSync(file, `residual: [\n  broken`, "utf8");
    await delay(80);
    assert.equal(watcher.current().document.default?.threshold, 0.2, "bad edit must not replace last good policy");
    assert.ok(errors.length > 0);
    assert.ok(seen.includes(0.2));
  } finally {
    stop();
  }
});

test("missing settings file falls back to the composition document", () => {
  const watcher = new SettingsWatcher({
    base,
    file: join(tmpdir(), "residual-does-not-exist.yaml"),
    onChange: () => {
      throw new Error("missing file should not emit a change on construct");
    },
  });
  assert.equal(watcher.current().origin, "composition");
  assert.equal(watcher.current().document.default?.threshold, 0.8);
  assert.equal(watcher.current().document.models?.length, 1);
});

test("YAML parser reads a DSH-style patch document of insert sequences", () => {
  const raw = parseYaml(`
- insert:
    - id: residual-engine
      name: '@residualhq/dsh/engine'
      disabled: true
- insert:
    - id: residual-settings
      name: '@residualhq/dsh'
      config:
        default:
          threshold: 0.8
`);
  assert.ok(Array.isArray(raw));
  const rows = raw as Array<{ insert: Array<Record<string, unknown>> }>;
  assert.equal(rows[0]?.insert[0]?.id, "residual-engine");
  assert.equal(rows[0]?.insert[0]?.disabled, true);
  assert.equal(rows[1]?.insert[0]?.id, "residual-settings");
  assert.equal((rows[1]?.insert[0]?.config as { default: { threshold: number } }).default.threshold, 0.8);
});
