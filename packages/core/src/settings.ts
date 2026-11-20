import { readFileSync, statSync } from "node:fs";
import { parsePolicyDocument, type PolicyDocument, mergePolicyDocument } from "./policy.ts";
import { YamlParseError, parseYaml } from "./yaml.ts";
import { residualSettingsPath } from "./paths.ts";

export const RESIDUAL_SECTION = "residual";

export type SettingsOrigin = "composition" | "residual-settings.yaml";

export type LiveSettings = {
  document: PolicyDocument;
  origin: SettingsOrigin;
  /** Raw residual section from the file, if present. */
  section?: PolicyDocument;
};

/**
 * Pull the `residual:` mapping out of a parsed YAML document.
 * The file may be a bare policy document (default/providers/models) or
 * wrapped under the `residual:` key.
 */
export function readResidualSection(raw: unknown): PolicyDocument | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new YamlParseError("settings document must be a mapping");
  }
  const record = raw as Record<string, unknown>;
  if (RESIDUAL_SECTION in record) {
    const section = record[RESIDUAL_SECTION];
    if (section === undefined || section === null) return undefined;
    return parsePolicyDocument(section);
  }
  if ("default" in record || "providers" in record || "models" in record) {
    return parsePolicyDocument(record);
  }
  return undefined;
}

export function parseSettingsFile(text: string): PolicyDocument | undefined {
  return readResidualSection(parseYaml(text));
}

function readSectionFromFile(file: string): PolicyDocument | undefined {
  const text = readFileSync(file, "utf8");
  return parseSettingsFile(text);
}

/**
 * Merge a (possibly partial) settings-file section onto the composition
 * baseline. Omitted maps keep the baseline; `models[]` is replaced only
 * when the overlay restates it.
 */
export function applySettingsOverlay(
  base: PolicyDocument,
  section: PolicyDocument | undefined,
): LiveSettings {
  if (section === undefined) {
    return { document: mergePolicyDocument(base, undefined), origin: "composition" };
  }
  return {
    document: mergePolicyDocument(base, section),
    origin: "residual-settings.yaml",
    section,
  };
}

export type WatchSettingsOptions = {
  /** Composition / mount-row baseline. */
  base: PolicyDocument;
  file?: string;
  intervalMs?: number;
  onChange: (live: LiveSettings) => void;
  onError?: (error: Error) => void;
};

/**
 * Poll a local YAML file and report the merged policy whenever the parsed
 * `residual:` section changes. A bad edit keeps the last good policy.
 */
export class SettingsWatcher {
  private readonly file: string;
  private readonly base: PolicyDocument;
  private readonly intervalMs: number;
  private readonly onChange: (live: LiveSettings) => void;
  private readonly onError?: (error: Error) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastFingerprint: string | undefined;
  private live: LiveSettings;

  constructor(options: WatchSettingsOptions) {
    this.file = options.file ?? residualSettingsPath();
    this.base = options.base;
    this.intervalMs = options.intervalMs ?? 1000;
    this.onChange = options.onChange;
    this.onError = options.onError;
    this.live = applySettingsOverlay(this.base, this.readSectionQuietly());
    this.lastFingerprint = fingerprint(this.live.section);
  }

  current(): LiveSettings {
    return this.live;
  }

  /** Poll once and notify on a parsed-section change. */
  poll(): LiveSettings {
    try {
      const section = this.readSectionQuietly();
      const next = fingerprint(section);
      if (next === this.lastFingerprint) return this.live;
      this.lastFingerprint = next;
      this.live = applySettingsOverlay(this.base, section);
      this.onChange(this.live);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError?.(err);
    }
    return this.live;
  }

  start(): () => void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private readSectionQuietly(): PolicyDocument | undefined {
    try {
      statSync(this.file);
    } catch {
      return undefined;
    }
    return readSectionFromFile(this.file);
  }
}

function fingerprint(section: PolicyDocument | undefined): string {
  return JSON.stringify(section ?? null);
}
