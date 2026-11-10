export type BadgeState = "verified" | "mismatch" | "unknown";

const COLORS: Record<BadgeState, string> = {
  verified: "#2e8b57",
  mismatch: "#c0392b",
  unknown: "#7f8c8d",
};

/**
 * A verified result is labelled "(self-reported)" until the server has re-run the build itself,
 * so the badge never claims more trust than the registry has.
 */
export function badgeSvg(state: BadgeState, selfReported: boolean): string {
  const text = state === "verified" && selfReported ? "verified (self-reported)" : state;
  const left = 70;
  const right = 20 + text.length * 6;
  const w = left + right;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="soroban: ${text}">
<rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${COLORS[state]}"/>
<g fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle">
<text x="${left / 2}" y="14">soroban</text><text x="${left + right / 2}" y="14">${text}</text></g></svg>`;
}
