/**
 * Layered compaction policy: models[] → providers{} → default, per field.
 *
 * A model-layer `threshold` does not wipe `retain` inherited from the
 * provider or default layer. Each budget may be a window ratio or an
 * absolute token count. Absolute values are converted through the route's
 * declared context window; Residual will not guess a window.
 */

export const DEFAULT_THRESHOLD_RATIO = 0.8;
export const DEFAULT_RETAIN_RATIO = 0.16;

/** Practical lower bound used only as a warning, never a load error. */
export const MIN_COMPACT_GAP_TOKENS = 8192;

export type PolicyLayerName = "models" | "providers" | "default" | "builtin";

export type PolicyLayer = {
  threshold?: number;
  retain?: number;
  thresholdTokens?: number;
  retainTokens?: number;
};

export type ModelPolicyLayer = PolicyLayer & {
  provider: string;
  model: string;
};

export type PolicyDocument = {
  default?: PolicyLayer;
  providers?: Record<string, PolicyLayer>;
  models?: ModelPolicyLayer[];
};

export type Route = {
  provider: string;
  model: string;
};

export type BudgetUnit = "ratio" | "tokens";

export type ResolvedBudget = {
  unit: BudgetUnit;
  ratio: number;
  /** Present when a window was available, or when the unit is already tokens. */
  tokens?: number;
  layer: PolicyLayerName;
};

export type PolicyWarning = {
  code: "shadowed-unit" | "small-gap";
  message: string;
};

export type ResolvedPolicy = {
  route: Route;
  contextWindow?: number;
  threshold: ResolvedBudget;
  retain: ResolvedBudget;
  thresholdRatio: number;
  retainRatio: number;
  thresholdTokens?: number;
  retainTokens?: number;
  unresolvedAbsoluteFields: Array<"thresholdTokens" | "retainTokens">;
  warnings: PolicyWarning[];
};

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * Absolute conversion was required and the route declared no context window.
 * Residual does not invent a window.
 */
export class MissingContextWindowError extends PolicyError {
  readonly route: Route;
  readonly fields: readonly string[];

  constructor(route: Route, fields: readonly string[]) {
    const named = `${route.provider}/${route.model}`;
    super(
      `Residual will not guess a context window for ${named}; ` +
        `absolute field${fields.length === 1 ? "" : "s"} ${fields.join(", ")} ` +
        `cannot be converted without a declared window`,
    );
    this.name = "MissingContextWindowError";
    this.route = route;
    this.fields = fields;
  }
}

const LAYER_KEYS = new Set([
  "threshold",
  "retain",
  "thresholdTokens",
  "retainTokens",
]);

const DOCUMENT_KEYS = new Set(["default", "providers", "models"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRatio(path: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new PolicyError(`${path} (${String(value)}) must be a number in (0, 1]`);
  }
}

function assertTokenBudget(path: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PolicyError(`${path} (${String(value)}) must be a non-negative integer`);
  }
}

function assertNonEmptyString(path: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PolicyError(`${path} must be a non-empty string`);
  }
}

function validateLayerKeys(layer: Record<string, unknown>, path: string, extra: string[] = []): void {
  const allowed = new Set([...LAYER_KEYS, ...extra]);
  for (const key of Object.keys(layer)) {
    if (!allowed.has(key)) throw new PolicyError(`${path}: unknown key "${key}"`);
  }
}

export function validateLayer(layer: PolicyLayer, path: string): PolicyLayer {
  if (!isPlainObject(layer)) throw new PolicyError(`${path} must be an object`);
  validateLayerKeys(layer, path);
  if (layer.threshold !== undefined) assertRatio(`${path}.threshold`, layer.threshold);
  if (layer.retain !== undefined) assertRatio(`${path}.retain`, layer.retain);
  if (layer.thresholdTokens !== undefined) {
    assertTokenBudget(`${path}.thresholdTokens`, layer.thresholdTokens);
  }
  if (layer.retainTokens !== undefined) {
    assertTokenBudget(`${path}.retainTokens`, layer.retainTokens);
  }
  return { ...layer };
}

