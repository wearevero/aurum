import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'
import { resetMemoryCache } from '../src/cache'

type Handler = (url: URL) => Response | Promise<Response>
let calls: Record<string, number>
let handlers: Record<string, Handler>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const BASE_ENV = {
  LICENSE_REVIEWED: 'metalcharts,apininjas,toko',
  METALCHARTS_API_KEY: 'mc_live_test',
  SPOT_PRIORITY: 'metalcharts,apininjas',
}

const mcOk = (xau = 4100): Handler => () =>
  json({
    success: true,
    currency: 'USD',
    data: {
      XAU: { symbol: 'XAU', price: xau, unit: 'toz', currency: 'USD', timestamp: '2026-11-24T02:00:00Z' },
      XAG: { symbol: 'XAG', price: 60, unit: 'toz', currency: 'USD', timestamp: '2026-11-24T02:00:00Z' },
      XPT: { symbol: 'XPT', price: 1700, unit: 'toz', currency: 'USD', timestamp: '2026-11-24T02:00:00Z' },
      XPD: { symbol: 'XPD', price: 1200, unit: 'toz', currency: 'USD', timestamp: '2026-11-24T02:00:00Z' },
    },
  })

const fxOk: Handler = () => json({ base: 'USD', date: '2026-11-24', rates: { IDR: 16500 } })

const ninjaOk: Handler = (u) => {
  const metal = u.searchParams.get('metal')
  const price = { gold: 4110, silver: 60.5, platinum: 1710, palladium: 1190 }[metal as string]
  return json({ metal, price, unit: 'troy_ounce', currency_unit: 'USD', updated: 1795572000 })
}

async function get(path: string, env: Record<string, string> = BASE_ENV) {
  const res = await app.request(path, {}, env)
  return { status: res.status, body: (await res.json()) as any }
}

