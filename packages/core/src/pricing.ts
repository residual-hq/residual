/**
 * Official DeepSeek catalog prices for converting compacted input tokens
 * into a dollar estimate. This is not a vendor invoice.
 *
 * Source: https://api-docs.deepseek.com/quick_start/pricing/
 * Retrieved: 2026-11-19. Prices can change; re-check that page.
 *
 * Residual measures context tokens before and after compaction. Those are
 * priced as input tokens. Cache hit vs miss for the avoided tokens is not
 * known, so both rates are recorded. Peak hours follow the official UTC
 * weekday windows; Chinese public holidays are not applied in this version.
 */

export const PRICE_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/";
export const PRICE_AS_OF = "2026-11-19";
export const PRICE_CURRENCY = "USD" as const;

export type RatePeriod = "peak" | "off-peak";
export type CacheBand = "hit" | "miss";
export type CatalogModelId = "deepseek-flash" | "deepseek-v4-pro";

export type CatalogRates = {
  inputCacheHitPerMillion: { offPeak: number; peak: number };
  inputCacheMissPerMillion: { offPeak: number; peak: number };
  outputPerMillion: { offPeak: number; peak: number };
};

/** Official per-1M-token USD rates from the pricing page retrieved on PRICE_AS_OF. */
export const DEEPSEEK_CATALOG: Record<CatalogModelId, CatalogRates> = {
  "deepseek-flash": {
    inputCacheHitPerMillion: { offPeak: 0.003, peak: 0.006 },
    inputCacheMissPerMillion: { offPeak: 0.15, peak: 0.3 },
    outputPerMillion: { offPeak: 0.6, peak: 1.2 },
  },
  "deepseek-v4-pro": {
    inputCacheHitPerMillion: { offPeak: 0.022, peak: 0.044 },
    inputCacheMissPerMillion: { offPeak: 0.66, peak: 1.32 },
    outputPerMillion: { offPeak: 1.98, peak: 3.96 },
  },
};

const FLASH_ALIASES = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

const PRO_ALIASES = new Set(["deepseek-v4-pro"]);

export function resolveCatalogModel(model: string | undefined): CatalogModelId | undefined {
  if (!model) return undefined;
  const key = model.trim().toLowerCase();
  if (FLASH_ALIASES.has(key)) return "deepseek-flash";
  if (PRO_ALIASES.has(key)) return "deepseek-v4-pro";
  return undefined;
}

/**
 * Official peak windows: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday.
 * Interpreted as half-open intervals. Weekends are off-peak. Holiday
 * exceptions are not applied here.
 */
export function ratePeriodAt(at: Date): RatePeriod {
  const day = at.getUTCDay(); // 0 Sun … 6 Sat
  if (day === 0 || day === 6) return "off-peak";
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  const inPeak = (minutes >= 1 * 60 && minutes < 4 * 60) || (minutes >= 6 * 60 && minutes < 10 * 60);
  return inPeak ? "peak" : "off-peak";
}

/** USD nanos (1e-9) so token × rate math stays an integer. */
export function inputCostUsdNanos(
  tokens: number,
  rates: CatalogRates,
  period: RatePeriod,
  cache: CacheBand,
): number {
  const safe = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  const band = cache === "hit" ? rates.inputCacheHitPerMillion : rates.inputCacheMissPerMillion;
  const perMillion = period === "peak" ? band.peak : band.offPeak;
  return Math.round(safe * perMillion * 1000);
}

export function usdFromNanos(nanos: number): number {
  return nanos / 1_000_000_000;
}

export type PricedInput = {
  currency: typeof PRICE_CURRENCY;
  catalogModel: CatalogModelId;
  ratePeriod: RatePeriod;
  costSource: "catalog";
  priceSource: typeof PRICE_SOURCE;
  priceAsOf: typeof PRICE_AS_OF;
  wouldHavePaidUsd: number;
  paidUsd: number;
  savedUsd: number;
  wouldHavePaidUsdIfCached: number;
  paidUsdIfCached: number;
  savedUsdIfCached: number;
};

export function priceInputTokens(options: {
  tokensBefore: number;
  tokensAfter: number;
  model?: string;
  at?: Date;
}): PricedInput | undefined {
  const catalogModel = resolveCatalogModel(options.model);
  if (!catalogModel) return undefined;
  const rates = DEEPSEEK_CATALOG[catalogModel];
  const period = ratePeriodAt(options.at ?? new Date());
  const before = Math.max(0, options.tokensBefore);
  const after = Math.max(0, options.tokensAfter);
  const missBefore = inputCostUsdNanos(before, rates, period, "miss");
  const missAfter = inputCostUsdNanos(after, rates, period, "miss");
  const hitBefore = inputCostUsdNanos(before, rates, period, "hit");
  const hitAfter = inputCostUsdNanos(after, rates, period, "hit");
  return {
    currency: PRICE_CURRENCY,
    catalogModel,
    ratePeriod: period,
    costSource: "catalog",
    priceSource: PRICE_SOURCE,
    priceAsOf: PRICE_AS_OF,
    wouldHavePaidUsd: usdFromNanos(missBefore),
    paidUsd: usdFromNanos(missAfter),
    savedUsd: usdFromNanos(Math.max(0, missBefore - missAfter)),
    wouldHavePaidUsdIfCached: usdFromNanos(hitBefore),
    paidUsdIfCached: usdFromNanos(hitAfter),
    savedUsdIfCached: usdFromNanos(Math.max(0, hitBefore - hitAfter)),
  };
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value === 0) return "$0";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

/** Customer-facing range: cache-hit (low) to cache-miss (high). */
export function formatSavedRange(priced: PricedInput): string {
  const low = priced.savedUsdIfCached;
  const high = priced.savedUsd;
  if (low === high) return formatUsd(high);
  return `${formatUsd(low)}–${formatUsd(high)}`;
}
