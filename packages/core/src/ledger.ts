import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PRICE_AS_OF,
  PRICE_CURRENCY,
  PRICE_SOURCE,
  formatUsd,
  priceInputTokens,
  type RatePeriod,
} from "./pricing.ts";

export type TokenCount = number;

export type LedgerEntry = {
  at: string;
  host: string;
  tokensBefore: TokenCount;
  tokensAfter: TokenCount;
  sessionId?: string;
  provider?: string;
  model?: string;
  currency?: typeof PRICE_CURRENCY;
  wouldHavePaidUsd?: number;
  paidUsd?: number;
  savedUsd?: number;
  wouldHavePaidUsdIfCached?: number;
  paidUsdIfCached?: number;
  savedUsdIfCached?: number;
  ratePeriod?: RatePeriod;
  costSource?: "catalog" | "unknown_model_price";
  priceSource?: string;
  priceAsOf?: string;
};

export type MoneyTotals = {
  currency: typeof PRICE_CURRENCY;
  wouldHavePaidUsd: number;
  paidUsd: number;
  savedUsd: number;
  wouldHavePaidUsdIfCached: number;
  paidUsdIfCached: number;
  savedUsdIfCached: number;
  unpricedEntries: number;
};

export type SessionSummary = {
  host?: string;
  sessionId?: string;
  entries: number;
  tokensBefore: TokenCount;
  tokensAfter: TokenCount;
  tokensSaved: TokenCount;
} & MoneyTotals;

export type LedgerFilter = {
  host?: string;
  sessionId?: string;
};

export type SavingsLedgerOptions = {
  /** JSONL file. Token counts and catalog dollar estimates; never prompts. */
  file?: string;
  /** Optional JSON snapshot rewritten after each record, next to the JSONL by default. */
  summaryFile?: string;
  host?: string;
  sessionId?: string;
};

function tokensSavedOf(entry: LedgerEntry): TokenCount {
  return Math.max(0, entry.tokensBefore - entry.tokensAfter);
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<LedgerEntry>;
  return (
    typeof row.at === "string" &&
    typeof row.host === "string" &&
    typeof row.tokensBefore === "number" &&
    typeof row.tokensAfter === "number"
  );
}

function readJsonl(file: string): LedgerEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return [];
    throw error;
  }
  const entries: LedgerEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (isLedgerEntry(parsed)) entries.push(parsed);
  }
  return entries;
}

function emptyMoney(): MoneyTotals {
  return {
    currency: PRICE_CURRENCY,
    wouldHavePaidUsd: 0,
    paidUsd: 0,
    savedUsd: 0,
    wouldHavePaidUsdIfCached: 0,
    paidUsdIfCached: 0,
    savedUsdIfCached: 0,
    unpricedEntries: 0,
  };
}

function addMoney(total: MoneyTotals, row: LedgerEntry): void {
  if (row.costSource === "catalog" && typeof row.savedUsd === "number") {
    total.wouldHavePaidUsd += row.wouldHavePaidUsd ?? 0;
    total.paidUsd += row.paidUsd ?? 0;
    total.savedUsd += row.savedUsd ?? 0;
    total.wouldHavePaidUsdIfCached += row.wouldHavePaidUsdIfCached ?? 0;
    total.paidUsdIfCached += row.paidUsdIfCached ?? 0;
    total.savedUsdIfCached += row.savedUsdIfCached ?? 0;
  } else {
    total.unpricedEntries += 1;
  }
}

function defaultSummaryFile(ledgerFile: string | undefined): string | undefined {
  if (!ledgerFile) return undefined;
  return join(dirname(ledgerFile), "residual-savings.json");
}

export class SavingsLedger {
  readonly file: string | undefined;
  readonly summaryFile: string | undefined;
  readonly host: string;
  readonly sessionId: string | undefined;
  private readonly rows: LedgerEntry[] = [];

  constructor(options: SavingsLedgerOptions = {}) {
    this.file = options.file;
    this.summaryFile = options.summaryFile ?? defaultSummaryFile(options.file);
    this.host = options.host ?? "dsh";
    this.sessionId = options.sessionId;
    if (this.file) this.rows.push(...readJsonl(this.file));
  }

  static load(file: string, options: Omit<SavingsLedgerOptions, "file"> = {}): SavingsLedger {
    return new SavingsLedger({ ...options, file });
  }

  entries(): readonly LedgerEntry[] {
    return this.rows.map((row) => ({ ...row }));
  }

