import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createCache } from './cache'
import { HttpError } from './http'
import { compare, DISCLAIMER, getLocal, getSpot, sourcesWithQuota, type Ctx } from './service'
import { METALS, type Attribution, type Env, type Metal } from './types'
import type { Unit } from './units'

const ALIASES: Record<string, Metal> = {
  gold: 'gold', xau: 'gold', emas: 'gold',
  silver: 'silver', xag: 'silver', perak: 'silver',
  platinum: 'platinum', xpt: 'platinum', platina: 'platinum',
  palladium: 'palladium', xpd: 'palladium', paladium: 'palladium',
}

function parseMetals(q: string | undefined): Metal[] {
  if (!q) return [...METALS]
  const out = new Set<Metal>()
  for (const raw of q.split(',')) {
    const m = ALIASES[raw.trim().toLowerCase()]
    if (!m) throw new HttpError(400, `logam tidak dikenal: "${raw}". Gunakan: ${METALS.join(', ')} (atau emas, perak, platina, paladium)`)
    out.add(m)
  }
  return [...out]
}

function parseUnit(q: string | undefined): Unit {
  const u = (q ?? 'g').toLowerCase()
  if (u === 'g' || u === 'kg' || u === 'toz') return u
  throw new HttpError(400, 'unit harus g, kg, atau toz')
}

function parseCurrency(q: string | undefined): string {
  const c = (q ?? 'IDR').toUpperCase()
  if (!/^[A-Z]{3}$/.test(c)) throw new HttpError(400, 'currency harus kode ISO 4217, mis. IDR atau USD')
  return c
}

function parseKarat(q: string | undefined, metals: Metal[]): number | undefined {
  if (!q) return undefined
  const k = Number(q)
  if (!Number.isInteger(k) || k < 1 || k > 24) throw new HttpError(400, 'karat harus bilangan bulat 1-24')
  if (metals.some((m) => m !== 'gold')) throw new HttpError(400, 'karat hanya berlaku untuk metal=gold')
  return k
}

const uniq = (list: Attribution[]) => [...new Map(list.map((a) => [a.url, a])).values()]

export const app = new Hono<{ Bindings: Env }>()

const makeCtx = (c: Context): Ctx => {
  const env = { ...(typeof process !== 'undefined' ? process.env : {}), ...((c.env as object) ?? {}) } as Env
  return { env, cache: createCache(env), now: () => Date.now() }
}

app.use('*', cors())
app.use('*', async (c, next) => {
  await next()
  if (c.req.method === 'GET' && c.res.status === 200) c.header('cache-control', 'public, max-age=60')
})

app.onError((e, c) => {
  if (e instanceof HttpError) return c.json({ error: e.message, details: e.details }, e.status)
  console.error(e)
  return c.json({ error: 'internal error' }, 500)
})

app.get('/', (c) =>
  c.json({
    name: 'metal-price-api',
    endpoints: {
      '/v1/prices': 'spot + lokal + perbandingan premi (IDR/gram)',
      '/v1/prices/spot': 'harga spot internasional. Query: metal, source, unit, currency, karat',
      '/v1/prices/local': 'harga ritel lokal dari feed. Query: metal, source',
      '/v1/sources': 'daftar sumber, status lisensi, dan pemakaian kuota',
      '/health': 'health check',
    },
    disclaimer: DISCLAIMER,
  }),
)

app.get('/health', (c) => c.json({ status: 'ok' }))

app.get('/v1/sources', async (c) => {
  const sources = await sourcesWithQuota(makeCtx(c))
  return c.json({ data: sources, meta: { disclaimer: DISCLAIMER } })
})

app.get('/v1/prices/spot', async (c) => {
  const metals = parseMetals(c.req.query('metal'))
  const r = await getSpot(makeCtx(c), {
    metals,
    source: (c.req.query('source') ?? 'auto').toLowerCase(),
    unit: parseUnit(c.req.query('unit')),
    currency: parseCurrency(c.req.query('currency')),
    karat: parseKarat(c.req.query('karat'), metals),
  })
  return c.json({
    data: r.quotes,
    meta: {
      generatedAt: new Date().toISOString(),
      attribution: uniq(r.attribution),
      crossCheck: r.crossCheck,
      warnings: r.warnings,
      errors: r.errors,
      disclaimer: DISCLAIMER,
    },
  })
})

app.get('/v1/prices/local', async (c) => {
  const r = await getLocal(makeCtx(c), {
    metals: parseMetals(c.req.query('metal')),
    source: (c.req.query('source') ?? 'auto').toLowerCase(),
  })
  return c.json({
    data: r.quotes,
    meta: { generatedAt: new Date().toISOString(), attribution: uniq(r.attribution), errors: r.errors, disclaimer: DISCLAIMER },
  })
})

app.get('/v1/prices', async (c) => {
  const ctx = makeCtx(c)
  const metals = parseMetals(c.req.query('metal'))
  const spot = await getSpot(ctx, {
    metals,
    source: (c.req.query('spot_source') ?? 'auto').toLowerCase(),
    unit: 'g',
    currency: 'IDR',
  })
  const local = await getLocal(ctx, { metals, source: (c.req.query('local_source') ?? 'auto').toLowerCase() })
  return c.json({
    spot: spot.quotes,
    local: local.quotes,
    comparison: compare(spot.quotes, local.quotes),
    meta: {
      generatedAt: new Date().toISOString(),
      attribution: uniq([...spot.attribution, ...local.attribution]),
      crossCheck: spot.crossCheck,
      warnings: spot.warnings,
      errors: [...spot.errors, ...local.errors],
      disclaimer: DISCLAIMER,
    },
  })
})

app.notFound((c) => c.json({ error: 'not found' }, 404))
