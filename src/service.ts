import type { Cache } from "./cache";
import { HttpError } from "./http";
import { apininjas } from "./providers/apininjas";
import { fetchUsdRate, type FxRate } from "./providers/fx";
import { fetchFeed, localFeeds } from "./providers/local-feed";
import { metalcharts } from "./providers/metalcharts";
import { round, fromUsdPerOz, type Unit } from "./units";
import {
  SYMBOLS,
  type Attribution,
  type Env,
  type LocalFeedConfig,
  type LocalQuote,
  type LocalSnapshot,
  type Metal,
  type Quote,
  type RawSpot,
  type SpotProvider,
  type SpotSnapshot,
} from "./types";

export interface Ctx {
  env: Env;
  cache: Cache;
  now: () => number;
}

export const SPOT_PROVIDERS: SpotProvider[] = [metalcharts, apininjas];

/** Rentang wajar USD/troy oz: menangkap salah unit/mata uang dari upstream. */
const PLAUSIBLE: Record<Metal, [number, number]> = {
  gold: [500, 20000],
  silver: [5, 500],
  platinum: [200, 10000],
  palladium: [200, 10000],
};
const MAX_JUMP = 0.25; // lonjakan >25% terhadap data < 24 jam dianggap anomali

export const DISCLAIMER =
  "Data bersifat informatif, bukan acuan transaksi atau saran investasi. / Informational only; not a basis for transactions or investment advice.";

/* ------------------------------------------------------------------ */
/* Status sumber & lisensi                                             */
/* ------------------------------------------------------------------ */

const csv = (v: unknown) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export interface SourceStatus {
  id: string;
  name: string;
  layer: "spot" | "local";
  url: string;
  license: string;
  attribution?: Attribution;
  enabled: boolean;
  disabledReason?: string;
  quota?: { used: number; limit: number; month: string };
}

const month = (t: number) => new Date(t).toISOString().slice(0, 7);

function gate(
  env: Env,
  id: string,
  configError: string | null,
): string | undefined {
  if (!csv(env.LICENSE_REVIEWED).includes(id)) {
    return `syarat lisensi/redistribusi belum ditandai sudah dicek: LICENSE_REVIEWED terbaca "${env.LICENSE_REVIEWED ?? ""}", tambahkan "${id}"`;
  }
  return configError ?? undefined;
}

