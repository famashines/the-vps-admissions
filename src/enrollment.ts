import { randomUUID } from "node:crypto";
import type {
  AcademicYearOpenedEventPayloadV1,
  ClassSectionCreatedEventPayloadV1,
  CreateClassSectionCommandPayloadV1,
  EnrollStudentCommandPayloadV1,
  OpenAcademicYearCommandPayloadV1,
  StudentEnrolledEventPayloadV1,
  AcademicYearUpdatedEventPayloadV1,
  ChangeStudentSectionCommandPayloadV1,
  ClassSectionUpdatedEventPayloadV1,
  StudentSectionChangedEventPayloadV1,
  UpdateAcademicYearCommandPayloadV1,
  UpdateClassSectionCommandPayloadV1,
} from "@famashines/the-vps-contracts";
import type pg from "pg";
import { nextVersion, Refused, runCommand, type Command } from "./command.ts";
import { versionOf } from "./students.ts";

export const GRADES = ["playgroup", "nursery", "prep", "class-1", "class-2", "class-3", "class-4", "class-5", "class-6", "class-7", "class-8", "class-9", "class-10"];

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

export async function createClassSection(pool: pg.Pool, command: Command<CreateClassSectionCommandPayloadV1>, now = new Date()) {
  const p = command.payload;
  return runCommand<CreateClassSectionCommandPayloadV1, ClassSectionCreatedEventPayloadV1>(pool, command, async (client) => {
    const section: ClassSectionCreatedEventPayloadV1 = { classSectionId: randomUUID(), academicYearId: p.academicYearId, grade: p.grade, section: p.section };
    await client.query(
      "insert into class_sections (class_section_id, academic_year_id, grade, section, created_at, created_by) values ($1, $2, $3, $4, $5, $6)",
      [section.classSectionId, p.academicYearId, p.grade, p.section, now, command.issuedBy],
    );
    return { value: section, event: { type: "admissions.ClassSectionCreated", aggregateId: section.classSectionId, aggregateVersion: 1, payload: section } };
  }, now);
}

export async function enrollStudent(pool: pg.Pool, command: Command<EnrollStudentCommandPayloadV1>, now = new Date()) {
  const p = command.payload;
  return runCommand<EnrollStudentCommandPayloadV1, StudentEnrolledEventPayloadV1>(pool, command, async (client) => {
    const { rows } = await client.query("select academic_year_id from class_sections where class_section_id = $1", [p.classSectionId]);
    if (!rows[0]) throw new Refused(404, "The section does not exist.");
    const enrollment: StudentEnrolledEventPayloadV1 = {
      enrollmentId: randomUUID(),
      studentId: p.studentId,
      classSectionId: p.classSectionId,
      academicYearId: rows[0].academic_year_id,
    };
    await client.query(
      "insert into enrollments (enrollment_id, student_id, class_section_id, academic_year_id, enrolled_at, enrolled_by) values ($1, $2, $3, $4, $5, $6)",
      [enrollment.enrollmentId, p.studentId, p.classSectionId, enrollment.academicYearId, now, command.issuedBy],
    );
    return { value: enrollment, event: { type: "admissions.StudentEnrolled", aggregateId: enrollment.enrollmentId, aggregateVersion: 1, payload: enrollment } };
  }, now);
}

export async function changeStudentSection(pool: pg.Pool, command: Command<ChangeStudentSectionCommandPayloadV1>, now = new Date()) {
  const p = command.payload;
  return runCommand<ChangeStudentSectionCommandPayloadV1, StudentSectionChangedEventPayloadV1>(pool, command, async (client) => {
    const aggregateVersion = await nextVersion(client, p.enrollmentId, p.expectedVersion, "enrollment");
    const target = (await client.query("select academic_year_id from class_sections where class_section_id = $1", [p.classSectionId])).rows[0];
    if (!target) throw new Refused(404, "The section does not exist.", "classSectionId");
    const { rows } = await client.query("select student_id, academic_year_id, class_section_id from enrollments where enrollment_id = $1", [p.enrollmentId]);
    if (target.academic_year_id !== rows[0].academic_year_id) throw new Refused(422, "Choose a section of the same school year.", "classSectionId");
    await client.query("update enrollments set class_section_id = $2 where enrollment_id = $1", [p.enrollmentId, p.classSectionId]);
    const change: StudentSectionChangedEventPayloadV1 = {
      enrollmentId: p.enrollmentId,
      studentId: rows[0].student_id,
      academicYearId: rows[0].academic_year_id,
      classSectionId: p.classSectionId,
      previousClassSectionId: rows[0].class_section_id,
    };
    return { value: change, event: { type: "admissions.StudentSectionChanged", aggregateId: p.enrollmentId, aggregateVersion, payload: change } };
  }, now);
}

export async function updateClassSection(pool: pg.Pool, command: Command<UpdateClassSectionCommandPayloadV1>, now = new Date()) {
  const p = command.payload;
  return runCommand<UpdateClassSectionCommandPayloadV1, ClassSectionUpdatedEventPayloadV1>(pool, command, async (client) => {
    const aggregateVersion = await nextVersion(client, p.classSectionId, p.expectedVersion, "section");
    const { rows } = await client.query(
      `select academic_year_id, grade, (select count(*)::int from enrollments where class_section_id = $1) as students
       from class_sections where class_section_id = $1`,
      [p.classSectionId],
    );
    if (rows[0].grade !== p.grade && rows[0].students > 0) {
      throw new Refused(409, "Move the students to another section before you change the grade.", "grade");
    }
    await client.query("update class_sections set grade = $2, section = $3 where class_section_id = $1", [p.classSectionId, p.grade, p.section]);
    const section: ClassSectionUpdatedEventPayloadV1 = { classSectionId: p.classSectionId, academicYearId: rows[0].academic_year_id, grade: p.grade, section: p.section };
    return { value: section, event: { type: "admissions.ClassSectionUpdated", aggregateId: p.classSectionId, aggregateVersion, payload: section } };
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
       coalesce(json_agg(json_build_object('classSectionId', c.class_section_id, 'version', ${versionOf("c.class_section_id")},
         'grade', c.grade, 'section', c.section,
         'students', (select count(*) from enrollments e where e.class_section_id = c.class_section_id))
         order by array_position($1::text[], c.grade), c.section) filter (where c.class_section_id is not null), '[]') as sections
     from academic_years y
     left join class_sections c on c.academic_year_id = y.academic_year_id
     group by y.academic_year_id
     order by y.starts_on desc`,
    [GRADES],
  );
  return rows.map((r) => ({ academicYearId: r.academic_year_id, version: r.version, name: r.name, startsOn: r.starts_on, endsOn: r.ends_on, sections: r.sections }));
}
