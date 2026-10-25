import { randomUUID } from "node:crypto";
import type { RegisterStudentCommandPayloadV1, StudentRegisteredEventPayloadV1 } from "@famashines/the-vps-contracts";
import type pg from "pg";
import { Refused, runCommand, type Command } from "./command.ts";

export type RegisterStudent = Command<RegisterStudentCommandPayloadV1>;

const schoolYear = (date: Date) => Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Karachi", year: "numeric" }).format(date));
const todayInPakistan = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(date);

export const MIN_AGE = 2;
export const MAX_AGE = 25;

export function ageOn(dateOfBirth: string, today: string) {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

export async function registerStudent(pool: pg.Pool, command: RegisterStudent, now = new Date()) {
  const age = ageOn(command.payload.dateOfBirth, todayInPakistan(now));
  if (age < MIN_AGE || age > MAX_AGE) {
    throw new Refused(422, `The student must be ${MIN_AGE} to ${MAX_AGE} years old on the registration day.`, "dateOfBirth");
  }
  const result = await runCommand<RegisterStudentCommandPayloadV1, StudentRegisteredEventPayloadV1>(
    pool,
    command,
    async (client) => {
      const year = schoolYear(now);
      const { rows } = await client.query(
        `insert into admission_counters (year, last) values ($1, 1)
         on conflict (year) do update set last = admission_counters.last + 1
         returning last`,
        [year],
      );
      const p = command.payload;
      const student: StudentRegisteredEventPayloadV1 = {
        studentId: randomUUID(),
        admissionNumber: `${year}-${String(rows[0].last).padStart(4, "0")}`,
        firstName: p.firstName,
        lastName: p.lastName,
        fatherName: p.fatherName,
        dateOfBirth: p.dateOfBirth,
        gender: p.gender,
        guardian: p.guardian,
      };
      await client.query(
        `insert into students (student_id, admission_number, first_name, last_name, father_name, date_of_birth, gender,
           guardian_name, guardian_relation, guardian_phone, registered_at, registered_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [student.studentId, student.admissionNumber, p.firstName, p.lastName, p.fatherName, p.dateOfBirth, p.gender,
          p.guardian.name, p.guardian.relation, p.guardian.phone, now, command.issuedBy],
      );
      return { value: student, event: { type: "admissions.StudentRegistered", aggregateId: student.studentId, aggregateVersion: 1, payload: student } };
    },
    now,
  );
  return { student: result.value, replayed: result.replayed };
}

export async function listStudents(pool: pg.Pool) {
  const { rows } = await pool.query(
    `select s.student_id, s.admission_number, s.first_name, s.last_name, s.father_name, s.date_of_birth, s.gender,
       s.guardian_name, s.guardian_relation, s.guardian_phone,
       coalesce(json_agg(json_build_object(
         'academicYearId', y.academic_year_id, 'academicYearName', y.name,
         'classSectionId', c.class_section_id, 'grade', c.grade, 'section', c.section)
         order by y.starts_on desc) filter (where e.enrollment_id is not null), '[]') as enrollments
     from students s
     left join enrollments e on e.student_id = s.student_id
     left join class_sections c on c.class_section_id = e.class_section_id
     left join academic_years y on y.academic_year_id = e.academic_year_id
     group by s.student_id
     order by s.registered_at desc, s.admission_number desc`,
  );
  return rows.map((r) => ({
    studentId: r.student_id,
    admissionNumber: r.admission_number,
    firstName: r.first_name,
    lastName: r.last_name,
    fatherName: r.father_name,
    dateOfBirth: r.date_of_birth,
    gender: r.gender,
    guardian: { name: r.guardian_name, relation: r.guardian_relation, phone: r.guardian_phone },
    enrollments: r.enrollments,
  }));
}
