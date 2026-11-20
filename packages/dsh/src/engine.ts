/**
 * Residual compaction engine for DeepSeek Harness.
 *
 * Subclasses the official BasicCompactionEngine so region selection, tool
 * pairing, summary framing, and the durable transaction stay official.
 * Residual only decides the layered policy, records a local savings ledger,
 * and (optionally) attaches an append-only tool gate.
 *
 * Entry id: residual-engine. Do not reuse compaction-control ids.
 */

import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import z from "@deepseek-ai/schemastery";
import {
  MissingContextWindowError,
  SavingsLedger,
  SettingsWatcher,
  parsePolicyDocument,
  requireResolvedPolicy,
  resolvePolicy,
  residualLedgerPath,
  residualSavingsPath,
  residualSettingsPath,
  toBootOfficialConfig,
  toOfficialBasicConfig,
  type PolicyDocument,
  type Route,
} from "@residualhq/core";
import { ResidualToolGateHost, type ToolsHost } from "./tool-gate-host.ts";

const ratio = z.number();
const tokenBudget = z.number();

const layer = z.object({
  threshold: ratio,
  retain: ratio,
  thresholdTokens: tokenBudget,
  retainTokens: tokenBudget,
});

const modelLayer = z.object({
  provider: z.string(),
  model: z.string(),
  threshold: ratio,
  retain: ratio,
  thresholdTokens: tokenBudget,
  retainTokens: tokenBudget,
});

export type ResidualEngineConfig = PolicyDocument & {
  auto?: boolean;
  toolGate?: { enabled?: boolean };
};

function documentOf(config: ResidualEngineConfig | undefined): PolicyDocument {
  const { auto: _auto, toolGate: _toolGate, ...document } = config ?? {};
  return parsePolicyDocument(document);
}

function routeOf(agent: { session?: { requestHeader?: () => { config?: Route } }; options?: Route } | undefined): Route | undefined {
  const header = agent?.session?.requestHeader?.();
  const config = header?.config ?? agent?.options;
  if (!config?.provider || !config.model) return undefined;
  return { provider: config.provider, model: config.model };
}

export class ResidualEngine extends BasicCompactionEngine {
  /**
   * Own schema: inherited statics would otherwise validate Residual's
   * layered document against the parent's official fields.
   */
  static inject = BasicCompactionEngine.inject;

  static Config: unknown = z.object({
    default: layer,
    providers: z.dict(layer),
    models: z.array(modelLayer),
    auto: z.boolean(),
    toolGate: z.object({ enabled: z.boolean() }),
  });

  readonly ledger: SavingsLedger;
  readonly toolGateHost: ResidualToolGateHost;
  private readonly baseDocument: PolicyDocument;
  private readonly parentDefaults: Record<string, unknown>;
  private readonly toolGateEnabled: boolean;
  private liveDocument: PolicyDocument;
  private settingsWatcher: SettingsWatcher | undefined;

  constructor(ctx: BasicCompactionEngine["ctx"], config: ResidualEngineConfig = {}) {
    const baseDocument = documentOf(config);
    // Construction has no route window yet. Do not require absolute fields
    // to convert here — that would keep the plugin from activating.
    const baseline = resolvePolicy(baseDocument, { provider: "", model: "" });
    super(ctx, { ...toBootOfficialConfig(baseline), auto: config.auto ?? true });
    this.parentDefaults = { ...this.config };
    this.baseDocument = baseDocument;
    this.toolGateEnabled = config.toolGate?.enabled === true;
    this.toolGateHost = new ResidualToolGateHost();
    this.ledger = new SavingsLedger({
      file: residualLedgerPath(),
      summaryFile: residualSavingsPath(),
      host: "dsh",
    });

    this.settingsWatcher = new SettingsWatcher({
      base: this.baseDocument,
      file: residualSettingsPath(),
      onChange: (live) => {
        this.liveDocument = live.document;
      },
      onError: (error) => {
        this.ctx.logger?.warn?.(
          `[residual] residual-settings.yaml unreadable (${error.message}); keeping the last good policy`,
        );
      },
    });
    this.liveDocument = this.settingsWatcher.current().document;
    const stop = this.settingsWatcher.start();
    this.ctx.effect?.(() => stop);

    if (this.toolGateEnabled) this.attachToolGate();

    const threshold = baseline.thresholdTokens ?? baseline.thresholdRatio;
    this.ctx.logger?.info?.(
      `[residual] engine up: threshold=${String(threshold)} auto=${config.auto ?? true} toolGate=${this.toolGateEnabled}`,
    );
  }

