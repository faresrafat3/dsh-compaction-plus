/**
 * Pressure guard for CompactionPlusEngine.
 *
 * Upstream computes the compaction threshold as
 * `min(window * thresholdRatio, window - reservedMaxTokens - headroomTokens)`.
 * When a model entry declares an output cap close to its context window
 * (e.g. maxTokens 943718 of 1048576), that formula collapses the threshold to
 * ~39k tokens and compaction fires constantly on a mostly-empty context.
 *
 * This module hides the whole resolution/validation/measurement sequence behind
 * one small async predicate: `shouldSkipPressureCompaction`. Callers learn only
 * whether the pressure trigger may be skipped; every failure mode delegates to
 * the base engine so its own errors and validation still surface.
 */

export interface PressureGuardConfig {
  readonly thresholdRatio: number;
  readonly headroomTokens: number;
  readonly modelPolicies?: readonly {
    readonly provider: string;
    readonly model: string;
    readonly thresholdRatio?: number;
    readonly headroomTokens?: number;
  }[];
}

export interface PressureGuardContext {
  readonly llm: {
    resolveModelInfo(
      provider: string,
      model: string,
      signal: AbortSignal,
    ): Promise<{
      context?: { contextWindow?: unknown };
      defaultMaxTokens?: number;
    }>;
  };
  readonly tokenMeter: {
    measure(session: unknown): { totalTokens: number };
  };
}

export interface PressureGuardAgent {
  readonly id: unknown;
  readonly session: {
    requestHeader(): { config: { provider: string; model: string; maxTokens?: number } } | null | undefined;
  };
}

/**
 * Pure threshold math, exported for direct testing. Returns the number of
 * tokens at which pressure compaction should fire, or a non-positive value
 * when the inputs are unusable (callers then delegate to the base engine).
 */
export function computePressureThresholdTokens(
  contextWindow: number,
  thresholdRatio: number,
  headroomTokens: number,
  reserved: number,
): number {
  if (
    !Number.isInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isFinite(thresholdRatio) ||
    !Number.isInteger(headroomTokens) ||
    headroomTokens < 0
  ) {
    return 0;
  }
  // Cap the output reservation so the window-fraction threshold survives
  // whatever a model declares.
  const reservation = Math.min(
    reserved,
    Math.max(0, contextWindow - headroomTokens - Math.floor(contextWindow * thresholdRatio)),
  );
  return Math.floor(Math.min(contextWindow * thresholdRatio, contextWindow - reservation - headroomTokens));
}

/**
 * Returns "skip" when the current session is below the (clamped) pressure
 * threshold and compaction must not run. Returns "delegate" in every other
 * case, including all resolution/measurement failures, so the base engine's
 * own behaviour and errors are preserved.
 */
export async function evaluatePressureGuard(
  ctx: PressureGuardContext,
  agent: PressureGuardAgent,
  config: PressureGuardConfig,
  signal: AbortSignal,
): Promise<"skip" | "delegate"> {
  try {
    const header = agent.session.requestHeader();
    if (!header) return "delegate";
    const { provider, model } = header.config;
    const policyOverride = config.modelPolicies?.find(
      (entry) => entry.provider === provider && entry.model === model,
    );
    const thresholdRatio = policyOverride?.thresholdRatio ?? config.thresholdRatio;
    const headroomTokens = policyOverride?.headroomTokens ?? config.headroomTokens;

    const info = await ctx.llm.resolveModelInfo(provider, model, signal);
    if (info.context === undefined) return "delegate";
    const contextWindow = info.context.contextWindow;
    if (typeof contextWindow !== "number") return "delegate";
    const reserved = header.config.maxTokens ?? info.defaultMaxTokens ?? 0;

    const thresholdTokens = computePressureThresholdTokens(
      contextWindow,
      thresholdRatio,
      headroomTokens,
      reserved,
    );
    if (!(thresholdTokens > 0)) return "delegate";

    const measurement = ctx.tokenMeter.measure(agent.session);
    if (measurement.totalTokens < thresholdTokens) return "skip";
    return "delegate";
  } catch {
    return "delegate";
  }
}