export function parsePolicyDocument(input: unknown): PolicyDocument {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) throw new PolicyError("policy document must be an object");
  for (const key of Object.keys(input)) {
    if (!DOCUMENT_KEYS.has(key)) throw new PolicyError(`policy document: unknown key "${key}"`);
  }

  const document: PolicyDocument = {};
  if (input.default !== undefined) {
    document.default = validateLayer(input.default as PolicyLayer, "default");
  }
  if (input.providers !== undefined) {
    if (!isPlainObject(input.providers)) {
      throw new PolicyError("providers must be a mapping of provider name to layer");
    }
    const providers: Record<string, PolicyLayer> = {};
    for (const [name, layer] of Object.entries(input.providers)) {
      assertNonEmptyString(`providers key`, name);
      providers[name] = validateLayer(layer as PolicyLayer, `providers.${name}`);
    }
    document.providers = providers;
  }
  if (input.models !== undefined) {
    if (!Array.isArray(input.models)) throw new PolicyError("models must be an array");
    document.models = input.models.map((entry, index) => {
      if (!isPlainObject(entry)) throw new PolicyError(`models[${index}] must be an object`);
      assertNonEmptyString(`models[${index}].provider`, entry.provider);
      assertNonEmptyString(`models[${index}].model`, entry.model);
      const { provider, model, ...rest } = entry;
      const layer = validateLayer(rest as PolicyLayer, `models[${index}]`);
      return { provider, model, ...layer };
    });
  }
  return document;
}

/**
 * Partial-document merge: maps recurse, arrays replace wholesale, omitted
 * keys keep the baseline, and an explicit `undefined` also keeps the baseline
 * so a panel save cannot wipe model-specific policies it did not restate.
 */
export function mergePolicyDocument(
  base: PolicyDocument,
  overlay: PolicyDocument | undefined | null,
): PolicyDocument {
  if (overlay === undefined || overlay === null) return cloneDocument(base);
  return {
    default: mergeLayer(base.default, overlay.default),
    providers: mergeProviderMap(base.providers, overlay.providers),
    models: overlay.models !== undefined ? cloneModels(overlay.models) : cloneModels(base.models),
  };
}

