/**
 * Aggregate real agent spend from agent_call observations.
 *
 * The agent_call span is the only observation that carries a run's actual cost and token spend
 * (written by the pipeline's agentStep). Both the cost metrics page and the system status total
 * derive their numbers from here, so the two views never disagree.
 */
import type { Observation } from "../../schemas/observer.js";

/** A single phase's accumulated spend, agent-call duration, and call count — all from that phase's agent_call spans. */
export interface PhaseSpend {
  readonly phase: string;
  readonly spend_usd: number;
  readonly duration_ms: number;
  readonly agent_calls: number;
}

/** A single day's accumulated spend. */
export interface DaySpend {
  readonly day: string;
  readonly spend_usd: number;
}

/** Token totals across every agent run. */
export interface TokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly total: number;
}

/** Cost numbers the metrics page renders, all sourced from agent_call spans. */
export interface AgentCostAggregate {
  readonly todaySpend: number;
  readonly monthSpend: number;
  readonly totalSpend: number;
  readonly perDay: DaySpend[];
  readonly perPhase: PhaseSpend[];
  readonly tokenTotals: TokenTotals;
}

/** Read one agent_call observation's spend off its span output (with input as the observe()-path fallback). */
function readSpend(obs: Observation): { cost: number; tokensIn: number; tokensOut: number; cacheRead: number } {
  // observe() stores data in `input`; span.end() stores in `output`. The agent_call span ends with output.
  const out = (obs.output ?? obs.input) as Record<string, unknown> | null;
  if (!out) {
    return { cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0 };
  }
  const cost = typeof out["cost_usd"] === "number" ? out["cost_usd"] : 0;
  const tokensIn =
    typeof out["tokens_in"] === "number"
      ? out["tokens_in"]
      : typeof out["input_tokens"] === "number"
        ? out["input_tokens"]
        : 0;
  const tokensOut =
    typeof out["tokens_out"] === "number"
      ? out["tokens_out"]
      : typeof out["output_tokens"] === "number"
        ? out["output_tokens"]
        : 0;
  const cacheRead = typeof out["cache_read_tokens"] === "number" ? out["cache_read_tokens"] : 0;
  return { cost, tokensIn, tokensOut, cacheRead };
}

/** Sum total spend across every agent_call observation — the one number system status reports. */
export function totalAgentSpend(observations: readonly Observation[]): number {
  let total = 0;
  for (const obs of observations) {
    total += readSpend(obs).cost;
  }
  return total;
}

/** Aggregate per-day, per-phase, and token totals from agent_call observations. */
export function aggregateAgentCost(observations: readonly Observation[]): AgentCostAggregate {
  const dayMap = new Map<string, { spend_usd: number }>();
  const phaseMap = new Map<string, { spend_usd: number; duration_ms: number; agent_calls: number }>();
  let todaySpend = 0;
  let monthSpend = 0;
  let totalSpend = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;

  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  for (const obs of observations) {
    const { cost, tokensIn, tokensOut, cacheRead } = readSpend(obs);
    totalInputTokens += tokensIn;
    totalOutputTokens += tokensOut;
    totalCacheReadTokens += cacheRead;

    // A run can report zero cost (e.g. a CLI that omits pricing); it still counts as an agent call for the phase.
    const phaseName = obs.phase ?? "unknown";
    const phaseEntry = phaseMap.get(phaseName) ?? { spend_usd: 0, duration_ms: 0, agent_calls: 0 };
    phaseEntry.spend_usd += cost;
    phaseEntry.duration_ms += obs.duration_ms ?? 0;
    phaseEntry.agent_calls += 1;
    phaseMap.set(phaseName, phaseEntry);

    if (cost === 0) {
      continue;
    }
    totalSpend += cost;

    const day = obs.start_time.slice(0, 10);
    const dayEntry = dayMap.get(day) ?? { spend_usd: 0 };
    dayEntry.spend_usd += cost;
    dayMap.set(day, dayEntry);

    if (day === today) {
      todaySpend += cost;
    }
    if (obs.start_time.slice(0, 7) === month) {
      monthSpend += cost;
    }
  }

  const perDay = [...dayMap.entries()]
    .map(([day, v]) => ({ day, spend_usd: v.spend_usd }))
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, 30);

  const perPhase = [...phaseMap.entries()]
    .map(([phase, v]) => ({ phase, ...v }))
    .sort((a, b) => b.spend_usd - a.spend_usd);

  return {
    todaySpend,
    monthSpend,
    totalSpend,
    perDay,
    perPhase,
    tokenTotals: {
      input: totalInputTokens,
      output: totalOutputTokens,
      cache_read: totalCacheReadTokens,
      total: totalInputTokens + totalOutputTokens,
    },
  };
}
