import { fetchJson } from '../http'
import { METALS, type Env, type LocalFeedConfig, type LocalSnapshot, type Metal, type RawLocal } from '../types'

/** Baca daftar feed lokal dari env LOCAL_FEEDS (array JSON). Entri yang rusak dilewati. */
export function localFeeds(env: Env): LocalFeedConfig[] {
  const raw = env.LOCAL_FEEDS
  if (!raw || typeof raw !== 'string') return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (f): f is LocalFeedConfig =>
        f && typeof f.id === 'string' && typeof f.name === 'string' && /^https:\/\//.test(f.url) && typeof f.license === 'string',
    )
  } catch {
    return []
  }
}

const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

/**
 * Skema feed:
 * { "asOf": "2026-11-24T02:00:00Z", "currency": "IDR",
 *   "items": [{ "metal": "gold", "label": "Antam 1 gr", "purity": 0.999, "buy": 2150000, "sell": 2290000 }] }
 * Semua harga IDR per gram. Penarikan data (scraping, dsb.) dilakukan di luar API ini.
 */
export function parseFeed(json: any): LocalSnapshot {
  if (json?.currency && json.currency !== 'IDR') throw new Error('feed harus bermata uang IDR')
  const asOf = new Date(json?.asOf)
  if (Number.isNaN(asOf.getTime())) throw new Error('feed tanpa asOf yang valid')
  if (!Array.isArray(json?.items)) throw new Error('feed tanpa items')
  const items: RawLocal[] = []
  for (const it of json.items) {
    if (!METALS.includes(it?.metal)) continue
    const purity = typeof it.purity === 'number' ? it.purity : 1
    const buy = pos(it.buy)
    const sell = pos(it.sell)
    if (!(purity > 0 && purity <= 1) || (!buy && !sell)) continue
    items.push({ metal: it.metal as Metal, label: typeof it.label === 'string' ? it.label : undefined, purity, buy, sell })
  }
  if (!items.length) throw new Error('feed tidak punya item valid')
  return { asOf: asOf.toISOString(), items }
}

export async function fetchFeed(feed: LocalFeedConfig): Promise<LocalSnapshot> {
  return parseFeed(await fetchJson(feed.url))
}