function mergeLayer(
  base: PolicyLayer | undefined,
  overlay: PolicyLayer | undefined,
): PolicyLayer | undefined {
  if (overlay === undefined) return base === undefined ? undefined : { ...base };
  if (base === undefined) return { ...overlay };
  const merged: PolicyLayer = { ...base };
  for (const key of LAYER_KEYS) {
    const value = overlay[key as keyof PolicyLayer];
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

function mergeProviderMap(
  base: Record<string, PolicyLayer> | undefined,
  overlay: Record<string, PolicyLayer> | undefined,
): Record<string, PolicyLayer> | undefined {
  if (overlay === undefined) {
    return base === undefined ? undefined : Object.fromEntries(
      Object.entries(base).map(([key, layer]) => [key, { ...layer }]),
    );
  }
  const merged: Record<string, PolicyLayer> = {};
  for (const [key, layer] of Object.entries(base ?? {})) merged[key] = { ...layer };
  for (const [key, layer] of Object.entries(overlay)) {
    merged[key] = mergeLayer(merged[key], layer) ?? { ...layer };
  }
  return merged;
}

function cloneModels(models: ModelPolicyLayer[] | undefined): ModelPolicyLayer[] | undefined {
  if (models === undefined) return undefined;
  return models.map((entry) => ({ ...entry }));
}

function cloneDocument(document: PolicyDocument): PolicyDocument {
  return {
    default: document.default === undefined ? undefined : { ...document.default },
    providers: mergeProviderMap(document.providers, undefined),
    models: cloneModels(document.models),
  };
}

type PickedForm = {
  unit: BudgetUnit;
  ratio?: number;
  tokens?: number;
  layer: PolicyLayerName;
  shadowed?: PolicyWarning;
};

function layersFor(document: PolicyDocument, route: Route): Array<{ name: PolicyLayerName; layer: PolicyLayer }> {
  const layers: Array<{ name: PolicyLayerName; layer: PolicyLayer }> = [];
  const model = document.models?.find(
    (entry) => entry.provider === route.provider && entry.model === route.model,
  );
  if (model) layers.push({ name: "models", layer: model });
  const provider = document.providers?.[route.provider];
  if (provider) layers.push({ name: "providers", layer: provider });
  if (document.default) layers.push({ name: "default", layer: document.default });
  return layers;
}

function pickForm(
  layers: Array<{ name: PolicyLayerName; layer: PolicyLayer }>,
  ratioKey: "threshold" | "retain",
  tokensKey: "thresholdTokens" | "retainTokens",
): PickedForm | undefined {
  for (const { name, layer } of layers) {
    const tokens = layer[tokensKey];
    const ratio = layer[ratioKey];
    if (tokens === undefined && ratio === undefined) continue;
    if (tokens !== undefined && ratio !== undefined) {
      return {
        unit: "tokens",
        tokens,
        ratio,
        layer: name,
        shadowed: {
          code: "shadowed-unit",
          message:
            `${name} states both ${ratioKey} (${ratio}) and ${tokensKey} (${tokens}); ` +
            `the token form wins`,
        },
      };
    }
    if (tokens !== undefined) return { unit: "tokens", tokens, layer: name };
    return { unit: "ratio", ratio, layer: name };
  }
  return undefined;
}

function convertBudget(
  picked: PickedForm | undefined,
  fallbackRatio: number,
  tokensKey: "thresholdTokens" | "retainTokens",
  window: number | undefined,
  unresolved: Array<"thresholdTokens" | "retainTokens">,
): ResolvedBudget {
  if (picked === undefined) {
    return {
      unit: "ratio",
      ratio: fallbackRatio,
      tokens: window === undefined ? undefined : Math.floor(window * fallbackRatio),
      layer: "builtin",
    };
  }
  if (picked.unit === "tokens") {
    const tokens = picked.tokens!;
    if (window === undefined) {
      unresolved.push(tokensKey);
      return { unit: "tokens", ratio: Number.NaN, tokens, layer: picked.layer };
    }
    return {
      unit: "tokens",
      ratio: (tokens + 0.5) / window,
      tokens,
      layer: picked.layer,
    };
  }
  const ratio = picked.ratio!;
  return {
    unit: "ratio",
    ratio,
    tokens: window === undefined ? undefined : Math.floor(window * ratio),
    layer: picked.layer,
  };
}

/**
 * Resolve the effective policy for one route. Does not throw on a missing
 * window; call {@link requireResolvedPolicy} before feeding official engines.
 */
export function resolvePolicy(
  document: PolicyDocument,
  route: Route,
  contextWindow?: number,
): ResolvedPolicy {
  const window =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  const layers = layersFor(document, route);
  const warnings: PolicyWarning[] = [];
  const unresolved: Array<"thresholdTokens" | "retainTokens"> = [];

  const thresholdPicked = pickForm(layers, "threshold", "thresholdTokens");
  const retainPicked = pickForm(layers, "retain", "retainTokens");
  if (thresholdPicked?.shadowed) warnings.push(thresholdPicked.shadowed);
  if (retainPicked?.shadowed) warnings.push(retainPicked.shadowed);

  const threshold = convertBudget(
    thresholdPicked,
    DEFAULT_THRESHOLD_RATIO,
    "thresholdTokens",
    window,
    unresolved,
  );
  const retain = convertBudget(
    retainPicked,
    DEFAULT_RETAIN_RATIO,
    "retainTokens",
    window,
    unresolved,
  );

  const comparable =
    window !== undefined
      ? (retain.tokens ?? 0) >= (threshold.tokens ?? 0)
      : Number.isFinite(retain.ratio) &&
        Number.isFinite(threshold.ratio) &&
        retain.ratio >= threshold.ratio;

  if (unresolved.length === 0 && comparable) {
    const retainText =
      retain.tokens !== undefined ? `${retain.tokens} tokens` : `ratio ${retain.ratio}`;
    const thresholdText =
      threshold.tokens !== undefined ? `${threshold.tokens} tokens` : `ratio ${threshold.ratio}`;
    throw new PolicyError(
      `retain (${retainText}) must be less than threshold (${thresholdText}) for ${route.provider}/${route.model}`,
    );
  }

  if (window !== undefined && threshold.tokens !== undefined && retain.tokens !== undefined) {
    const gap = threshold.tokens - retain.tokens;
    if (gap < MIN_COMPACT_GAP_TOKENS) {
      warnings.push({
        code: "small-gap",
        message:
          `threshold (${threshold.tokens}) leaves only ${gap} tokens above retain (${retain.tokens}); ` +
          `summaries that cannot shrink their source will be rejected`,
      });
    }
  }

  return {
    route: { provider: route.provider, model: route.model },
    contextWindow: window,
    threshold,
    retain,
    thresholdRatio: threshold.ratio,
    retainRatio: retain.ratio,
    thresholdTokens: threshold.tokens,
    retainTokens: retain.tokens,
    unresolvedAbsoluteFields: unresolved,
    warnings,
  };
}

/** Throw if absolute fields could not be converted for want of a window. */
export function requireResolvedPolicy(policy: ResolvedPolicy): ResolvedPolicy {
  if (policy.unresolvedAbsoluteFields.length > 0) {
    throw new MissingContextWindowError(policy.route, policy.unresolvedAbsoluteFields);
  }
  return policy;
}

/**
 * Official `BasicCompactionEngine` consumes ratios (`thresholdRatio`) and
 * optional absolute `retainTokens`. To honor an absolute threshold exactly,
 * write `(tokens + 0.5) / window` so the parent's `floor(window * ratio)`
 * returns the declared token count.
 */
export type OfficialBasicConfigSlice = {
  thresholdRatio: number;
  retainRatio?: number;
  retainTokens?: number;
};

export function toOfficialBasicConfig(policy: ResolvedPolicy): OfficialBasicConfigSlice {
  requireResolvedPolicy(policy);
  const config: OfficialBasicConfigSlice = { thresholdRatio: policy.thresholdRatio };
  if (policy.retain.unit === "tokens" && policy.retainTokens !== undefined) {
    config.retainTokens = policy.retainTokens;
  } else {
    config.retainRatio = policy.retainRatio;
  }
  return config;
}

/**
 * Official parent config that is safe at engine construction, when no
 * context window is in hand yet.
 *
 * Residual still does not guess a window. If absolute fields are
 * unresolved, this falls back to builtin (or already-resolved) ratios
 * so the plugin can activate. Call {@link toOfficialBasicConfig} from
 * apply paths once a window is known; those paths still throw
 * {@link MissingContextWindowError}.
 */
export function toBootOfficialConfig(policy: ResolvedPolicy): OfficialBasicConfigSlice {
  if (policy.unresolvedAbsoluteFields.length === 0 && Number.isFinite(policy.thresholdRatio)) {
    return toOfficialBasicConfig(policy);
  }
  const thresholdRatio = Number.isFinite(policy.thresholdRatio)
    ? policy.thresholdRatio
    : DEFAULT_THRESHOLD_RATIO;
  const retainRatio = Number.isFinite(policy.retainRatio)
    ? policy.retainRatio
    : DEFAULT_RETAIN_RATIO;
  if (retainRatio >= thresholdRatio) {
    return {
      thresholdRatio: DEFAULT_THRESHOLD_RATIO,
      retainRatio: DEFAULT_RETAIN_RATIO,
    };
  }
  return { thresholdRatio, retainRatio };
}
