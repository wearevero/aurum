# Aurum

A small API for precious metal prices: gold, silver, platinum and palladium.

It pulls spot prices from third-party providers, converts them to whatever unit and currency you ask for, and optionally lines them up against local retail prices so you can see the premium. Every number comes back with its source and a timestamp.

Built with [Hono](https://hono.dev). Runs on Node, Bun and Cloudflare Workers.

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000/v1/sources`. On startup the server prints which `.env` it loaded. If a source shows `enabled: false`, the reason is right there in the response.

You need an API key from [MetalCharts](https://metalcharts.org/api-console?new=1) (free, no card), and you need to add `metalcharts` to `LICENSE_REVIEWED`. See [Licensing](#licensing) for why.

Requires Node 20.12 or newer.

## Endpoints

| Endpoint               | What it returns                                                     |
| ---------------------- | ------------------------------------------------------------------- |
| `GET /v1/prices/spot`  | Spot prices. Params: `metal`, `source`, `unit`, `currency`, `karat` |
| `GET /v1/prices/local` | Retail prices from your local feeds. Params: `metal`, `source`      |
| `GET /v1/prices`       | Spot and local together, plus a `comparison` block (IDR per gram)   |
| `GET /v1/sources`      | Every source, whether it's enabled, and how much quota it has used  |

```bash
# Gold in IDR per gram. Falls back to the next source if the first is down.
curl 'localhost:3000/v1/prices/spot?metal=gold'

# One specific source
curl 'localhost:3000/v1/prices/spot?metal=gold&source=metalcharts'

# All enabled sources side by side. meta.crossCheck flags disagreements above 2%.
curl 'localhost:3000/v1/prices/spot?metal=gold&source=all&currency=USD&unit=toz'

# 18K gold, priced as 18/24 of the 24K spot price
curl 'localhost:3000/v1/prices/spot?metal=gold&karat=18'
```

`metal` takes `gold`, `silver`, `platinum`, `palladium`, the codes `xau`, `xag`, `xpt`, `xpd`, or the Indonesian names `emas`, `perak`, `platina`, `paladium`. Comma-separate for several. Defaults are `unit=g` and `currency=IDR`.

A response looks like this:

```json
{
  "data": [
    {
      "metal": "gold",
      "symbol": "XAU",
      "price": 2175412,
      "unit": "g",
      "currency": "IDR",
      "source": { "id": "metalcharts", "name": "MetalCharts", "layer": "spot" },
      "asOf": "2026-11-24T02:00:00.000Z",
      "fetchedAt": "2026-11-24T02:03:11.000Z",
      "ageSeconds": 191,
      "stale": false,
      "fx": {
        "pair": "USD/IDR",
        "rate": 16500,
        "date": "2026-11-24",
        "source": "ECB reference rates via Frankfurter"
      }
    }
  ],
  "meta": {
    "attribution": [
      {
        "text": "Metal prices by MetalCharts",
        "url": "https://metalcharts.org"
      }
    ],
    "crossCheck": [],
    "warnings": [],
    "errors": []
  }
}
```

`asOf` is the time the provider says the price is from. `fetchedAt` is when we last asked. If you show prices publicly, show `asOf`.

## Sources

| Source              | Layer | Free tier                                                             |
| ------------------- | ----- | --------------------------------------------------------------------- |
| MetalCharts         | spot  | 200 requests/month, commercial use allowed with a visible credit link |
| API Ninjas          | spot  | Daily close only, non-commercial                                      |
| Frankfurter         | FX    | Free, no key. ECB reference rates                                     |
| Your own JSON feeds | local | n/a                                                                   |

API Ninjas stays disabled while `APININJAS_PLAN=free`, because its free tier doesn't allow commercial use. Set the plan to `developer` or `business` once you've upgraded.

MetalCharts is the only spot source here that is both free and allowed for commercial use. If you want a real fallback, add a second one (see [Adding a provider](#adding-a-provider)).

## How it handles failure

**Caching.** One MetalCharts refresh is one request and returns all four metals. The default TTL is 6 hours, which is about 120 requests a month against a limit of 200. Traffic to your API doesn't touch upstream quota; only refreshes do. A monthly counter blocks refreshes once `*_MONTHLY_BUDGET` is reached.

**Stale data.** If a refresh fails or the budget is gone, the last cached value is served for up to 48 hours with `stale: true` and the reason in `meta.errors`. After that the source drops out rather than showing old data as current.

**Bad data.** Prices outside a sane range per metal are rejected, which catches upstream unit or currency mistakes. A move of more than 25% against data under 24 hours old is also rejected, and the previous quote is kept with its original timestamp. Both show up in `meta.warnings`.

**Failover.** With `source=auto`, sources are tried in `SPOT_PRIORITY` order until every requested metal is covered.

## Licensing

Sources are off by default. A source only turns on after its id appears in `LICENSE_REVIEWED`:

```dotenv
LICENSE_REVIEWED=metalcharts
```

That's a note to yourself that you've read their terms. Nothing checks it for you. If you're not sure, leave it empty and ask whoever handles legal.

Summary of what I found on 24 Nov 2026. Terms change, so check the provider's site.

MetalCharts allows commercial use on the free tier if you show the credit link. It does not allow reselling API access or republishing the raw data as a competing feed. Redistribution rights are available by agreement.

The catch: a public API that passes MetalCharts data on to other people may count as republishing. Your options are to ask MetalCharts for permission, to use this only behind your own site or product (with the credit shown), or to let users run their own instance with their own key.

The credit text is in `meta.attribution` on every response. Show it wherever you show the prices.

## Local prices

Local prices come from JSON feeds you configure in `LOCAL_FEEDS`:

```dotenv
LOCAL_FEEDS=[{"id":"my-store","name":"My Store","url":"https://example.com/prices.json","license":"own data"}]
```

Each feed must be an HTTPS URL returning:

```json
{
  "asOf": "2026-11-24T02:00:00Z",
  "currency": "IDR",
  "items": [
    {
      "metal": "gold",
      "label": "24K bar",
      "purity": 0.999,
      "buy": 2200000,
      "sell": 2350000
    }
  ]
}
```

Prices are IDR per gram. Invalid items are dropped. A broken feed shows up in `meta.errors` and doesn't affect anything else. Add the feed id to `LICENSE_REVIEWED` like any other source.

Aurum doesn't scrape anything. If you want data from a site like Antam or Pegadaian, run the collection somewhere else (a scheduled GitHub Action that writes a JSON file works fine) and point a feed at the result. Whether you're allowed to scrape a given site is for you to check.

`/v1/prices` compares each local item to spot IDR per gram multiplied by its purity, and reports `sellPremiumPct` and `buyVsSpotPct`.

## Deploying

**Node:** `npm start`.

**Bun:** `bun src/index.ts`.

**Cloudflare Workers:**

```bash
npx wrangler kv namespace create CACHE      # add the binding to wrangler.toml
npx wrangler secret put METALCHARTS_API_KEY
npm run deploy
```

Bind a KV namespace named `CACHE`. Without it the cache and quota counter live in isolate memory and reset constantly, and you'll burn through the free quota. For local runs, `wrangler dev` reads `.dev.vars`, not `.env`.

## Adding a provider

Implement `SpotProvider` in `src/providers/`. `metalcharts.ts` is about 50 lines and a good template. Return prices in USD per troy ounce, fill in `info.license`, `ttl`, `monthlyBudget` and `callsPerRefresh`, then add it to `SPOT_PROVIDERS` in `src/service.ts`. Caching, quota, validation, failover and the license gate apply automatically.

Worth looking at: Metal Sentinel, Metals.Dev, Metals-API. I haven't checked their terms.

## Moving to a paid plan

When you outgrow the free tier, change two env vars. For MetalCharts Starter (10,000 requests/month):

```dotenv
METALCHARTS_TTL=900
METALCHARTS_MONTHLY_BUDGET=9000
```

## Limitations

- Free-tier data refreshes every few hours by default. Don't call it real-time.
- Spot is not a shop price. Use `comparison` to see the gap, and don't use either as a basis for transactions.
- No auth or rate limiting on the API itself. On Cloudflare, add a rate limiting rule.
- The MetalCharts and API Ninjas response formats are read from their public docs and tested against mocks. Try your real keys before relying on it.

## Tests

```bash
npm test
```

20 tests, all with mocked upstreams.
