const PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 [redacted]"],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/gu, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/gu, "[redacted]"],
  [/\b(Api[-_]?Key|Token|Secret|Password)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]"],
  [/([?&](?:token|key|secret|password)=)[^&\s]+/giu, "$1[redacted]"],
  [/https?:\/\/[^\s/@]+:[^\s/@]+@/gu, "https://[redacted]@"],
]

export function redactText(value: string): string {
  let result = value
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement)
  return result.slice(0, 1_000)
}

export function errorMessage(error: unknown, fallback = "unknown error"): string {
  if (error instanceof Error) return redactText(error.message || fallback)
  if (typeof error === "string") return redactText(error)
  return fallback
}

export function errorType(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const record = error as Record<string, unknown>
  const tag = record._tag ?? record.type ?? record.name
  return typeof tag === "string" ? tag.slice(0, 120) : undefined
}
