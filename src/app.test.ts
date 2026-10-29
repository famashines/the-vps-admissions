import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { buildApp } from "./app.ts";
import { createPool, migrate } from "./db.ts";
import { ageOn, registerStudent, type RegisterStudent } from "./students.ts";

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
  assert.deepEqual(Object.keys(list.json()[0]).sort(), ["admissionNumber", "dateOfBirth", "enrollments", "fatherName", "firstName", "gender", "guardian", "lastName", "leftOn", "leftReason", "studentId", "version"]);
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

test("enrollment: open a year, open classes, enroll a student, list them", { skip }, async () => {
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

  const class3 = await post("open-class", "admissions.OpenClass", { academicYearId, grade: "class-3" });
  assert.equal(class3.statusCode, 201);
  await post("open-class", "admissions.OpenClass", { academicYearId, grade: "class-10" });
  await post("open-class", "admissions.OpenClass", { academicYearId, grade: "kg-1" });
  await post("open-class", "admissions.OpenClass", { academicYearId, grade: "playgroup" });
  const twice = await post("open-class", "admissions.OpenClass", { academicYearId, grade: "class-3" });
  assert.equal(twice.statusCode, 409);
  assert.match(twice.json().error, /has a class/);
  const noYear = await post("open-class", "admissions.OpenClass", { academicYearId: randomUUID(), grade: "class-3" });
  assert.equal(noYear.statusCode, 404);

  const classId = class3.json().classId;
  const student = (await app.inject({ method: "POST", url: "/commands/register-student", payload: command({ payload: { ...payload, firstName: "Zainab" } }) })).json();
  const enrollId = randomUUID();
  const enroll = await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classId }, enrollId);
  assert.equal(enroll.statusCode, 201);
  assert.equal(enroll.json().academicYearId, academicYearId);
  const again = await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classId }, enrollId);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().enrollmentId, enroll.json().enrollmentId);
  const second = await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classId });
  assert.equal(second.statusCode, 409);
  assert.match(second.json().error, /already enrolled/);
  assert.equal((await post("enroll-student", "admissions.EnrollStudent", { studentId: randomUUID(), classId })).statusCode, 404);
  assert.equal((await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classId: randomUUID() })).statusCode, 404);

  const years = (await app.inject({ url: "/academic-years" })).json();
  const listed = years.find((y: { academicYearId: string }) => y.academicYearId === academicYearId);
  assert.deepEqual(listed.classes.map((c: { grade: string; students: number }) => `${c.grade} ${c.students}`), ["playgroup 0", "kg-1 0", "class-3 1", "class-10 0"]);

  const students = (await app.inject({ url: "/students" })).json();
  const zainab = students.find((s: { studentId: string }) => s.studentId === student.studentId);
  assert.deepEqual(zainab.enrollments, [{ enrollmentId: enroll.json().enrollmentId, version: 1, academicYearId, academicYearName: "2026-27", classId, grade: "class-3" }]);
  const { rows } = await pool.query("select event_type, count(*)::int as n from events where event_type <> 'admissions.StudentRegistered' group by 1 order by 1");
  assert.deepEqual(rows, [
    { event_type: "admissions.AcademicYearOpened", n: 1 },
    { event_type: "admissions.ClassOpened", n: 4 },
    { event_type: "admissions.StudentEnrolled", n: 1 },
  ]);
});

test("enrollment: a command with the wrong payload or type is refused", { skip }, async () => {
  const app = buildApp(pool);
  const send = (path: string, body: object) => app.inject({ method: "POST", url: `/commands/${path}`, payload: body });
  assert.equal((await send("open-class", envelope("admissions.OpenClass", { academicYearId: randomUUID(), grade: "nursery" }))).statusCode, 400);
  assert.equal((await send("open-class", envelope("admissions.OpenClass", { academicYearId: randomUUID(), grade: "class-3", section: "A" }))).statusCode, 400);
  assert.equal((await send("enroll-student", envelope("admissions.OpenClass", { studentId: randomUUID(), classId: randomUUID() }))).statusCode, 400);
  assert.equal((await send("open-academic-year", envelope("admissions.OpenAcademicYear", { name: "2026/27", startsOn: "2026-04-01", endsOn: "2027-03-31" }))).statusCode, 400);
});