  record(
    entry: Omit<LedgerEntry, "at" | "host"> & { at?: string; host?: string },
  ): LedgerEntry {
    const at = entry.at ?? new Date().toISOString();
    const priced = priceInputTokens({
      tokensBefore: entry.tokensBefore,
      tokensAfter: entry.tokensAfter,
      model: entry.model,
      at: new Date(at),
    });
    const row: LedgerEntry = {
      at,
      host: entry.host ?? this.host,
      tokensBefore: entry.tokensBefore,
      tokensAfter: entry.tokensAfter,
      ...(entry.sessionId ?? this.sessionId
        ? { sessionId: entry.sessionId ?? this.sessionId }
        : {}),
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(priced
        ? {
            currency: priced.currency,
            wouldHavePaidUsd: priced.wouldHavePaidUsd,
            paidUsd: priced.paidUsd,
            savedUsd: priced.savedUsd,
            wouldHavePaidUsdIfCached: priced.wouldHavePaidUsdIfCached,
            paidUsdIfCached: priced.paidUsdIfCached,
            savedUsdIfCached: priced.savedUsdIfCached,
            ratePeriod: priced.ratePeriod,
            costSource: priced.costSource,
            priceSource: priced.priceSource,
            priceAsOf: priced.priceAsOf,
          }
        : entry.model
          ? { costSource: "unknown_model_price" as const }
          : {}),
    };
    this.rows.push(row);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(row)}\n`, "utf8");
    }
    this.writeSummary();
    return row;
  }

  tokensSaved(filter: LedgerFilter = {}): TokenCount {
    return this.matching(filter).reduce((sum, row) => sum + tokensSavedOf(row), 0);
  }

  sessionSummary(sessionId = this.sessionId, host?: string): SessionSummary {
    const filter: LedgerFilter = {
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(host !== undefined ? { host } : {}),
    };
    const rows = this.matching(filter);
    const money = emptyMoney();
    for (const row of rows) addMoney(money, row);
    return {
      ...(host !== undefined ? { host } : sessionId === undefined ? {} : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      entries: rows.length,
      tokensBefore: rows.reduce((sum, row) => sum + row.tokensBefore, 0),
      tokensAfter: rows.reduce((sum, row) => sum + row.tokensAfter, 0),
      tokensSaved: rows.reduce((sum, row) => sum + tokensSavedOf(row), 0),
      ...money,
    };
  }

  lifetimeSummary(filter: LedgerFilter = {}): SessionSummary {
    const rows = this.matching(filter);
    const money = emptyMoney();
    for (const row of rows) addMoney(money, row);
    return {
      entries: rows.length,
      tokensBefore: rows.reduce((sum, row) => sum + row.tokensBefore, 0),
      tokensAfter: rows.reduce((sum, row) => sum + row.tokensAfter, 0),
      tokensSaved: rows.reduce((sum, row) => sum + tokensSavedOf(row), 0),
      ...money,
    };
  }

  formatRecordLine(row: LedgerEntry, sessionSavedTokens: TokenCount): string {
    const tokenPart = `session saved ${sessionSavedTokens} tokens (before=${row.tokensBefore} after=${row.tokensAfter})`;
    if (row.costSource === "catalog" && row.savedUsd !== undefined && row.savedUsdIfCached !== undefined) {
      const range =
        row.savedUsdIfCached === row.savedUsd
          ? formatUsd(row.savedUsd)
          : `${formatUsd(row.savedUsdIfCached)}–${formatUsd(row.savedUsd)}`;
      return `[residual] ${tokenPart}, about ${range} (would have paid ${formatUsd(row.wouldHavePaidUsd ?? 0)}, paid ${formatUsd(row.paidUsd ?? 0)} at cache-miss ${row.ratePeriod}; catalog estimate, not an invoice)`;
    }
    if (row.costSource === "unknown_model_price") {
      return `[residual] ${tokenPart} (no official catalog price for model ${row.model}; dollars not estimated)`;
    }
    return `[residual] ${tokenPart}`;
  }

  writeSummary(): void {
    if (!this.summaryFile) return;
    const lifetime = this.lifetimeSummary();
    const sessions = new Map<string, SessionSummary>();
    for (const row of this.rows) {
      const key = `${row.host}\t${row.sessionId ?? ""}`;
      if (!sessions.has(key)) {
        sessions.set(key, this.sessionSummary(row.sessionId, row.host));
      }
    }
    const body = {
      currency: PRICE_CURRENCY,
      priceSource: PRICE_SOURCE,
      priceAsOf: PRICE_AS_OF,
      disclaimer:
        "Catalog estimate for reduced input context at official DeepSeek prices. Not a vendor invoice. Cache hit vs miss for the avoided tokens is unknown, so both are shown (savedUsd is cache-miss, savedUsdIfCached is cache-hit). Peak hours follow official UTC weekday windows; Chinese public holidays are not applied in this version. Prompts are never stored.",
      lifetime,
      sessions: [...sessions.values()],
    };
    mkdirSync(dirname(this.summaryFile), { recursive: true });
    const tmp = `${this.summaryFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    renameSync(tmp, this.summaryFile);
  }

  private matching(filter: LedgerFilter): LedgerEntry[] {
    return this.rows.filter((row) => {
      if (filter.host !== undefined && row.host !== filter.host) return false;
      if (filter.sessionId !== undefined && row.sessionId !== filter.sessionId) return false;
      return true;
    });
  }
}
