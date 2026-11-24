import { fetchJson } from '../http'
import { METALS, type Env, type RawSpot, type SpotProvider } from '../types'

const num = (v: unknown, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const plan = (env: Env) => String(env.APININJAS_PLAN ?? 'free').toLowerCase()

/**
 * API Ninjas Metals Price. Paket gratis hanya memberi harga penutupan harian dan TIDAK boleh
 * komersial, jadi provider ini baru aktif jika APININJAS_PLAN bukan "free".
 * Satu request per logam => 4 request per refresh.
 */
export const apininjas: SpotProvider = {
  info: {
    id: 'apininjas',
    name: 'API Ninjas',
    layer: 'spot',
    url: 'https://api-ninjas.com/api/metalsprice',
    license:
      'Free tier is non-commercial and returns the last daily close. Commercial use requires a paid plan (live prices on Developer and above). Check their ToS before redistributing.',
    attribution: { text: 'Data: API Ninjas', url: 'https://api-ninjas.com' },
  },
  callsPerRefresh: METALS.length,
  ttl: (env) => num(env.APININJAS_TTL, plan(env) === 'free' ? 86400 : 900),
  maxStale: (env) => num(env.APININJAS_MAX_STALE, 172800),
  monthlyBudget: (env) => num(env.APININJAS_MONTHLY_BUDGET, 500),
  configError(env) {
    if (!env.APININJAS_API_KEY) return 'APININJAS_API_KEY belum diisi'
    if (plan(env) === 'free') return 'paket gratis API Ninjas non-komersial; set APININJAS_PLAN=developer|business setelah upgrade'
    return null
  },

  async fetch(env: Env): Promise<RawSpot[]> {
    const base = (env.APININJAS_BASE_URL as string) || 'https://api.api-ninjas.com'
    const results = await Promise.all(
      METALS.map(async (metal): Promise<RawSpot | null> => {
        const j = await fetchJson(`${base}/v1/metalsprice?metal=${metal}&unit=troy_ounce&currency=USD`, {
          headers: { 'x-api-key': String(env.APININJAS_API_KEY) },
        })
        if (j?.unit && j.unit !== 'troy_ounce') throw new Error(`unexpected unit for ${metal}: ${j.unit}`)
        if (j?.currency_unit && String(j.currency_unit).toUpperCase() !== 'USD') {
          throw new Error(`unexpected currency for ${metal}: ${j.currency_unit}`)
        }
        const price = Number(j?.price)
        const updated = Number(j?.updated)
        if (!Number.isFinite(price) || !Number.isFinite(updated)) return null
        return { metal, usdPerOz: price, asOf: new Date(updated * 1000).toISOString() }
      }),
    )
    return results.filter((r): r is RawSpot => r !== null)
  },
}
