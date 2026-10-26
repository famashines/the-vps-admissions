import { randomUUID } from "node:crypto";
import type {
  AcademicYearOpenedEventPayloadV1,
  AcademicYearUpdatedEventPayloadV1,
  ChangeStudentClassCommandPayloadV1,
  ClassClosedEventPayloadV1,
  ClassOpenedEventPayloadV1,
  CloseClassCommandPayloadV1,
  EnrollStudentCommandPayloadV1,
  OpenAcademicYearCommandPayloadV1,
  OpenClassCommandPayloadV1,
  StudentClassChangedEventPayloadV1,
  StudentEnrolledEventPayloadV1,
  UpdateAcademicYearCommandPayloadV1,
} from "@famashines/the-vps-contracts";
import type pg from "pg";
import { nextVersion, Refused, runCommand, type Command } from "./command.ts";
import { versionOf } from "./students.ts";

export const GRADES = ["playgroup", "kg-1", "kg-2", "class-1", "class-2", "class-3", "class-4", "class-5", "class-6", "class-7", "class-8", "class-9", "class-10"];

export async function openAcademicYear(pool: pg.Pool, command: Command<OpenAcademicYearCommandPayloadV1>, now = new Date()) {
  const p = command.payload;
  if (p.endsOn <= p.startsOn) throw new Refused(422, "The school year must end after it starts.");
  return runCommand<OpenAcademicYearCommandPayloadV1, AcademicYearOpenedEventPayloadV1>(pool, command, async (client) => {
    const year: AcademicYearOpenedEventPayloadV1 = { academicYearId: randomUUID(), name: p.name, startsOn: p.startsOn, endsOn: p.endsOn };
    await client.query(
      "insert into academic_years (academic_year_id, name, starts_on, ends_on, opened_at, opened_by) values ($1, $2, $3, $4, $5, $6)",
      [year.academicYearId, p.name, p.startsOn, p.endsOn, now, command.issuedBy],
    );
    return { value: year, event: { type: "admissions.AcademicYearOpened", aggregateId: year.academicYearId, aggregateVersion: 1, payload: year } };
  }, now);
}

export async function openClass(pool: pg.Pool, command: Command<OpenClassCommandPayloadV1>, now = new Date()) {
  const p = command.payload;
  return runCommand<OpenClassCommandPayloadV1, ClassOpenedEventPayloadV1>(pool, command, async (client) => {
    const opened: ClassOpenedEventPayloadV1 = { classId: randomUUID(), academicYearId: p.academicYearId, grade: p.grade };
    await client.query(
      "insert into classes (class_id, academic_year_id, grade, created_at, created_by) values ($1, $2, $3, $4, $5)",
      [opened.classId, p.academicYearId, p.grade, now, command.issuedBy],
    );
    return { value: opened, event: { type: "admissions.ClassOpened", aggregateId: opened.classId, aggregateVersion: 1, payload: opened } };
  }, now);
}

export async function closeClass(pool: pg.Pool, command: Command<CloseClassCommandPayloadV1>, now = new Date()) {
  const p = command.payload;
  return runCommand<CloseClassCommandPayloadV1, ClassClosedEventPayloadV1>(pool, command, async (client) => {
    const aggregateVersion = await nextVersion(client, p.classId, p.expectedVersion, "class");
    const { rows } = await client.query(
      `select academic_year_id, grade, (select count(*)::int from enrollments where class_id = $1) as students
       from classes where class_id = $1 for update`,
      [p.classId],
    );
    if (!rows[0]) throw new Refused(404, "The class does not exist.");
    if (rows[0].students > 0) throw new Refused(409, "Move the students to another class before you remove this class.");
    await client.query("delete from classes where class_id = $1", [p.classId]);
    const closed: ClassClosedEventPayloadV1 = { classId: p.classId, academicYearId: rows[0].academic_year_id, grade: rows[0].grade };
    return { value: closed, event: { type: "admissions.ClassClosed", aggregateId: p.classId, aggregateVersion, payload: closed } };
  }, now);
}