beforeEach(() => {
  resetMemoryCache()
  calls = {}
  handlers = { 'api.metalcharts.org': mcOk(), 'api.frankfurter.dev': fxOk }
  vi.stubGlobal('fetch', async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    calls[url.host] = (calls[url.host] ?? 0) + 1
    const h = handlers[url.host]
    if (!h) return json({ error: 'no handler' }, 500)
    return h(url)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('spot layer', () => {
  it('converts USD/oz to IDR/gram and labels source, timestamp and attribution', async () => {
    const { status, body } = await get('/v1/prices/spot?metal=gold')
    expect(status).toBe(200)
    const q = body.data[0]
    expect(q.price).toBe(Math.round((4100 / 31.1034768) * 16500))
    expect(q).toMatchObject({ unit: 'g', currency: 'IDR', symbol: 'XAU', stale: false })
    expect(q.source).toEqual({ id: 'metalcharts', name: 'MetalCharts', layer: 'spot' })
    expect(q.asOf).toBe('2026-11-24T02:00:00.000Z')
    expect(q.fx).toMatchObject({ pair: 'USD/IDR', rate: 16500 })
    expect(body.meta.attribution[0].text).toContain('MetalCharts')
  })

  it('accepts Indonesian metal names and karat', async () => {
    const { body } = await get('/v1/prices/spot?metal=emas&karat=18&currency=USD&unit=toz')
    expect(body.data[0].price).toBeCloseTo(4100 * 0.75, 3)
    expect(body.data[0].karat).toBe(18)
  })

  it('rejects karat for non-gold and bad input', async () => {
    expect((await get('/v1/prices/spot?metal=silver&karat=18')).status).toBe(400)
    expect((await get('/v1/prices/spot?metal=tembaga')).status).toBe(400)
    expect((await get('/v1/prices/spot?unit=lb')).status).toBe(400)
    expect((await get('/v1/prices/spot?source=nope')).status).toBe(400)
  })

  it('does not call upstream twice within the TTL (protects free quota)', async () => {
    await get('/v1/prices/spot')
    await get('/v1/prices/spot?metal=silver')
    await get('/v1/prices/spot?metal=gold&unit=kg')
    expect(calls['api.metalcharts.org']).toBe(1)
    expect(calls['api.frankfurter.dev']).toBe(1)
  })
})

describe('license gate', () => {
  it('keeps sources disabled until LICENSE_REVIEWED lists them', async () => {
    const env = { ...BASE_ENV, LICENSE_REVIEWED: '' }
    const r = await get('/v1/prices/spot', env)
    expect(r.status).toBe(503)
    expect(calls['api.metalcharts.org']).toBeUndefined()
    const s = await get('/v1/sources', env)
    const mc = s.body.data.find((x: any) => x.id === 'metalcharts')
    expect(mc.enabled).toBe(false)
    expect(mc.disabledReason).toContain('LICENSE_REVIEWED')
  })

  it('never enables API Ninjas on the free (non-commercial) plan', async () => {
    const env = { ...BASE_ENV, APININJAS_API_KEY: 'k', APININJAS_PLAN: 'free' }
    const s = await get('/v1/sources', env)
    const n = s.body.data.find((x: any) => x.id === 'apininjas')
    expect(n.enabled).toBe(false)
    expect(n.disabledReason).toContain('non-komersial')
  })
})

describe('multi-source', () => {
  const ENV = { ...BASE_ENV, APININJAS_API_KEY: 'k', APININJAS_PLAN: 'developer' }

  it('fails over to the next source when the first is down', async () => {
    handlers['api.metalcharts.org'] = () => json({ error: 'boom' }, 500)
    handlers['api.api-ninjas.com'] = ninjaOk
    const { status, body } = await get('/v1/prices/spot?metal=gold&currency=USD&unit=toz', ENV)
    expect(status).toBe(200)
    expect(body.data[0].source.id).toBe('apininjas')
    expect(body.data[0].price).toBe(4110)
    expect(body.meta.errors[0].source).toBe('metalcharts')
  })

  it('lets the caller pick a source and cross-checks when asking for all', async () => {
    handlers['api.api-ninjas.com'] = ninjaOk
    const one = await get('/v1/prices/spot?metal=gold&source=apininjas&currency=USD&unit=toz', ENV)
    expect(one.body.data).toHaveLength(1)
    expect(one.body.data[0].source.id).toBe('apininjas')

    const all = await get('/v1/prices/spot?metal=gold&source=all&currency=USD&unit=toz', ENV)
    expect(all.body.data.map((q: any) => q.source.id).sort()).toEqual(['apininjas', 'metalcharts'])
    expect(all.body.meta.crossCheck[0]).toMatchObject({ metal: 'gold', flagged: false })
  })

  it('flags large disagreement between sources', async () => {
    handlers['api.api-ninjas.com'] = (u) =>
      json({ metal: u.searchParams.get('metal'), price: 4400, unit: 'troy_ounce', currency_unit: 'USD', updated: 1795572000 })
    const { body } = await get('/v1/prices/spot?metal=gold&source=all&currency=USD&unit=toz', ENV)
    expect(body.meta.crossCheck[0].flagged).toBe(true)
  })
})

describe('resilience', () => {
  it('serves stale cache (flagged) when refresh fails, instead of failing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-24T03:00:00Z'))
    await get('/v1/prices/spot?metal=gold&currency=USD&unit=toz')

    vi.setSystemTime(new Date('2026-11-24T10:00:00Z')) // lewat TTL 6 jam
    handlers['api.metalcharts.org'] = () => json({ error: 'down' }, 503)
    const { status, body } = await get('/v1/prices/spot?metal=gold&currency=USD&unit=toz')
    expect(status).toBe(200)
    expect(body.data[0].stale).toBe(true)
    expect(body.meta.errors[0].error).toContain('cache lama')
  })

  it('stops calling upstream once the monthly budget is used up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'))
    const env = { ...BASE_ENV, METALCHARTS_MONTHLY_BUDGET: '2' }
    await get('/v1/prices/spot?currency=USD', env) // 1
    vi.setSystemTime(new Date('2026-11-24T07:00:00Z'))
    await get('/v1/prices/spot?currency=USD', env) // 2
    vi.setSystemTime(new Date('2026-11-24T14:00:00Z'))
    const r = await get('/v1/prices/spot?currency=USD', env) // budget habis -> stale
    expect(calls['api.metalcharts.org']).toBe(2)
    expect(r.body.data[0].stale).toBe(true)
    expect(r.body.meta.errors[0].error).toContain('kuota bulanan habis')
    const s = await get('/v1/sources', env)
    expect(s.body.data.find((x: any) => x.id === 'metalcharts').quota).toMatchObject({ used: 2, limit: 2 })
  })

  it('rejects implausible prices (e.g. wrong unit upstream)', async () => {
    handlers['api.metalcharts.org'] = mcOk(131) // emas ~131 USD/oz = kemungkinan per gram, bukan per oz
    const { status, body } = await get('/v1/prices/spot?metal=gold&currency=USD')
    expect(status).toBe(503)
    expect(JSON.stringify(body)).toContain('tidak ada')
  })

  it('refuses a >25% jump and keeps the previous quote with its original timestamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-24T03:00:00Z'))
    await get('/v1/prices/spot?metal=gold&currency=USD&unit=toz')
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'))
    handlers['api.metalcharts.org'] = mcOk(6000)
    const { body } = await get('/v1/prices/spot?metal=gold&currency=USD&unit=toz')
    expect(body.data[0].price).toBe(4100)
    expect(body.meta.warnings.join(' ')).toContain('lonjakan')
  })

  it('returns 502 when FX is unavailable and a non-USD currency is requested', async () => {
    handlers['api.frankfurter.dev'] = () => json({}, 500)
    expect((await get('/v1/prices/spot?metal=gold')).status).toBe(502)
    expect((await get('/v1/prices/spot?metal=gold&currency=USD')).status).toBe(200)
  })
})

describe('local layer + comparison', () => {
  const feed = {
    asOf: '2026-11-24T01:30:00Z',
    currency: 'IDR',
    items: [
      { metal: 'gold', label: 'Emas 24K batangan', purity: 0.999, buy: 2200000, sell: 2350000 },
      { metal: 'gold', label: 'rusak', purity: 5, buy: 1 },
    ],
  }
  const ENV = {
    ...BASE_ENV,
    LOCAL_FEEDS: JSON.stringify([
      { id: 'toko', name: 'Harga Toko Kami', url: 'https://feeds.example.com/p.json', license: 'milik sendiri' },
    ]),
  }

  it('serves validated feed items and computes premium over spot', async () => {
    handlers['feeds.example.com'] = () => json(feed)
    const { body } = await get('/v1/prices?metal=gold', ENV)
    expect(body.local).toHaveLength(1) // item dengan kadar tidak valid dibuang
    const ref = Math.round((4100 / 31.1034768) * 16500 * 0.999)
    expect(body.comparison[0].spotReferencePerGram).toBe(ref)
    expect(body.comparison[0].sellPremiumPct).toBeCloseTo((2350000 / ref - 1) * 100, 1)
    expect(body.comparison[0].spotSource).toBe('metalcharts')
  })

  it('reports a broken feed as an error without breaking the response', async () => {
    handlers['feeds.example.com'] = () => json({ items: [] })
    const { status, body } = await get('/v1/prices?metal=gold', ENV)
    expect(status).toBe(200)
    expect(body.local).toEqual([])
    expect(body.meta.errors[0].source).toBe('toko')
  })
})
