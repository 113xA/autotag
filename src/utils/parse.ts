/** Strict non-negative integer for track # / year (avoids parseInt partial matches). */
export function parseU32(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