  /**
   * Rebuild the official parent config for the current route. Absolute
   * budgets require a declared window; Residual will not guess one.
   */
  applyPolicy(target: Route, contextWindow?: number): void {
    const policy = resolvePolicy(this.liveDocument, target, contextWindow);
    for (const warning of policy.warnings) this.ctx.logger?.warn?.(`[residual] ${warning.message}`);
    requireResolvedPolicy(policy);
    const official = toOfficialBasicConfig(policy);
    const next: Record<string, unknown> = {
      ...this.parentDefaults,
      ...official,
    };
    if (official.retainTokens !== undefined) delete next.retainRatio;
    else delete next.retainTokens;
    this.config = next;
  }

  override async compactIfNeeded(
    agent: unknown,
    trigger: string,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<BasicCompactionEngine["compactIfNeeded"]>>> {
    const typed = agent as { session?: { id?: string } };
    const target = routeOf(agent as Parameters<typeof routeOf>[0]);
    const window = target === undefined ? undefined : await this.contextWindowOf(target, signal);
    if (target !== undefined) {
      try {
        this.applyPolicy(target, window);
      } catch (error: unknown) {
        if (error instanceof MissingContextWindowError) throw error;
        throw error;
      }
    }

    const before = this.measure(typed);
    let result: Awaited<ReturnType<BasicCompactionEngine["compactIfNeeded"]>> = null;
    let thrown: unknown;
    try {
      result = await super.compactIfNeeded(agent, trigger, signal);
    } catch (error: unknown) {
      thrown = error;
    }
    const measuredAfter = this.measure(typed);
    // Official compaction may shrink the surface and still throw (for example,
    // "still above threshold after N attempts"). Record any real shrink so the
    // savings ledger is not lost on that path.
    const tokensAfter =
      measuredAfter ??
      (result !== null && before !== undefined
        ? Math.max(0, before - (result.shadowedTokenCount ?? 0))
        : undefined);
    if (before !== undefined && tokensAfter !== undefined && tokensAfter < before) {
      const row = this.ledger.record({
        tokensBefore: before,
        tokensAfter,
        sessionId: typed.session?.id,
        provider: target?.provider,
        model: target?.model,
      });
      const saved = this.ledger.tokensSaved(
        typed.session?.id === undefined ? {} : { sessionId: typed.session.id },
      );
      const line = this.ledger.formatRecordLine(row, saved);
      this.ctx.logger?.info?.(line);
      process.stderr.write(`${line}\n`);
    }
    if (thrown !== undefined) throw thrown;
    return result;
  }

  private async contextWindowOf(target: Route, signal: AbortSignal): Promise<number | undefined> {
    const info = await this.ctx.llm?.resolveModelInfo?.(target.provider, target.model, signal);
    const window = info?.context?.contextWindow;
    return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
  }

  private measure(agent: { session?: unknown }): number | undefined {
    try {
      const total = this.ctx.tokenMeter?.measure?.(agent.session)?.totalTokens;
      return typeof total === "number" && Number.isFinite(total) ? total : undefined;
    } catch {
      return undefined;
    }
  }

  private attachToolGate(): void {
    const tools = this.ctx.tools as ToolsHost | undefined;
    if (!tools || typeof tools.schemas !== "function") {
      this.ctx.logger?.warn?.(
        "[residual] toolGate is enabled but ctx.tools.schemas is unavailable; catalog not attached",
      );
      return;
    }
    this.toolGateHost.snapshotCatalog(tools);
    this.ctx.on?.("agent/pre-step", (event: { agent?: { session?: object; ctx?: { tools?: ToolsHost } } }, next: () => unknown) => {
      const session = event.agent?.session;
      const agentTools = event.agent?.ctx?.tools;
      if (session && agentTools) {
        try {
          this.toolGateHost.hideUnloadedMcpTools(session, agentTools);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.ctx.logger?.warn?.(`[residual] tool gate hide skipped: ${message}`);
        }
      }
      return next();
    });
  }
}

export default ResidualEngine;
