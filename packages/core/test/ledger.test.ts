import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SavingsLedger } from "../src/ledger.ts";

test("tokensSaved sums only positive reductions", () => {
  const ledger = new SavingsLedger({ host: "dsh", sessionId: "s1" });
  ledger.record({ tokensBefore: 10_000, tokensAfter: 6_000 });
  ledger.record({ tokensBefore: 8_000, tokensAfter: 8_500 }); // growth counts as zero saved
  ledger.record({ tokensBefore: 5_000, tokensAfter: 4_000, sessionId: "s2", host: "dsh" });
  assert.equal(ledger.tokensSaved(), 5_000);
  assert.equal(ledger.tokensSaved({ sessionId: "s1" }), 4_000);
  assert.equal(ledger.tokensSaved({ sessionId: "s2" }), 1_000);
});

test("session summary reports counts, totals, and tokens saved", () => {
  const ledger = new SavingsLedger({ host: "dsh", sessionId: "sess-a" });
  ledger.record({ tokensBefore: 20_000, tokensAfter: 12_000, at: "2026-11-18T12:00:00.000Z" });
  ledger.record({ tokensBefore: 12_000, tokensAfter: 9_000, at: "2026-11-18T12:01:00.000Z" });
  const summary = ledger.sessionSummary();
  assert.equal(summary.sessionId, "sess-a");
  assert.equal(summary.entries, 2);
  assert.equal(summary.tokensBefore, 32_000);
  assert.equal(summary.tokensAfter, 21_000);
  assert.equal(summary.tokensSaved, 11_000);
});

test("ledger persists to JSONL and reloads token counts, never requiring a judge", () => {
  const dir = mkdtempSync(join(tmpdir(), "residual-ledger-"));
  const file = join(dir, "residual-ledger.jsonl");
  const first = new SavingsLedger({ file, host: "dsh", sessionId: "abc" });
  first.record({
    tokensBefore: 42_000,
    tokensAfter: 30_000,
    at: "2026-11-18T20:00:00.000Z",
  });
  const text = readFileSync(file, "utf8").trim();
  assert.equal(text.includes("42000"), true);
  assert.equal(text.includes("\n"), false, "one record is one line");
  const parsed = JSON.parse(text) as { tokensBefore: number; tokensAfter: number; host: string };
  assert.equal(parsed.host, "dsh");
  assert.equal(parsed.tokensBefore, 42_000);

  const reloaded = SavingsLedger.load(file, { host: "dsh" });
  assert.equal(reloaded.tokensSaved({ sessionId: "abc" }), 12_000);
  assert.equal(reloaded.sessionSummary("abc").entries, 1);
  reloaded.record({ tokensBefore: 30_000, tokensAfter: 25_000, sessionId: "abc" });
  assert.equal(SavingsLedger.load(file).tokensSaved({ sessionId: "abc" }), 17_000);
});

test("records catalog dollar estimates and writes a residual-savings.json snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "residual-ledger-money-"));
  const file = join(dir, "residual-ledger.jsonl");
  const ledger = new SavingsLedger({ file, host: "dsh", sessionId: "sess-b" });
  const row = ledger.record({
    tokensBefore: 42_000,
    tokensAfter: 30_000,
    model: "deepseek-v4-pro",
    provider: "deepseek",
    at: "2026-11-18T20:00:00.000Z",
  });
  assert.equal(row.savedUsd, 0.00792);
  assert.equal(row.wouldHavePaidUsd, 0.02772);
  assert.equal(row.paidUsd, 0.0198);
  assert.equal(row.savedUsdIfCached, 0.000264);
  assert.equal(row.costSource, "catalog");
  const summary = ledger.sessionSummary();
  assert.equal(summary.savedUsd, 0.00792);
  assert.equal(summary.unpricedEntries, 0);
  const snapshot = JSON.parse(readFileSync(join(dir, "residual-savings.json"), "utf8")) as {
    lifetime: { savedUsd: number; tokensSaved: number };
    disclaimer: string;
  };
  assert.equal(snapshot.lifetime.savedUsd, 0.00792);
  assert.equal(snapshot.lifetime.tokensSaved, 12_000);
  assert.equal(snapshot.disclaimer.includes("Not a vendor invoice"), true);
});

test("unknown models keep token counts and leave dollars unpriced", () => {
  const ledger = new SavingsLedger({ host: "dsh", sessionId: "sess-c" });
  const row = ledger.record({
    tokensBefore: 8_000,
    tokensAfter: 5_000,
    model: "deepseek-chat",
    at: "2026-11-18T20:00:00.000Z",
  });
  assert.equal(row.costSource, "unknown_model_price");
  assert.equal(row.savedUsd, undefined);
  const summary = ledger.sessionSummary();
  assert.equal(summary.tokensSaved, 3_000);
  assert.equal(summary.savedUsd, 0);
  assert.equal(summary.unpricedEntries, 1);
});

test("reloads older token-only JSONL rows without requiring money fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "residual-ledger-legacy-"));
  const file = join(dir, "residual-ledger.jsonl");
  writeFileSync(
    file,
    `${JSON.stringify({ at: "2026-11-18T20:00:00.000Z", host: "dsh", tokensBefore: 10_000, tokensAfter: 6_000, sessionId: "old" })}\n`,
    "utf8",
  );
  const loaded = SavingsLedger.load(file);
  assert.equal(loaded.tokensSaved({ sessionId: "old" }), 4_000);
  assert.equal(loaded.sessionSummary("old").unpricedEntries, 1);
  assert.equal(loaded.sessionSummary("old").savedUsd, 0);
});