export function spotStatus(env: Env): SourceStatus[] {
  const order = csv(env.SPOT_PRIORITY);
  const list = [...SPOT_PROVIDERS].sort((a, b) => {
    const ia = order.indexOf(a.info.id);
    const ib = order.indexOf(b.info.id);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return list.map((p) => {
    const reason = gate(env, p.info.id, p.configError(env));
    return { ...p.info, enabled: !reason, disabledReason: reason };
  });
}

export function localStatus(env: Env): SourceStatus[] {
  return localFeeds(env).map((f) => {
    const reason = gate(env, f.id, null);
    return {
      id: f.id,
      name: f.name,
      layer: "local",
      url: f.url,
      license: f.license,
      attribution: f.attribution,
      enabled: !reason,
      disabledReason: reason,
    };
  });
}

export async function sourcesWithQuota(ctx: Ctx): Promise<SourceStatus[]> {
  const spots = spotStatus(ctx.env);
  for (const s of spots) {
    const p = SPOT_PROVIDERS.find((x) => x.info.id === s.id)!;
    const limit = p.monthlyBudget(ctx.env);
    if (limit) {
      const m = month(ctx.now());
      const used =
        (await ctx.cache.get<number>(`quota:spot:${s.id}:${m}`)) ?? 0;
      s.quota = { used, limit, month: m };
    }
  }
  return [...spots, ...localStatus(ctx.env)];
}

/* ------------------------------------------------------------------ */
/* Cache + kuota + stale-while-error                                   */
/* ------------------------------------------------------------------ */

interface Loaded<T> {
  data: T;
  fetchedAt: number;
  stale: boolean;
  error?: string;
}

const inflight = new Map<string, Promise<Loaded<any>>>();

async function load<T>(
  ctx: Ctx,
  key: string,
  o: {
    ttl: number;
    maxStale: number;
    budget?: { limit: number; cost: number };
    refresh: (prev: T | null, prevAgeSec: number) => Promise<T>;
  },
): Promise<Loaded<T>> {
  const entry = await ctx.cache.get<{ data: T; fetchedAt: number }>(key);
  const t = ctx.now();
  const age = entry ? (t - entry.fetchedAt) / 1000 : Infinity;
  if (entry && age < o.ttl)
    return { data: entry.data, fetchedAt: entry.fetchedAt, stale: false };

  const running = inflight.get(key);
  if (running) return running;

  const job = (async (): Promise<Loaded<T>> => {
    try {
      if (o.budget) {
        const qk = `quota:${key}:${month(t)}`;
        const used = (await ctx.cache.get<number>(qk)) ?? 0;
        if (used + o.budget.cost > o.budget.limit) {
          throw new Error(`kuota bulanan habis (${used}/${o.budget.limit})`);
        }
        await ctx.cache.put(qk, used + o.budget.cost, 35 * 86400); // dihitung sebelum request: konservatif
      }
      const data = await o.refresh(entry?.data ?? null, age);
      const fetchedAt = ctx.now();
      await ctx.cache.put(key, { data, fetchedAt }, o.ttl + o.maxStale);
      return { data, fetchedAt, stale: false };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (entry && age < o.maxStale)
        return {
          data: entry.data,
          fetchedAt: entry.fetchedAt,
          stale: true,
          error,
        };
      throw new Error(error);
    }
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* Lapis 1: spot internasional                                         */
/* ------------------------------------------------------------------ */

async function refreshSpot(
  p: SpotProvider,
  env: Env,
  prev: SpotSnapshot | null,
  prevAge: number,
): Promise<SpotSnapshot> {
  const raw = await p.fetch(env);
  const warnings: string[] = [];
  const quotes: RawSpot[] = [];
  for (const q of raw) {
    const [lo, hi] = PLAUSIBLE[q.metal];
    if (!(q.usdPerOz >= lo && q.usdPerOz <= hi)) {
      warnings.push(
        `${q.metal}: harga ${q.usdPerOz} di luar rentang wajar, ditolak`,
      );
      continue;
    }
    const old = prev?.quotes.find((x) => x.metal === q.metal);
    if (
      old &&
      prevAge < 86400 &&
      Math.abs(q.usdPerOz / old.usdPerOz - 1) > MAX_JUMP
    ) {
      warnings.push(
        `${q.metal}: lonjakan >${MAX_JUMP * 100}% ditolak, data sebelumnya dipertahankan`,
      );
      quotes.push(old); // timestamp asli tetap, jadi umur data jujur
      continue;
    }
    quotes.push(q);
  }
  if (!quotes.length)
    throw new Error(`tidak ada kuotasi valid. ${warnings.join("; ")}`);
  return { quotes, warnings };
}

function loadSpot(ctx: Ctx, p: SpotProvider) {
  const env = ctx.env;
  const limit = p.monthlyBudget(env);
  return load<SpotSnapshot>(ctx, `spot:${p.info.id}`, {
    ttl: p.ttl(env),
    maxStale: p.maxStale(env),
    budget: limit ? { limit, cost: p.callsPerRefresh } : undefined,
    refresh: (prev, age) => refreshSpot(p, env, prev, age),
  });
}

async function loadFx(ctx: Ctx, to: string): Promise<Loaded<FxRate>> {
  return load<FxRate>(ctx, `fx:USD:${to}`, {
    ttl: 3600,
    maxStale: 3 * 86400,
    refresh: () => fetchUsdRate(ctx.env, to),
  });
}

export interface SpotOptions {
  metals: Metal[];
  source: string; // auto | all | id[,id]
  unit: Unit;
  currency: string;
  karat?: number;
}
export interface SourceError {
  source: string;
  error: string;
}
export interface CrossCheck {
  metal: Metal;
  sources: string[];
  spreadPct: number;
  flagged: boolean;
}
export interface SpotResult {
  quotes: Quote[];
  errors: SourceError[];
  warnings: string[];
  crossCheck: CrossCheck[];
  attribution: Attribution[];
}

export async function getSpot(
  ctx: Ctx,
  opts: SpotOptions,
): Promise<SpotResult> {
  const status = spotStatus(ctx.env);
  const enabled = status.filter((s) => s.enabled);
  const errors: SourceError[] = [];

  let ids: string[];
  if (opts.source === "auto") ids = enabled.map((s) => s.id);
  else if (opts.source === "all") ids = enabled.map((s) => s.id);
  else {
    ids = opts.source.split(",").map((s) => s.trim().toLowerCase());
    for (const id of ids) {
      const s = status.find((x) => x.id === id);
      if (!s) throw new HttpError(400, `sumber spot tidak dikenal: ${id}`);
      if (!s.enabled)
        throw new HttpError(
          503,
          `sumber ${id} tidak aktif: ${s.disabledReason}`,
        );
    }
  }
  if (!ids.length) {
    throw new HttpError(
      503,
      "tidak ada sumber spot yang aktif",
      status.map((s) => ({ source: s.id, reason: s.disabledReason })),
    );
  }

  const snaps: { id: string; name: string; loaded: Loaded<SpotSnapshot> }[] =
    [];
  const load1 = async (id: string) => {
    const p = SPOT_PROVIDERS.find((x) => x.info.id === id)!;
    try {
      const loaded = await loadSpot(ctx, p);
      if (loaded.stale && loaded.error)
        errors.push({
          source: id,
          error: `refresh gagal, memakai cache lama: ${loaded.error}`,
        });
      snaps.push({ id, name: p.info.name, loaded });
    } catch (e) {
      errors.push({
        source: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (opts.source === "auto") {
    // Failover berurutan sampai semua logam yang diminta terpenuhi.
    const need = new Set(opts.metals);
    for (const id of ids) {
      await load1(id);
      const got = snaps.find((s) => s.id === id);
      got?.loaded.data.quotes.forEach((q) => need.delete(q.metal));
      if (!need.size) break;
    }
  } else {
    await Promise.all(ids.map(load1));
  }

  // Pilih kuotasi: auto = satu per logam dari sumber prioritas tertinggi; lainnya = semua sumber terpilih.
  type Pick = {
    id: string;
    name: string;
    q: RawSpot;
    fetchedAt: number;
    stale: boolean;
  };
  const picks: Pick[] = [];
  for (const metal of opts.metals) {
    for (const s of snaps) {
      const q = s.loaded.data.quotes.find((x) => x.metal === metal);
      if (!q) continue;
      picks.push({
        id: s.id,
        name: s.name,
        q,
        fetchedAt: s.loaded.fetchedAt,
        stale: s.loaded.stale,
      });
      if (opts.source === "auto") break;
    }
  }
  if (!picks.length)
    throw new HttpError(503, "tidak ada data spot yang tersedia", errors);

  let fx: FxRate | undefined;
  if (opts.currency !== "USD") {
    try {
      fx = (await loadFx(ctx, opts.currency)).data;
    } catch (e) {
      throw new HttpError(
        502,
        `kurs USD/${opts.currency} tidak tersedia: ${e instanceof Error ? e.message : e}`,
        errors,
      );
    }
  }

  const t = ctx.now();
  const quotes: Quote[] = picks.map(({ id, name, q, fetchedAt, stale }) => {
    let price = fromUsdPerOz(q.usdPerOz, opts.unit) * (fx?.rate ?? 1);
    const karat = opts.karat && q.metal === "gold" ? opts.karat : undefined;
    if (karat) price *= karat / 24;
    const note = [
      q.note,
      karat
        ? `emas ${karat}K dihitung nominal (${karat}/24 x harga 24K), belum termasuk ongkos/margin`
        : undefined,
    ]
      .filter(Boolean)
      .join("; ");
    return {
      metal: q.metal,
      symbol: SYMBOLS[q.metal],
      price: round(price, opts.currency),
      unit: opts.unit,
      currency: opts.currency,
      ...(karat ? { karat } : {}),
      source: { id, name, layer: "spot" as const },
      asOf: q.asOf,
      fetchedAt: new Date(fetchedAt).toISOString(),
      ageSeconds: Math.max(0, Math.round((t - Date.parse(q.asOf)) / 1000)),
      stale,
      ...(note ? { note } : {}),
      ...(fx
        ? {
            fx: {
              pair: `USD/${opts.currency}`,
              rate: fx.rate,
              date: fx.date,
              source: fx.source,
            },
          }
        : {}),
    };
  });

  // Pemeriksaan silang antar sumber (hanya bila lebih dari satu sumber punya logam yang sama).
  const crossCheck: CrossCheck[] = [];
  for (const metal of opts.metals) {
    const same = picks.filter((p) => p.q.metal === metal);
    if (same.length < 2) continue;
    const vals = same.map((p) => p.q.usdPerOz);
    const spread = (Math.max(...vals) / Math.min(...vals) - 1) * 100;
    crossCheck.push({
      metal,
      sources: same.map((p) => p.id),
      spreadPct: Math.round(spread * 1000) / 1000,
      flagged: spread > 2,
    });
  }

  const used = new Set(picks.map((p) => p.id));
  const attribution = status
    .filter((s) => used.has(s.id) && s.attribution)
    .map((s) => s.attribution!);
  const warnings = snaps.flatMap((s) =>
    s.loaded.data.warnings.map((w) => `${s.id}: ${w}`),
  );
  return { quotes, errors, warnings, crossCheck, attribution };
}

/* ------------------------------------------------------------------ */
/* Lapis 2: harga ritel lokal (feed JSON)                              */
/* ------------------------------------------------------------------ */

export interface LocalResult {
  quotes: LocalQuote[];
  errors: SourceError[];
  attribution: Attribution[];
}

export async function getLocal(
  ctx: Ctx,
  opts: { metals: Metal[]; source: string },
): Promise<LocalResult> {
  const feeds = localFeeds(ctx.env);
  const status = localStatus(ctx.env);
  let chosen: LocalFeedConfig[];
  if (opts.source === "auto" || opts.source === "all") {
    chosen = feeds.filter((f) => status.find((s) => s.id === f.id)?.enabled);
  } else {
    chosen = [];
    for (const id of opts.source.split(",").map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase(),
    )) {
      const f = feeds.find((x) => x.id.toLowerCase() === id);
      if (!f) throw new HttpError(400, `sumber lokal tidak dikenal: ${id}`);
      const s = status.find((x) => x.id === f.id)!;
      if (!s.enabled)
        throw new HttpError(
          503,
          `sumber ${id} tidak aktif: ${s.disabledReason}`,
        );
      chosen.push(f);
    }
  }

  const errors: SourceError[] = [];
  const quotes: LocalQuote[] = [];
  const attribution: Attribution[] = [];
  const ttl = Number(ctx.env.LOCAL_TTL) > 0 ? Number(ctx.env.LOCAL_TTL) : 3600;
  const t = ctx.now();

  await Promise.all(
    chosen.map(async (f) => {
      try {
        const l = await load<LocalSnapshot>(ctx, `local:${f.id}`, {
          ttl,
          maxStale: 2 * 86400,
          refresh: () => fetchFeed(f),
        });
        if (l.stale && l.error)
          errors.push({
            source: f.id,
            error: `refresh gagal, memakai cache lama: ${l.error}`,
          });
        if (f.attribution) attribution.push(f.attribution);
        for (const it of l.data.items) {
          if (!opts.metals.includes(it.metal)) continue;
          quotes.push({
            metal: it.metal,
            symbol: SYMBOLS[it.metal],
            ...(it.label ? { label: it.label } : {}),
            purity: it.purity,
            ...(it.buy ? { buyPerGram: it.buy } : {}),
            ...(it.sell ? { sellPerGram: it.sell } : {}),
            currency: "IDR",
            unit: "g",
            source: { id: f.id, name: f.name, layer: "local" },
            asOf: l.data.asOf,
            fetchedAt: new Date(l.fetchedAt).toISOString(),
            ageSeconds: Math.max(
              0,
              Math.round((t - Date.parse(l.data.asOf)) / 1000),
            ),
            stale: l.stale,
          });
        }
      } catch (e) {
        errors.push({
          source: f.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );
  return { quotes, errors, attribution };
}

/* ------------------------------------------------------------------ */
/* Perbandingan: premi harga ritel lokal terhadap spot                 */
/* ------------------------------------------------------------------ */

export interface Comparison {
  metal: Metal;
  label?: string;
  localSource: string;
  spotSource: string;
  /** Harga spot IDR/gram x kadar, sebagai acuan murni logam. */
  spotReferencePerGram: number;
  sellPerGram?: number;
  buyPerGram?: number;
  sellPremiumPct?: number;
  buyVsSpotPct?: number;
}

export function compare(spot: Quote[], local: LocalQuote[]): Comparison[] {
  const out: Comparison[] = [];
  for (const l of local) {
    const s = spot.find(
      (x) =>
        x.metal === l.metal &&
        x.currency === "IDR" &&
        x.unit === "g" &&
        !x.karat,
    );
    if (!s) continue;
    const ref = s.price * l.purity;
    out.push({
      metal: l.metal,
      ...(l.label ? { label: l.label } : {}),
      localSource: l.source.id,
      spotSource: s.source.id,
      spotReferencePerGram: Math.round(ref),
      ...(l.sellPerGram
        ? {
            sellPerGram: l.sellPerGram,
            sellPremiumPct: Math.round((l.sellPerGram / ref - 1) * 10000) / 100,
          }
        : {}),
      ...(l.buyPerGram
        ? {
            buyPerGram: l.buyPerGram,
            buyVsSpotPct: Math.round((l.buyPerGram / ref - 1) * 10000) / 100,
          }
        : {}),
    });
  }
  return out;
}
