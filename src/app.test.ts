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
  fatherName: "Imran Khan",
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
  const { fatherName: _, ...noFather } = payload;
  assert.equal((await post({ ...command(), payload: noFather })).statusCode, 400);
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
  assert.equal(list.json()[0].fatherName, "Imran Khan");
  assert.deepEqual(Object.keys(list.json()[0]).sort(), ["admissionNumber", "dateOfBirth", "enrollments", "fatherName", "firstName", "gender", "guardian", "lastName", "studentId"]);
});

test("ready checks the database", { skip }, async () => {
  const response = await buildApp(pool).inject({ url: "/ready" });
  assert.deepEqual(response.json(), { status: "ok" });
});

const envelope = (commandType: string, payload: object, commandId: string = randomUUID()) => ({
  commandId,
  commandType,
  version: 1,
  issuedAt: new Date().toISOString(),
  issuedBy: randomUUID(),
  correlationId: randomUUID(),
  payload,
});

test("enrollment: open a year, create sections, enroll a student, list them", { skip }, async () => {
  const app = buildApp(pool);
  const post = (path: string, type: string, payload: object, id?: string) =>
    app.inject({ method: "POST", url: `/commands/${path}`, payload: envelope(type, payload, id) });

  const year = await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2026-27", startsOn: "2026-04-01", endsOn: "2027-03-31" });
  assert.equal(year.statusCode, 201);
  const academicYearId = year.json().academicYearId;

  assert.equal((await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2026-27", startsOn: "2028-04-01", endsOn: "2029-03-31" })).statusCode, 409);
  const overlap = await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2027-28", startsOn: "2027-03-01", endsOn: "2028-02-28" });
  assert.equal(overlap.statusCode, 409);
  assert.match(overlap.json().error, /overlaps/);
  const backwards = await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2030-31", startsOn: "2031-03-31", endsOn: "2030-04-01" });
  assert.equal(backwards.statusCode, 422);

  const sectionA = await post("create-class-section", "admissions.CreateClassSection", { academicYearId, grade: "class-3", section: "A" });
  assert.equal(sectionA.statusCode, 201);
  await post("create-class-section", "admissions.CreateClassSection", { academicYearId, grade: "class-10", section: "A" });
  await post("create-class-section", "admissions.CreateClassSection", { academicYearId, grade: "nursery", section: "Rose" });
  assert.equal((await post("create-class-section", "admissions.CreateClassSection", { academicYearId, grade: "class-3", section: "A" })).statusCode, 409);
  const noYear = await post("create-class-section", "admissions.CreateClassSection", { academicYearId: randomUUID(), grade: "class-3", section: "A" });
  assert.equal(noYear.statusCode, 404);

  const student = (await app.inject({ method: "POST", url: "/commands/register-student", payload: command({ payload: { ...payload, firstName: "Zainab" } }) })).json();
  const enrollId = randomUUID();
  const enroll = await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classSectionId: sectionA.json().classSectionId }, enrollId);
  assert.equal(enroll.statusCode, 201);
  assert.equal(enroll.json().academicYearId, academicYearId);
  const again = await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classSectionId: sectionA.json().classSectionId }, enrollId);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().enrollmentId, enroll.json().enrollmentId);
  const second = await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classSectionId: sectionA.json().classSectionId });
  assert.equal(second.statusCode, 409);
  assert.match(second.json().error, /already enrolled/);
  assert.equal((await post("enroll-student", "admissions.EnrollStudent", { studentId: randomUUID(), classSectionId: sectionA.json().classSectionId })).statusCode, 404);
  assert.equal((await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classSectionId: randomUUID() })).statusCode, 404);

  const years = (await app.inject({ url: "/academic-years" })).json();
  const listed = years.find((y: { academicYearId: string }) => y.academicYearId === academicYearId);
  assert.deepEqual(listed.sections.map((s: { grade: string; section: string; students: number }) => `${s.grade} ${s.section} ${s.students}`), ["nursery Rose 0", "class-3 A 1", "class-10 A 0"]);

  const students = (await app.inject({ url: "/students" })).json();
  const zainab = students.find((s: { studentId: string }) => s.studentId === student.studentId);
  assert.deepEqual(zainab.enrollments, [{ academicYearId, academicYearName: "2026-27", classSectionId: sectionA.json().classSectionId, grade: "class-3", section: "A" }]);
  const { rows } = await pool.query("select event_type, count(*)::int as n from events where event_type <> 'admissions.StudentRegistered' group by 1 order by 1");
  assert.deepEqual(rows, [
    { event_type: "admissions.AcademicYearOpened", n: 1 },
    { event_type: "admissions.ClassSectionCreated", n: 3 },
    { event_type: "admissions.StudentEnrolled", n: 1 },
  ]);
});

test("enrollment: a command with the wrong payload or type is refused", { skip }, async () => {
  const app = buildApp(pool);
  const send = (path: string, body: object) => app.inject({ method: "POST", url: `/commands/${path}`, payload: body });
  assert.equal((await send("create-class-section", envelope("admissions.CreateClassSection", { academicYearId: randomUUID(), grade: "class-11", section: "A" }))).statusCode, 400);
  assert.equal((await send("enroll-student", envelope("admissions.CreateClassSection", { studentId: randomUUID(), classSectionId: randomUUID() }))).statusCode, 400);
  assert.equal((await send("open-academic-year", envelope("admissions.OpenAcademicYear", { name: "2026/27", startsOn: "2026-04-01", endsOn: "2027-03-31" }))).statusCode, 400);
});
