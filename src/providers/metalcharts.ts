import { fetchJson } from '../http'
import { METALS, SYMBOLS, type Env, type RawSpot, type SpotProvider } from '../types'

const num = (v: unknown, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * MetalCharts: paket gratis 200 request/bulan, boleh komersial dengan tautan kredit.
 * Satu panggilan /v1/prices mengembalikan semua logam (1 request).
 * Default TTL 6 jam => 4 refresh/hari => ~120 request/bulan, di bawah kuota.
 */
export const metalcharts: SpotProvider = {
  info: {
    id: 'metalcharts',
    name: 'MetalCharts',
    layer: 'spot',
    url: 'https://metalcharts.org',
    license:
      'Free tier: commercial use allowed with a visible credit link. Reselling API access or republishing raw data as a competing feed is not allowed; redistribution rights only by agreement.',
    attribution: { text: 'Metal prices by MetalCharts', url: 'https://metalcharts.org' },
  },
  callsPerRefresh: 1,
  ttl: (env) => num(env.METALCHARTS_TTL, 21600),
  maxStale: (env) => num(env.METALCHARTS_MAX_STALE, 172800),
  monthlyBudget: (env) => num(env.METALCHARTS_MONTHLY_BUDGET, 180),
  configError: (env) => (env.METALCHARTS_API_KEY ? null : 'METALCHARTS_API_KEY belum diisi'),

  async fetch(env: Env): Promise<RawSpot[]> {
    const base = (env.METALCHARTS_BASE_URL as string) || 'https://api.metalcharts.org'
    const symbols = METALS.map((m) => SYMBOLS[m]).join(',')
    const json = await fetchJson(`${base}/v1/prices?symbols=${symbols}&currency=USD&unit=toz`, {
      headers: { authorization: `Bearer ${env.METALCHARTS_API_KEY}` },
    })

    const out: RawSpot[] = []
    for (const metal of METALS) {
      const row = json?.data?.[SYMBOLS[metal]]
      if (!row || row.stale === true) continue
      const unit = String(row.unit ?? 'toz').toLowerCase()
      const currency = String(row.currency ?? json.currency ?? 'USD').toUpperCase()
      if (!['toz', 'oz', 'troy_ounce'].includes(unit) || currency !== 'USD') {
        throw new Error(`unexpected unit/currency for ${metal}: ${unit}/${currency}`)
      }
      const price = Number(row.price)
      const asOf = new Date(row.timestamp ?? json.timestamp)
      if (!Number.isFinite(price) || Number.isNaN(asOf.getTime())) continue
      out.push({ metal, usdPerOz: price, asOf: asOf.toISOString() })
    }
    return out
  },
}
