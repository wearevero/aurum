export const GRAMS_PER_TOZ = 31.1034768
export type Unit = 'g' | 'kg' | 'toz'

export function fromUsdPerOz(usdPerOz: number, unit: Unit): number {
  if (unit === 'toz') return usdPerOz
  const perGram = usdPerOz / GRAMS_PER_TOZ
  return unit === 'g' ? perGram : perGram * 1000
}

/** IDR tidak memakai desimal; mata uang lain 4 desimal. */
export function round(value: number, currency: string): number {
  const d = currency === 'IDR' ? 0 : 4
  const f = 10 ** d
  return Math.round(value * f) / f
}
