import { buildApp } from "./app.ts";
import { createPool, migrate } from "./db.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const pool = createPool(url);
await migrate(pool);
const app = buildApp(pool, { logger: true });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
