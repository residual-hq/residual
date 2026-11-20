declare module "@deepseek-ai/dsh-compaction-basic" {
  export class BasicCompactionEngine {
    static inject: string[];
    static Config: unknown;
    config: Record<string, unknown>;
    ctx: {
      logger?: { info?(message: string): void; warn?(message: string): void };
      llm?: {
        resolveModelInfo?(
          provider: string,
          model: string,
          signal?: AbortSignal,
        ): Promise<{ context?: { contextWindow?: number } }>;
      };
      tokenMeter?: { measure?(session: unknown, header?: unknown): { totalTokens?: number } };
      tools?: unknown;
      on?(event: string, listener: (...args: never[]) => unknown, options?: unknown): unknown;
      effect?(dispose: () => void): unknown;
    };
    constructor(ctx: BasicCompactionEngine["ctx"], config?: Record<string, unknown>);
    compactIfNeeded(agent: unknown, trigger: string, signal: AbortSignal): Promise<{
      shadowedTokenCount?: number;
      shadowedSeqs?: unknown[];
      shadowedRange?: { start: unknown; end: unknown };
    } | null>;
  }
  export default BasicCompactionEngine;
}

declare module "@deepseek-ai/schemastery" {
  type Schema = {
    volatile?: () => Schema;
  };
  interface Zodish {
    object(shape: Record<string, unknown>): Schema;
    number(): Schema;
    string(): Schema;
    boolean(): Schema;
    dict(schema: unknown): Schema;
    array(schema: unknown): Schema;
  }
  const z: Zodish;
  export default z;
}
