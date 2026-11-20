import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSavedRange,
  formatUsd,
  priceInputTokens,
  ratePeriodAt,
  resolveCatalogModel,
} from "../src/pricing.ts";

test("maps official and legacy DeepSeek model names, refuses unknown ones", () => {
  assert.equal(resolveCatalogModel("deepseek-flash"), "deepseek-flash");
  assert.equal(resolveCatalogModel("deepseek-v4-flash"), "deepseek-flash");
  assert.equal(resolveCatalogModel("deepseek-v4-flash-vision-exp"), "deepseek-flash");
  assert.equal(resolveCatalogModel("deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(resolveCatalogModel("deepseek-chat"), undefined);
  assert.equal(resolveCatalogModel(undefined), undefined);
});

test("official peak windows are weekday UTC only, half-open, weekends off-peak", () => {
  assert.equal(ratePeriodAt(new Date("2026-11-18T07:00:00.000Z")), "peak"); // Wed 07:00
  assert.equal(ratePeriodAt(new Date("2026-11-18T01:00:00.000Z")), "peak");
  assert.equal(ratePeriodAt(new Date("2026-11-18T03:59:00.000Z")), "peak");
  assert.equal(ratePeriodAt(new Date("2026-11-18T04:00:00.000Z")), "off-peak");
  assert.equal(ratePeriodAt(new Date("2026-11-18T05:30:00.000Z")), "off-peak");
  assert.equal(ratePeriodAt(new Date("2026-11-18T10:00:00.000Z")), "off-peak");
  assert.equal(ratePeriodAt(new Date("2026-11-21T07:00:00.000Z")), "off-peak"); // Sat
});

test("prices compacted input tokens at official pro off-peak rates", () => {
  const priced = priceInputTokens({
    tokensBefore: 42_000,
    tokensAfter: 30_000,
    model: "deepseek-v4-pro",
    at: new Date("2026-11-18T20:00:00.000Z"),
  });
  assert.ok(priced);
  assert.equal(priced.ratePeriod, "off-peak");
  assert.equal(priced.costSource, "catalog");
  assert.equal(priced.wouldHavePaidUsd, 0.02772); // 42000 * 0.66 / 1e6
  assert.equal(priced.paidUsd, 0.0198); // 30000 * 0.66 / 1e6
  assert.equal(priced.savedUsd, 0.00792); // 12000 * 0.66 / 1e6
  assert.equal(priced.savedUsdIfCached, 0.000264); // 12000 * 0.022 / 1e6
  assert.equal(formatSavedRange(priced), "$0.000264–$0.007920");
});

test("peak rates are double the off-peak rates for the same model", () => {
  const priced = priceInputTokens({
    tokensBefore: 42_000,
    tokensAfter: 30_000,
    model: "deepseek-v4-pro",
    at: new Date("2026-11-18T07:00:00.000Z"),
  });
  assert.ok(priced);
  assert.equal(priced.ratePeriod, "peak");
  assert.equal(priced.savedUsd, 0.01584);
  assert.equal(priced.savedUsdIfCached, 0.000528);
});

test("does not invent a price for a model missing from the official catalog", () => {
  assert.equal(
    priceInputTokens({ tokensBefore: 10_000, tokensAfter: 4_000, model: "deepseek-chat" }),
    undefined,
  );
  assert.equal(formatUsd(0.00792), "$0.007920");
  assert.equal(formatUsd(1.5), "$1.50");
});
