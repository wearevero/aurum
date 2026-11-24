export const METALS = ['gold', 'silver', 'platinum', 'palladium'] as const
export type Metal = (typeof METALS)[number]
export const SYMBOLS: Record<Metal, string> = {
  gold: 'XAU',
  silver: 'XAG',
  platinum: 'XPT',
  palladium: 'XPD',
}

export interface KVLike {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}
/** Env gabungan: variabel Workers/process.env + binding KV opsional bernama CACHE. */
export type Env = { CACHE?: KVLike } & { [key: string]: string | KVLike | undefined }

export interface Attribution {
  text: string
  url: string
}

export interface SourceInfo {
  id: string
  name: string
  layer: 'spot' | 'local'
  url: string
  /** Ringkasan syarat lisensi/redistribusi, tampil di /v1/sources. */
  license: string
  attribution?: Attribution
}

/** Kuotasi spot mentah dari provider: selalu USD per troy ounce. */
export interface RawSpot {
  metal: Metal
  usdPerOz: number
  asOf: string
  note?: string
}
export interface SpotSnapshot {
  quotes: RawSpot[]
  warnings: string[]
}

export interface SpotProvider {
  info: SourceInfo
  /** Jumlah request upstream per refresh (untuk hitung kuota). */
  callsPerRefresh: number
  ttl(env: Env): number
  maxStale(env: Env): number
  monthlyBudget(env: Env): number | undefined
  /** null = siap dipakai; selain itu alasan tidak bisa aktif. */
  configError(env: Env): string | null
  fetch(env: Env): Promise<RawSpot[]>
}

/** Harga ritel lokal: IDR per gram. */
export interface RawLocal {
  metal: Metal
  label?: string
  purity: number
  buy?: number
  sell?: number
}
export interface LocalSnapshot {
  asOf: string
  items: RawLocal[]
}
export interface LocalFeedConfig {
  id: string
  name: string
  url: string
  license: string
  attribution?: Attribution
}

export interface Quote {
  metal: Metal
  symbol: string
  price: number
  unit: 'g' | 'kg' | 'toz'
  currency: string
  karat?: number
  source: { id: string; name: string; layer: 'spot' }
  asOf: string
  fetchedAt: string
  ageSeconds: number
  /** true bila data berasal dari cache lama karena refresh gagal. */
  stale: boolean
  note?: string
  fx?: { pair: string; rate: number; date: string; source: string }
}

export interface LocalQuote {
  metal: Metal
  symbol: string
  label?: string
  purity: number
  buyPerGram?: number
  sellPerGram?: number
  currency: 'IDR'
  unit: 'g'
  source: { id: string; name: string; layer: 'local' }
  asOf: string
  fetchedAt: string
  ageSeconds: number
  stale: boolean
}
