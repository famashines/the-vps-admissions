import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { buildApp } from "./app.ts";
import { createPool, migrate } from "./db.ts";
import { registerStudent, type RegisterStudent } from "./students.ts";

const base = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll("-", "")}`;
let pool: pg.Pool;

const payload = {
  firstName: "Ayesha",
  lastName: "Khan",
  dateOfBirth: "2016-03-14",
  gender: "female",
  guardian: { name: "Imran Khan", relation: "father", phone: "+923001234567" },
} as const;

const command = (overrides: Partial<RegisterStudent> = {}): RegisterStudent => ({
  commandId: randomUUID(),
  commandType: "admissions.RegisterStudent",
  version: 1,
  issuedAt: new Date().toISOString(),
  issuedBy: randomUUID(),
  correlationId: randomUUID(),
  payload: { ...payload },
  ...overrides,
});

before(async () => {
  if (!base) return;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  pool = createPool(url.href);
  await migrate(pool);
  await migrate(pool);
});

after(async () => {
  if (!base) return;
  await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

const skip = !base && "TEST_DATABASE_URL is not set";

test("register gives the next admission number of the year and saves the student and the event", { skip }, async () => {
  const app = buildApp(pool);
  const first = await app.inject({ method: "POST", url: "/commands/register-student", payload: command({ issuedAt: "2026-05-01T10:00:00Z" }) });
  assert.equal(first.statusCode, 201);
  const second = await app.inject({ method: "POST", url: "/commands/register-student", payload: command() });
  const year = new Intl.DateTimeFormat("en", { timeZone: "Asia/Karachi", year: "numeric" }).format(new Date());
  assert.equal(first.json().admissionNumber, `${year}-0001`);
  assert.equal(second.json().admissionNumber, `${year}-0002`);
  const { rows } = await pool.query("select event_type, aggregate_id, aggregate_version from events where aggregate_id = $1", [first.json().studentId]);
  assert.deepEqual(rows, [{ event_type: "admissions.StudentRegistered", aggregate_id: first.json().studentId, aggregate_version: 1 }]);
});

test("the same command twice gives the same student, not a second one", { skip }, async () => {
  const app = buildApp(pool);
  const same = command();
  const a = await app.inject({ method: "POST", url: "/commands/register-student", payload: same });
  const b = await app.inject({ method: "POST", url: "/commands/register-student", payload: same });
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 200);
  assert.equal(a.json().studentId, b.json().studentId);
  const { rows } = await pool.query("select count(*)::int as n from events where causation_id = $1", [same.commandId]);
  assert.equal(rows[0].n, 1);
});

test("the same command at the same time also gives one student", { skip }, async () => {
  const same = command();
  const results = await Promise.all([registerStudent(pool, same), registerStudent(pool, same), registerStudent(pool, same)]);
  assert.equal(new Set(results.map((r) => r.student.studentId)).size, 1);
  const { rows } = await pool.query("select count(*)::int as n from students where student_id = $1", [results[0].student.studentId]);
  assert.equal(rows[0].n, 1);
});

test("the year of the admission number is the year in Pakistan", { skip }, async () => {
  const { student } = await registerStudent(pool, command(), new Date("2020-12-31T20:00:00Z"));
  assert.equal(student.admissionNumber, "2021-0001");
});

test("invalid commands are refused", { skip }, async () => {
  const app = buildApp(pool);
  const post = (body: unknown) => app.inject({ method: "POST", url: "/commands/register-student", payload: body as object });
  assert.equal((await post({ ...command(), payload: { ...payload, dateOfBirth: "2016-02-30" } })).statusCode, 400);
  assert.equal((await post({ ...command(), payload: { ...payload, grade: "3" } })).statusCode, 400);
  assert.equal((await post({ ...command(), commandType: "admissions.EnrollStudent" })).statusCode, 400);
  assert.equal((await post({ ...command(), commandId: "not-a-uuid" })).statusCode, 400);
});

test("the list has the students, newest first, with the date as YYYY-MM-DD", { skip }, async () => {
  const app = buildApp(pool);
  const created = await app.inject({ method: "POST", url: "/commands/register-student", payload: command({ payload: { ...payload, firstName: "Bilal" } }) });
  const list = await app.inject({ url: "/students" });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json()[0].studentId, created.json().studentId);
  assert.equal(list.json()[0].dateOfBirth, "2016-03-14");
  assert.deepEqual(Object.keys(list.json()[0]).sort(), ["admissionNumber", "dateOfBirth", "firstName", "gender", "guardian", "lastName", "studentId"]);
});

test("ready checks the database", { skip }, async () => {
  const response = await buildApp(pool).inject({ url: "/ready" });
  assert.deepEqual(response.json(), { status: "ok" });
});
