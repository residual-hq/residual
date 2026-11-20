import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RETAIN_RATIO,
  DEFAULT_THRESHOLD_RATIO,
  MissingContextWindowError,
  PolicyError,
  mergePolicyDocument,
  parsePolicyDocument,
  requireResolvedPolicy,
  resolvePolicy,
  toBootOfficialConfig,
  toOfficialBasicConfig,
  type PolicyDocument,
} from "../src/policy.ts";

const route = { provider: "deepseek", model: "deepseek-chat" };

const document: PolicyDocument = {
  default: { threshold: 0.8, retain: 0.16 },
  providers: {
    deepseek: { threshold: 0.5, retain: 0.1 },
  },
  models: [
    { provider: "deepseek", model: "deepseek-chat", threshold: 0.9 },
  ],
};

test("model layer overrides only the fields it states; retain is inherited", () => {
  const policy = resolvePolicy(document, route, 100_000);
  assert.equal(policy.threshold.layer, "models");
  assert.equal(policy.threshold.unit, "ratio");
  assert.equal(policy.thresholdRatio, 0.9);
  assert.equal(policy.retain.layer, "providers");
  assert.equal(policy.retainRatio, 0.1);
  assert.equal(policy.thresholdTokens, 90_000);
  assert.equal(policy.retainTokens, 10_000);
});

test("provider layer wins over default when no model row matches", () => {
  const policy = resolvePolicy(document, { provider: "deepseek", model: "deepseek-reasoner" }, 80_000);
  assert.equal(policy.threshold.layer, "providers");
  assert.equal(policy.thresholdRatio, 0.5);
  assert.equal(policy.retain.layer, "providers");
  assert.equal(policy.retainRatio, 0.1);
});

test("default layer is used when provider and model are unknown", () => {
  const policy = resolvePolicy(document, { provider: "openai", model: "gpt-4.1" }, 128_000);
  assert.equal(policy.threshold.layer, "default");
  assert.equal(policy.retain.layer, "default");
  assert.equal(policy.thresholdRatio, 0.8);
  assert.equal(policy.retainRatio, 0.16);
});

test("builtin ratios apply when the document is empty", () => {
  const policy = resolvePolicy({}, route, 10_000);
  assert.equal(policy.threshold.layer, "builtin");
  assert.equal(policy.retain.layer, "builtin");
  assert.equal(policy.thresholdRatio, DEFAULT_THRESHOLD_RATIO);
  assert.equal(policy.retainRatio, DEFAULT_RETAIN_RATIO);
  assert.equal(policy.thresholdTokens, 8000);
  assert.equal(policy.retainTokens, 1600);
});

test("absolute tokens convert through the declared window; parent floor is exact", () => {
  const policy = resolvePolicy(
    { default: { thresholdTokens: 40_000, retainTokens: 8_000 } },
    route,
    100_000,
  );
  assert.equal(policy.threshold.unit, "tokens");
  assert.equal(policy.thresholdTokens, 40_000);
  assert.equal(policy.retainTokens, 8_000);
  assert.equal(Math.floor(100_000 * policy.thresholdRatio), 40_000);
  const official = toOfficialBasicConfig(policy);
  assert.equal(Math.floor(100_000 * official.thresholdRatio), 40_000);
  assert.equal(official.retainTokens, 8_000);
  assert.equal(official.retainRatio, undefined);
});

test("refuses to guess a context window when an absolute field must be converted", () => {
  const policy = resolvePolicy(
    { default: { thresholdTokens: 40_000, retain: 0.16 } },
    route,
  );
  assert.deepEqual(policy.unresolvedAbsoluteFields, ["thresholdTokens"]);
  assert.throws(
    () => requireResolvedPolicy(policy),
    (error: unknown) => {
      assert.ok(error instanceof MissingContextWindowError);
      assert.equal(error.route.provider, "deepseek");
      assert.equal(error.route.model, "deepseek-chat");
      assert.deepEqual([...error.fields], ["thresholdTokens"]);
      assert.match(error.message, /deepseek\/deepseek-chat/);
      assert.match(error.message, /will not guess/);
      return true;
    },
  );
  assert.throws(() => toOfficialBasicConfig(policy), MissingContextWindowError);
});

