export function transitionKey(from: string, outcome: string | undefined, to: string): string {
  return `${from}\u0000${outcome ?? ""}\u0000${to}`
}
