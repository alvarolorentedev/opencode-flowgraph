import type { UsageEstimate } from "../state/types.js"

export function zeroUsage(): UsageEstimate {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUSD: 0,
    estimated: true,
    enforced: false,
    source: "provider_reported",
  }
}

export function mergeUsage(base: UsageEstimate, extra: UsageEstimate): UsageEstimate {
  return {
    ...base,
    input: base.input + extra.input,
    output: base.output + extra.output,
    reasoning: base.reasoning + extra.reasoning,
    cacheRead: base.cacheRead + extra.cacheRead,
    cacheWrite: base.cacheWrite + extra.cacheWrite,
    costUSD: base.costUSD + extra.costUSD,
  }
}
