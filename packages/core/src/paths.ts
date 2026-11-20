import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the Residual/DSH home directory. Prompts never leave this machine. */
export function residualHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RESIDUAL_HOME && env.RESIDUAL_HOME.length > 0) return env.RESIDUAL_HOME;
  if (env.DSH_HOME && env.DSH_HOME.length > 0) return env.DSH_HOME;
  return join(env.HOME && env.HOME.length > 0 ? env.HOME : homedir(), ".dsh");
}

/** Local YAML document used for policy hot-reload (`residual:` section). */
export function residualSettingsPath(home = residualHome()): string {
  return join(home, "residual-settings.yaml");
}

/** Append-only JSONL savings ledger. Token counts and catalog dollar estimates, never prompts. */
export function residualLedgerPath(home = residualHome()): string {
  return join(home, "residual-ledger.jsonl");
}

/** Human-readable savings snapshot rewritten next to the JSONL after each record. */
export function residualSavingsPath(home = residualHome()): string {
  return join(home, "residual-savings.json");
}
