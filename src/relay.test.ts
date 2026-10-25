import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import pg from "pg";
import { createPool, migrate } from "./db.ts";
import { connectNats, ensureStream, publishBatch, STREAM } from "./relay.ts";
import { registerStudent } from "./students.ts";

const dbUrl = process.env.TEST_DATABASE_URL;
const natsUrl = process.env.TEST_NATS_URL;
const skip = (!dbUrl || !natsUrl) && "TEST_DATABASE_URL and TEST_NATS_URL are needed";
const schema = `test_${randomUUID().replaceAll("-", "")}`;
let pool: pg.Pool;
let nc: NatsConnection;

const register = () =>
  registerStudent(pool, {
    commandId: randomUUID(),
    commandType: "admissions.RegisterStudent",
    version: 1,
    issuedAt: new Date().toISOString(),
    issuedBy: randomUUID(),
    correlationId: randomUUID(),
    payload: {
      firstName: "Relay",
      lastName: "Test",
      fatherName: "Relay Father",
      dateOfBirth: "2016-03-14",
      gender: "female",
      guardian: { name: "Relay Father", relation: "father", phone: "+923001234567" },
    },
  });

before(async () => {
  if (skip) return;
  const admin = new pg.Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const u = new URL(dbUrl!);
  u.searchParams.set("options", `-c search_path=${schema}`);
  pool = createPool(u.href);
  await migrate(pool);
  nc = await connectNats(natsUrl!);
  const jsm = await jetstreamManager(nc);
  await jsm.streams.delete(STREAM).catch(() => {});
  await ensureStream(nc);
  await ensureStream(nc);
});

after(async () => {
  if (skip) return;
  await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
  await nc.close();
});

const messages = async () => (await (await jetstreamManager(nc)).streams.info(STREAM)).state.messages;

test("the relay publishes each unpublished event once, as an envelope on its type subject", { skip }, async () => {
  const { student } = await register();
  await register();
  assert.equal(await publishBatch(pool, nc), 2);
  assert.equal(await publishBatch(pool, nc), 0);
  assert.equal(await messages(), 2);
  const { rows } = await pool.query("select count(*)::int as n from events where published_at is null");
  assert.equal(rows[0].n, 0);
  const jsm = await jetstreamManager(nc);
  const first = await jsm.streams.getMessage(STREAM, { seq: 1 });
  assert.equal(first!.subject, "admissions.StudentRegistered");
  const envelope = first!.json<Record<string, any>>();
  assert.equal(envelope.aggregateId, student.studentId);
  assert.equal(envelope.aggregateVersion, 1);
  assert.equal(envelope.payload.fatherName, "Relay Father");
  assert.equal(first!.header.get("Nats-Msg-Id"), envelope.eventId);
});

test("a crash after the publish and before the mark does not make a second message", { skip }, async () => {
  const before = await messages();
  await pool.query("update events set published_at = null");
  assert.ok((await publishBatch(pool, nc)) >= 2);
  assert.equal(await messages(), before);
});
