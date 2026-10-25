import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  assert.deepEqual(Object.keys(list.json()[0]).sort(), ["admissionNumber", "dateOfBirth", "enrollments", "fatherName", "firstName", "gender", "guardian", "lastName", "studentId", "version"]);
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
  assert.deepEqual(zainab.enrollments, [{ enrollmentId: enroll.json().enrollmentId, version: 1, academicYearId, academicYearName: "2026-27", classSectionId: sectionA.json().classSectionId, grade: "class-3", section: "A" }]);
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

test("edit: details, section, section name and school year, each with its version", { skip }, async () => {
  const app = buildApp(pool);
  const post = (path: string, type: string, payload: object, id?: string) =>
    app.inject({ method: "POST", url: `/commands/${path}`, payload: envelope(type, payload, id) });

  const year = (await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2040-41", startsOn: "2040-04-01", endsOn: "2041-03-31" })).json();
  const a = (await post("create-class-section", "admissions.CreateClassSection", { academicYearId: year.academicYearId, grade: "class-5", section: "A" })).json();
  const b = (await post("create-class-section", "admissions.CreateClassSection", { academicYearId: year.academicYearId, grade: "class-5", section: "B" })).json();
  const student = (await app.inject({ method: "POST", url: "/commands/register-student", payload: command({ payload: { ...payload, firstName: "Hamza" } }) })).json();
  const enrollment = (await post("enroll-student", "admissions.EnrollStudent", { studentId: student.studentId, classSectionId: a.classSectionId })).json();

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

  const moved = await post("change-student-section", "admissions.ChangeStudentSection", { enrollmentId: enrollment.enrollmentId, expectedVersion: 1, classSectionId: b.classSectionId });
  assert.equal(moved.statusCode, 201);
  assert.equal(moved.json().previousClassSectionId, a.classSectionId);
  const other = (await post("open-academic-year", "admissions.OpenAcademicYear", { name: "2041-42", startsOn: "2041-04-01", endsOn: "2042-03-31" })).json();
  const otherSection = (await post("create-class-section", "admissions.CreateClassSection", { academicYearId: other.academicYearId, grade: "class-5", section: "A" })).json();
  const wrongYear = await post("change-student-section", "admissions.ChangeStudentSection", { enrollmentId: enrollment.enrollmentId, expectedVersion: 2, classSectionId: otherSection.classSectionId });
  assert.equal(wrongYear.statusCode, 422);

  const rename = await post("update-class-section", "admissions.UpdateClassSection", { classSectionId: a.classSectionId, expectedVersion: 1, grade: "class-6", section: "Rose" });
  assert.equal(rename.statusCode, 201);
  const busy = await post("update-class-section", "admissions.UpdateClassSection", { classSectionId: b.classSectionId, expectedVersion: 1, grade: "class-6", section: "B" });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().fields[0].field, "grade");
  assert.equal((await post("update-class-section", "admissions.UpdateClassSection", { classSectionId: b.classSectionId, expectedVersion: 1, grade: "class-5", section: "Blue" })).statusCode, 201);
  const taken = await post("update-class-section", "admissions.UpdateClassSection", { classSectionId: b.classSectionId, expectedVersion: 2, grade: "class-5", section: "A" });
  assert.equal(taken.statusCode, 201);
  const clash = await post("update-class-section", "admissions.UpdateClassSection", { classSectionId: a.classSectionId, expectedVersion: 2, grade: "class-5", section: "A" });
  assert.equal(clash.statusCode, 409);
  assert.match(clash.json().error, /section exists/);

  const yearEdit = { academicYearId: year.academicYearId, name: "2040-41", startsOn: "2040-03-15", endsOn: "2041-03-31" };
  assert.equal((await post("update-academic-year", "admissions.UpdateAcademicYear", { ...yearEdit, expectedVersion: 1 })).statusCode, 201);
  assert.equal((await post("update-academic-year", "admissions.UpdateAcademicYear", { ...yearEdit, endsOn: "2041-04-15", expectedVersion: 2 })).statusCode, 409);
  assert.equal((await post("update-academic-year", "admissions.UpdateAcademicYear", { ...yearEdit, name: "2041-42", expectedVersion: 2 })).statusCode, 409);
  assert.equal((await post("update-academic-year", "admissions.UpdateAcademicYear", { ...yearEdit, endsOn: "2040-01-01", expectedVersion: 2 })).statusCode, 422);

  const listed = (await app.inject({ url: "/students" })).json().find((s: { studentId: string }) => s.studentId === student.studentId);
  assert.equal(listed.version, 3);
  assert.equal(listed.firstName, "Hamza Ali");
  assert.equal(listed.guardian.phone, "+923331112222");
  assert.deepEqual(listed.enrollments.map((e: { enrollmentId: string; version: number; section: string }) => [e.enrollmentId, e.version, e.section]), [[enrollment.enrollmentId, 2, "A"]]);
  const y = (await app.inject({ url: "/academic-years" })).json().find((x: { academicYearId: string }) => x.academicYearId === year.academicYearId);
  assert.equal(y.version, 2);
  assert.equal(y.startsOn, "2040-03-15");
  assert.deepEqual(y.sections.map((s: { grade: string; section: string; version: number; students: number }) => `${s.grade} ${s.section} v${s.version} ${s.students}`), ["class-5 A v3 1", "class-6 Rose v2 0"]);
  const { rows } = await pool.query("select event_type, aggregate_version from events where aggregate_id = $1 order by aggregate_version", [student.studentId]);
  assert.deepEqual(rows.map((r) => `${r.event_type} ${r.aggregate_version}`), ["admissions.StudentRegistered 1", "admissions.StudentDetailsUpdated 2", "admissions.StudentDetailsUpdated 3"]);
});
