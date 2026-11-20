/**
 * Default package entry for @residualhq/dsh.
 *
 * The DSH loader mounts `exports.default` and has no entry option, so the
 * bare package name must resolve to the settings companion — never the
 * engine. The engine lives at `@residualhq/dsh/engine`.
 */

export { ResidualSettings, ResidualSettings as default } from "./companion.ts";
export type { ResidualSettingsConfig } from "./companion.ts";
export { ResidualToolGateHost } from "./tool-gate-host.ts";