test("the age is counted in whole years, with the birthday", () => {
  assert.equal(ageOn("2016-03-14", "2026-03-13"), 9);
  assert.equal(ageOn("2016-03-14", "2026-03-14"), 10);
  assert.equal(ageOn("2016-02-29", "2026-02-28"), 9);
  assert.equal(ageOn("2016-02-29", "2026-03-01"), 10);
});

test("a student must be 2 to 25 years old on the registration day", { skip }, async () => {
  const app = buildApp(pool);
  const at = (dateOfBirth: string, now: string) => registerStudent(pool, command({ payload: { ...payload, dateOfBirth } }), new Date(now)).then(() => 201, (e) => e.status);
  assert.equal(await at("1241-11-01", "2026-10-25T12:00:00Z"), 422);
  assert.equal(await at("2025-01-01", "2026-10-25T12:00:00Z"), 422);
  assert.equal(await at("2024-10-25", "2026-10-25T12:00:00Z"), 201);
  assert.equal(await at("2001-10-25", "2026-10-25T12:00:00Z"), 201);
  assert.equal(await at("2000-10-25", "2026-10-25T12:00:00Z"), 422);
  assert.equal(await at("2024-10-26", "2026-10-25T18:59:00Z"), 422);
  assert.equal(await at("2024-10-26", "2026-10-25T19:01:00Z"), 201);
  const response = await app.inject({ method: "POST", url: "/commands/register-student", payload: command({ payload: { ...payload, dateOfBirth: "1241-11-01" } }) });
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json().fields.map((f: { field: string }) => f.field), ["dateOfBirth"]);
});

