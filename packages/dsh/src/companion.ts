/**
 * Host-plane settings companion for Residual.
 *
 * Always-enabled. Publishes no `ctx.compaction` service — the engine entry
 * (`@residualhq/dsh/engine`) is the only row that may claim that seam.
 * The browser/host scan discovers enabled loader entries; the engine row
 * ships disabled and is normally mounted inside an agent preset, so this
 * companion exists as a visible, inert host-plane row.
 *
 * Entry id: residual-settings.
 */

import z from "@deepseek-ai/schemastery";
import { parsePolicyDocument, type PolicyDocument } from "@residualhq/core";

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

export type ResidualSettingsConfig = PolicyDocument & {
  toolGate?: { enabled?: boolean };
};

export class ResidualSettings {
  /** Own schema so the loader does not inherit any engine Config. */
  static Config: unknown = z.object({
    default: layer,
    providers: z.dict(layer),
    models: z.array(modelLayer),
    toolGate: z.object({ enabled: z.boolean() }),
  });

  readonly document: PolicyDocument;

  constructor(
    ctx: { logger?: { info?(message: string): void } },
    config: ResidualSettingsConfig = {},
  ) {
    const { toolGate: _toolGate, ...document } = config;
    this.document = parsePolicyDocument(document);
    ctx.logger?.info?.("[residual] settings companion mounted (does not claim ctx.compaction)");
  }
}

export default ResidualSettings;
