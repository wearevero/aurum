import { serve } from "@hono/node-server";
import { loadEnv } from "./load-env";

const env = loadEnv();
console.log(
  env.path
    ? `[env] ${env.path} (${env.loaded} variabel dimuat)`
    : `[env] .env TIDAK ditemukan (dicari di ${process.cwd()})`,
);
console.log(
  `[env] LICENSE_REVIEWED="${process.env.LICENSE_REVIEWED ?? ""}" | METALCHARTS_API_KEY=${process.env.METALCHARTS_API_KEY ? "terisi" : "KOSONG"}`,
);

const { app } = await import("./app");
const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, (i) =>
  console.log(`metal-price-api listening on http://localhost:${i.port}`),
);
