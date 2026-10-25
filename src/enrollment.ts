import { randomUUID } from "node:crypto";
import type {
  AcademicYearOpenedEventPayloadV1,
  ClassSectionCreatedEventPayloadV1,
  CreateClassSectionCommandPayloadV1,
  EnrollStudentCommandPayloadV1,
  OpenAcademicYearCommandPayloadV1,
  StudentEnrolledEventPayloadV1,
} from "@famashines/the-vps-contracts";
import type pg from "pg";
import { Refused, runCommand, type Command } from "./command.ts";

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

export async function listAcademicYears(pool: pg.Pool) {
  const { rows } = await pool.query(
    `select y.academic_year_id, y.name, y.starts_on, y.ends_on,
       coalesce(json_agg(json_build_object('classSectionId', c.class_section_id, 'grade', c.grade, 'section', c.section,
         'students', (select count(*) from enrollments e where e.class_section_id = c.class_section_id))
         order by array_position($1::text[], c.grade), c.section) filter (where c.class_section_id is not null), '[]') as sections
     from academic_years y
     left join class_sections c on c.academic_year_id = y.academic_year_id
     group by y.academic_year_id
     order by y.starts_on desc`,
    [GRADES],
  );
  return rows.map((r) => ({ academicYearId: r.academic_year_id, name: r.name, startsOn: r.starts_on, endsOn: r.ends_on, sections: r.sections }));
}
