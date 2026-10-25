import type { NatsConnection } from "@nats-io/transport-node";
import { buildApp } from "./app.ts";
import { createPool, migrate } from "./db.ts";
import { connectNats, ensureStream, startRelay } from "./relay.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const pool = createPool(url);
await migrate(pool);
const app = buildApp(pool, { logger: true });

let nc: NatsConnection | undefined;
let stopRelay = () => {};

async function startEvents() {
  const servers = process.env.NATS_URL;
  if (!servers) return app.log.warn("NATS_URL is not set; events stay in the outbox");
  while (!nc) {
    try {
      nc = await connectNats(servers, process.env.NATS_USER, process.env.NATS_PASSWORD);
      await ensureStream(nc);
      stopRelay = startRelay(pool, nc, app.log);
      app.log.info({ servers }, "event relay started");
    } catch (error) {
      app.log.warn({ err: error }, "NATS not ready; trying again in 5 s");
      await nc?.close().catch(() => {});
      nc = undefined;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    stopRelay();
    await app.close();
    await nc?.drain().catch(() => {});
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
void startEvents();