test("edit: details, class and school year, each with its version; a class with no students can be removed", { skip }, async () => {
  const app = buildApp(pool);
  const post = (path: string, type: string, payload: object, id?: string) =>
    app.inject({ method: "POST", url: `/commands/${path}`, payload: envelope(type, payload, id) });

  const year = (await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2040-41", startsOn: "2040-04-01", endsOn: "2041-03-31" })).json();
  const a = (await post("open-class", "admissions.OpenClass", { academicYearId: year.academicYearId, grade: "class-5" })).json();
  const b = (await post("open-class", "admissions.OpenClass", { academicYearId: year.academicYearId, grade: "class-6" })).json();
  const student = (await app.inject({ method: "POST", url: "/commands/register-student", payload: command({ payload: { ...payload, firstName: "Hamza" } }) })).json();
  const enrollment = (await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classId: a.classId })).json();

  const details = { ...payload, studentId: student.studentId, firstName: "Hamza Ali", guardian: { ...payload.guardian, phone: "+923331112222" } };
  const editId = randomUUID();
  const edited = await post("update-student-details", "admissions.UpdateStudentDetails", { ...details, expectedVersion: 1 }, editId);
  assert.equal(edited.statusCode, 201);
  assert.equal((await post("update-student-details", "admissions.UpdateStudentDetails", { ...details, expectedVersion: 1 }, editId)).statusCode, 200);
  const stale = await post("update-student-details", "admissions.UpdateStudentDetails", { ...details, lastName: "Old", expectedVersion: 1 });
  assert.equal(stale.statusCode, 409);
  assert.match(stale.json().error, /changed by someone else/);
  const tooOld = await post("update-student-details", "admissions.UpdateStudentDetails", { ...details, dateOfBirth: "1990-01-01", expectedVersion: 2 });
  assert.equal(tooOld.statusCode, 422);
  assert.equal(tooOld.json().fields[0].field, "dateOfBirth");
  assert.equal((await post("update-student-details", "admissions.UpdateStudentDetails", { ...details, studentId: randomUUID(), expectedVersion: 1 })).statusCode, 404);
  assert.equal((await post("update-student-details", "admissions.UpdateStudentDetails", { ...details, admissionNumber: "x", expectedVersion: 2 })).statusCode, 400);

  const race = await Promise.all([1, 2, 3].map(() => post("update-student-details", "admissions.UpdateStudentDetails", { ...details, expectedVersion: 2 })));
  assert.deepEqual(race.map((r) => r.statusCode).sort(), [201, 409, 409]);

  const moved = await post("change-student-class", "admissions.ChangeStudentClass", { enrollmentId: enrollment.enrollmentId, expectedVersion: 1, classId: b.classId });
  assert.equal(moved.statusCode, 201);
  assert.equal(moved.json().previousClassId, a.classId);
  const other = (await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2041-42", startsOn: "2041-04-01", endsOn: "2042-03-31" })).json();
  const otherClass = (await post("open-class", "admissions.OpenClass", { academicYearId: other.academicYearId, grade: "class-5" })).json();
  const wrongYear = await post("change-student-class", "admissions.ChangeStudentClass", { enrollmentId: enrollment.enrollmentId, expectedVersion: 2, classId: otherClass.classId });
  assert.equal(wrongYear.statusCode, 422);

  const busy = await post("close-class", "admissions.CloseClass", { classId: b.classId, expectedVersion: 1 });
  assert.equal(busy.statusCode, 409);
  assert.match(busy.json().error, /Move the students/);
  const closeId = randomUUID();
  assert.equal((await post("close-class", "admissions.CloseClass", { classId: a.classId, expectedVersion: 1 }, closeId)).statusCode, 201);
  assert.equal((await post("close-class", "admissions.CloseClass", { classId: a.classId, expectedVersion: 1 }, closeId)).statusCode, 200);
  assert.equal((await post("close-class", "admissions.CloseClass", { classId: a.classId, expectedVersion: 1 })).statusCode, 409);
  assert.equal((await post("close-class", "admissions.CloseClass", { classId: randomUUID(), expectedVersion: 1 })).statusCode, 404);
  assert.equal((await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classId: a.classId })).statusCode, 404);
  assert.equal((await post("open-class", "admissions.OpenClass", { academicYearId: year.academicYearId, grade: "class-5" })).statusCode, 201);

  const yearEdit = { academicYearId: year.academicYearId, name: "2040-41", startsOn: "2040-03-15", endsOn: "2041-03-31" };
  assert.equal((await post("update-academic-year", "admissions.UpdateAcademicYear", { ...yearEdit, expectedVersion: 1 })).statusCode, 201);
  assert.equal((await post("update-academic-year", "admissions.UpdateAcademicYear", { ...yearEdit, endsOn: "2041-04-15", expectedVersion: 2 })).statusCode, 409);
  assert.equal((await post("update-academic-year", "admissions.UpdateAcademicYear", { ...yearEdit, name: "2041-42", expectedVersion: 2 })).statusCode, 409);
  assert.equal((await post("update-academic-year", "admissions.UpdateAcademicYear", { ...yearEdit, endsOn: "2040-01-01", expectedVersion: 2 })).statusCode, 422);

  const listed = (await app.inject({ url: "/students" })).json().find((s: { studentId: string }) => s.studentId === student.studentId);
  assert.equal(listed.version, 3);
  assert.equal(listed.firstName, "Hamza Ali");
  assert.equal(listed.guardian.phone, "+923331112222");
  assert.deepEqual(listed.enrollments.map((e: { enrollmentId: string; version: number; grade: string }) => [e.enrollmentId, e.version, e.grade]), [[enrollment.enrollmentId, 2, "class-6"]]);
  const y = (await app.inject({ url: "/academic-years" })).json().find((x: { academicYearId: string }) => x.academicYearId === year.academicYearId);
  assert.equal(y.version, 2);
  assert.equal(y.startsOn, "2040-03-15");
  assert.deepEqual(y.classes.map((c: { grade: string; version: number; students: number }) => `${c.grade} v${c.version} ${c.students}`), ["class-5 v1 0", "class-6 v1 1"]);
  const { rows } = await pool.query("select event_type, aggregate_version from events where aggregate_id = $1 order by aggregate_version", [student.studentId]);
  assert.deepEqual(rows.map((r) => `${r.event_type} ${r.aggregate_version}`), ["admissions.StudentRegistered 1", "admissions.StudentDetailsUpdated 2", "admissions.StudentDetailsUpdated 3"]);
});

