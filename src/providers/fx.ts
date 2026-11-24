import { fetchJson } from '../http'
import type { Env } from '../types'

export interface FxRate {
  rate: number
  date: string
  source: string
}

/** Kurs referensi ECB lewat Frankfurter (gratis, tanpa API key). Mengembalikan unit `to` per 1 USD. */
export async function fetchUsdRate(env: Env, to: string): Promise<FxRate> {
  const base = ((env.FRANKFURTER_URL as string) || 'https://api.frankfurter.dev/v1').replace(/\/$/, '')
  const j = await fetchJson(`${base}/latest?base=USD&symbols=${encodeURIComponent(to)}`)
  const rate = Number(j?.rates?.[to])
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`no ${to} rate from Frankfurter`)
  return { rate, date: String(j.date ?? ''), source: 'ECB reference rates via Frankfurter' }
}