test("ratio-only policies resolve without a window", () => {
  const policy = resolvePolicy({ default: { threshold: 0.7, retain: 0.2 } }, route);
  assert.equal(policy.unresolvedAbsoluteFields.length, 0);
  assert.equal(policy.thresholdRatio, 0.7);
  assert.equal(policy.thresholdTokens, undefined);
  requireResolvedPolicy(policy);
});

test("token form wins when a layer states both units, and a warning is recorded", () => {
  const policy = resolvePolicy(
    { default: { threshold: 0.8, thresholdTokens: 50_000, retain: 0.16 } },
    route,
    100_000,
  );
  assert.equal(policy.threshold.unit, "tokens");
  assert.equal(policy.thresholdTokens, 50_000);
  assert.equal(policy.warnings.some((warning) => warning.code === "shadowed-unit"), true);
});

test("retain must stay strictly below threshold", () => {
  assert.throws(
    () => resolvePolicy({ default: { threshold: 0.5, retain: 0.5 } }, route, 10_000),
    PolicyError,
  );
  assert.throws(
    () =>
      resolvePolicy(
        { default: { thresholdTokens: 1000, retainTokens: 1000 } },
        route,
        10_000,
      ),
    /must be less than threshold/,
  );
});

test("partial document merge keeps models[] the overlay did not restate", () => {
  const merged = mergePolicyDocument(document, { default: { threshold: 0.3 } });
  assert.equal(merged.default?.threshold, 0.3);
  assert.equal(merged.default?.retain, 0.16, "omitted retain stays on the baseline default");
  assert.equal(merged.providers?.deepseek?.threshold, 0.5);
  assert.equal(merged.models?.length, 1);
  assert.equal(merged.models?.[0]?.model, "deepseek-chat");
});

test("partial merge replaces models[] only when the overlay restates the array", () => {
  const merged = mergePolicyDocument(document, {
    models: [{ provider: "local", model: "tiny", threshold: 0.6 }],
  });
  assert.equal(merged.models?.length, 1);
  assert.equal(merged.models?.[0]?.model, "tiny");
  assert.equal(merged.default?.threshold, 0.8);
});

test("parsePolicyDocument rejects unknown keys and invalid ratios", () => {
  assert.throws(() => parsePolicyDocument({ foo: 1 }), /unknown key/);
  assert.throws(() => parsePolicyDocument({ default: { threshold: 1.2 } }), /in \(0, 1]/);
  assert.throws(
    () => parsePolicyDocument({ models: [{ provider: "x", model: "", threshold: 0.5 }] }),
    /non-empty string/,
  );
});

test("boot config keeps the plugin activatable when absolute fields have no window", () => {
  const policy = resolvePolicy(
    { default: { thresholdTokens: 40_000, retainTokens: 8_000 } },
    route,
  );
  assert.deepEqual(policy.unresolvedAbsoluteFields, ["thresholdTokens", "retainTokens"]);
  assert.throws(() => toOfficialBasicConfig(policy), MissingContextWindowError);
  const boot = toBootOfficialConfig(policy);
  assert.equal(boot.thresholdRatio, DEFAULT_THRESHOLD_RATIO);
  assert.equal(boot.retainRatio, DEFAULT_RETAIN_RATIO);
  assert.equal(boot.retainTokens, undefined);
});

test("boot config matches official config when the policy is already resolved", () => {
  const ratio = resolvePolicy({ default: { threshold: 0.7, retain: 0.2 } }, route);
  assert.deepEqual(toBootOfficialConfig(ratio), toOfficialBasicConfig(ratio));
  const absolute = resolvePolicy(
    { default: { thresholdTokens: 40_000, retainTokens: 8_000 } },
    route,
    100_000,
  );
  assert.deepEqual(toBootOfficialConfig(absolute), toOfficialBasicConfig(absolute));
});

test("boot config keeps a resolved ratio when only the other field is unresolved", () => {
  const policy = resolvePolicy(
    { default: { threshold: 0.7, retainTokens: 8_000 } },
    route,
  );
  assert.deepEqual(policy.unresolvedAbsoluteFields, ["retainTokens"]);
  const boot = toBootOfficialConfig(policy);
  assert.equal(boot.thresholdRatio, 0.7);
  assert.equal(boot.retainRatio, DEFAULT_RETAIN_RATIO);
});