export async function enrollStudent(pool: pg.Pool, command: Command<EnrollStudentCommandPayloadV1>, now = new Date()) {
  const p = command.payload;
  return runCommand<EnrollStudentCommandPayloadV1, StudentEnrolledEventPayloadV1>(pool, command, async (client) => {
    const { rows } = await client.query("select academic_year_id from classes where class_id = $1", [p.classId]);
    if (!rows[0]) throw new Refused(404, "The class does not exist.");
    const enrollment: StudentEnrolledEventPayloadV1 = {
      enrollmentId: randomUUID(),
      studentId: p.studentId,
      classId: p.classId,
      academicYearId: rows[0].academic_year_id,
    };
    await client.query(
      "insert into enrollments (enrollment_id, student_id, class_id, academic_year_id, enrolled_at, enrolled_by) values ($1, $2, $3, $4, $5, $6)",
      [enrollment.enrollmentId, p.studentId, p.classId, enrollment.academicYearId, now, command.issuedBy],
    );
    return { value: enrollment, event: { type: "admissions.StudentEnrolled", aggregateId: enrollment.enrollmentId, aggregateVersion: 1, payload: enrollment } };
  }, now);
}

export async function changeStudentClass(pool: pg.Pool, command: Command<ChangeStudentClassCommandPayloadV1>, now = new Date()) {
  const p = command.payload;
  return runCommand<ChangeStudentClassCommandPayloadV1, StudentClassChangedEventPayloadV1>(pool, command, async (client) => {
    const aggregateVersion = await nextVersion(client, p.enrollmentId, p.expectedVersion, "enrollment");
    const target = (await client.query("select academic_year_id from classes where class_id = $1", [p.classId])).rows[0];
    if (!target) throw new Refused(404, "The class does not exist.", "classId");
    const { rows } = await client.query("select student_id, academic_year_id, class_id from enrollments where enrollment_id = $1", [p.enrollmentId]);
    if (target.academic_year_id !== rows[0].academic_year_id) throw new Refused(422, "Choose a class of the same school year.", "classId");
    await client.query("update enrollments set class_id = $2 where enrollment_id = $1", [p.enrollmentId, p.classId]);
    const change: StudentClassChangedEventPayloadV1 = {
      enrollmentId: p.enrollmentId,
      studentId: rows[0].student_id,
      academicYearId: rows[0].academic_year_id,
      classId: p.classId,
      previousClassId: rows[0].class_id,
    };
    return { value: change, event: { type: "admissions.StudentClassChanged", aggregateId: p.enrollmentId, aggregateVersion, payload: change } };
  }, now);
}

export async function updateAcademicYear(pool: pg.Pool, command: Command<UpdateAcademicYearCommandPayloadV1>, now = new Date()) {
  const { academicYearId, expectedVersion, ...p } = command.payload;
  if (p.endsOn <= p.startsOn) throw new Refused(422, "The school year must end after it starts.", "endsOn");
  return runCommand<UpdateAcademicYearCommandPayloadV1, AcademicYearUpdatedEventPayloadV1>(pool, command, async (client) => {
    const aggregateVersion = await nextVersion(client, academicYearId, expectedVersion, "school year");
    await client.query("update academic_years set name = $2, starts_on = $3, ends_on = $4 where academic_year_id = $1", [academicYearId, p.name, p.startsOn, p.endsOn]);
    const year: AcademicYearUpdatedEventPayloadV1 = { academicYearId, ...p };
    return { value: year, event: { type: "admissions.AcademicYearUpdated", aggregateId: academicYearId, aggregateVersion, payload: year } };
  }, now);
}

export async function listAcademicYears(pool: pg.Pool) {
  const { rows } = await pool.query(
    `select y.academic_year_id, y.name, y.starts_on, y.ends_on, ${versionOf("y.academic_year_id")} as version,
       coalesce(json_agg(json_build_object('classId', c.class_id, 'version', ${versionOf("c.class_id")}, 'grade', c.grade,
         'students', (select count(*) from enrollments e where e.class_id = c.class_id))
         order by array_position($1::text[], c.grade)) filter (where c.class_id is not null), '[]') as classes
     from academic_years y
     left join classes c on c.academic_year_id = y.academic_year_id
     group by y.academic_year_id
     order by y.starts_on desc`,
    [GRADES],
  );
  return rows.map((r) => ({ academicYearId: r.academic_year_id, version: r.version, name: r.name, startsOn: r.starts_on, endsOn: r.ends_on, classes: r.classes }));
}