test("migration 005 merges the sections of a grade into one class, with an event for each change", { skip }, async () => {
  const old = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create schema ${old}`);
  await admin.end();
  const url = new URL(base!);
  url.searchParams.set("options", `-c search_path=${old}`);
  const db = createPool(url.href);
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  for (const f of ["001_students.sql", "002_enrollment.sql", "003_father_name.sql", "004_outbox.sql"]) copyFileSync(new URL(`../migrations/${f}`, import.meta.url), join(dir, f));
  try {
    await migrate(db, pathToFileURL(`${dir}/`));
    const [year, a, b, c, x, by] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const ev = (aggregateId: string, version: number, type: string, payload: object = {}) =>
      db.query(
        `insert into events (event_id, event_type, version, aggregate_id, aggregate_version, occurred_at, correlation_id, causation_id, issued_by, payload, published_at)
         values (gen_random_uuid(), $1, 1, $2, $3, now(), gen_random_uuid(), gen_random_uuid(), $4, $5, now())`,
        [type, aggregateId, version, by, payload],
      );
    await db.query("insert into academic_years values ($1, '2026-27', '2026-04-01', '2027-03-31', now(), $2)", [year, by]);
    for (const [id, grade, section, at] of [[a, "class-3", "A", "2026-04-01"], [b, "class-3", "B", "2026-04-02"], [c, "class-3", "C", "2026-04-03"], [x, "class-5", "A", "2026-04-04"]]) {
      await db.query("insert into class_sections values ($1, $2, $3, $4, $5, $6)", [id, year, grade, section, at, by]);
      await ev(id, 1, "admissions.ClassSectionCreated");
    }
    await ev(b, 2, "admissions.ClassSectionUpdated");
    const enrollments: Record<string, string> = {};
    for (const [n, section] of [[1, a], [2, b], [3, c]] as const) {
      const student = randomUUID();
      enrollments[section] = randomUUID();
      await db.query(
        `insert into students (student_id, admission_number, first_name, last_name, date_of_birth, gender, guardian_name, guardian_relation, guardian_phone, registered_at, registered_by)
         values ($1, $2, 'A', 'B', '2016-01-01', 'male', 'C', 'father', '+923001234567', now(), $3)`,
        [student, `2026-000${n}`, by],
      );
      await db.query("insert into enrollments values ($1, $2, $3, $4, now(), $5)", [enrollments[section], student, section, year, by]);
      await ev(enrollments[section], 1, "admissions.StudentEnrolled");
    }

    await migrate(db);

    assert.deepEqual((await db.query("select class_id, grade from classes order by grade")).rows, [{ class_id: a, grade: "class-3" }, { class_id: x, grade: "class-5" }]);
    assert.deepEqual((await db.query("select distinct class_id from enrollments")).rows, [{ class_id: a }]);
    const { rows } = await db.query("select event_type, aggregate_id, aggregate_version, payload from events where published_at is null");
    assert.deepEqual(rows.map((r) => `${r.event_type} ${r.aggregate_id} ${r.aggregate_version}`).sort(), [
      `admissions.ClassClosed ${b} 3`,
      `admissions.ClassClosed ${c} 2`,
      `admissions.StudentClassChanged ${enrollments[b]} 2`,
      `admissions.StudentClassChanged ${enrollments[c]} 2`,
    ].sort());
    const changed = rows.find((r) => r.aggregate_id === enrollments[b]).payload;
    assert.deepEqual([changed.classId, changed.previousClassId, changed.academicYearId], [a, b, year]);
    assert.deepEqual(rows.find((r) => r.aggregate_id === c).payload, { classId: c, academicYearId: year, grade: "class-3" });
    await assert.rejects(db.query("insert into classes values ($1, $2, 'class-3', now(), $3)", [randomUUID(), year, by]), { constraint: "classes_one_per_grade" });
  } finally {
    await db.query(`drop schema ${old} cascade`);
    await db.end();
    rmSync(dir, { recursive: true });
  }
});

test("leaving: mark a student as left, refuse a new class, cancel the leaving", { skip }, async () => {
  const app = buildApp(pool);
  const post = (path: string, type: string, payload: object, id?: string) =>
    app.inject({ method: "POST", url: `/commands/${path}`, payload: envelope(type, payload, id) });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

  const year = (await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2042-43", startsOn: "2042-04-01", endsOn: "2043-03-31" })).json();
  const a = (await post("open-class", "admissions.OpenClass", { academicYearId: year.academicYearId, grade: "class-2" })).json();
  const b = (await post("open-class", "admissions.OpenClass", { academicYearId: year.academicYearId, grade: "class-3" })).json();
  const student = (await app.inject({ method: "POST", url: "/commands/register-student", payload: command({ payload: { ...payload, firstName: "Zara" } }) })).json();
  const enrollment = (await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classId: a.classId })).json();
  const leave = { studentId: student.studentId, leftOn: today, reason: "Family moved to Lahore" };

  const future = await post("mark-student-left", "admissions.MarkStudentLeft", { ...leave, leftOn: "2099-01-01", expectedVersion: 1 });
  assert.equal(future.statusCode, 422);
  assert.equal(future.json().fields[0].field, "leftOn");
  const early = await post("mark-student-left", "admissions.MarkStudentLeft", { ...leave, leftOn: "2020-01-01", expectedVersion: 1 });
  assert.equal(early.statusCode, 422);
  assert.match(early.json().error, /before the registration day/);
  assert.equal((await post("mark-student-left", "admissions.MarkStudentLeft", { ...leave, reason: " x ", expectedVersion: 1 })).statusCode, 400);
  assert.equal((await post("mark-student-left", "admissions.MarkStudentLeft", { ...leave, studentId: randomUUID(), expectedVersion: 1 })).statusCode, 404);

  const leaveId = randomUUID();
  const left = await post("mark-student-left", "admissions.MarkStudentLeft", { ...leave, expectedVersion: 1 }, leaveId);
  assert.equal(left.statusCode, 201);
  assert.deepEqual(left.json(), leave);
  assert.equal((await post("mark-student-left", "admissions.MarkStudentLeft", { ...leave, expectedVersion: 1 }, leaveId)).statusCode, 200);
  const again = await post("mark-student-left", "admissions.MarkStudentLeft", { ...leave, expectedVersion: 2 });
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error, /already left/);

  const listed = (await app.inject({ url: "/students" })).json().find((s: { studentId: string }) => s.studentId === student.studentId);
  assert.deepEqual([listed.version, listed.leftOn, listed.leftReason], [2, today, "Family moved to Lahore"]);
  const move = await post("change-student-class", "admissions.ChangeStudentClass", { enrollmentId: enrollment.enrollmentId, expectedVersion: 1, classId: b.classId });
  assert.equal(move.statusCode, 409);
  assert.match(move.json().error, /has left the school/);
  const other = (await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2043-44", startsOn: "2043-04-01", endsOn: "2044-03-31" })).json();
  const next = (await post("open-class", "admissions.OpenClass", { academicYearId: other.academicYearId, grade: "class-3" })).json();
  assert.equal((await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classId: next.classId })).statusCode, 409);

  assert.equal((await post("cancel-student-leaving", "admissions.CancelStudentLeaving", { studentId: student.studentId, expectedVersion: 1 })).statusCode, 409);
  const cancelled = await post("cancel-student-leaving", "admissions.CancelStudentLeaving", { studentId: student.studentId, expectedVersion: 2 });
  assert.equal(cancelled.statusCode, 201);
  assert.deepEqual(cancelled.json(), { studentId: student.studentId, leftOn: today });
  const notLeft = await post("cancel-student-leaving", "admissions.CancelStudentLeaving", { studentId: student.studentId, expectedVersion: 3 });
  assert.equal(notLeft.statusCode, 409);
  assert.match(notLeft.json().error, /has not left/);
  assert.equal((await post("change-student-class", "admissions.ChangeStudentClass", { enrollmentId: enrollment.enrollmentId, expectedVersion: 1, classId: b.classId })).statusCode, 201);

  const back = (await app.inject({ url: "/students" })).json().find((s: { studentId: string }) => s.studentId === student.studentId);
  assert.deepEqual([back.leftOn, back.leftReason], [null, null]);
  const { rows } = await pool.query("select event_type from events where aggregate_id = $1 order by aggregate_version", [student.studentId]);
  assert.deepEqual(rows.map((r) => r.event_type), ["admissions.StudentRegistered", "admissions.StudentLeft", "admissions.StudentLeavingCancelled"]);
});
