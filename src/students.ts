import { randomUUID } from "node:crypto";
import type { CommandEnvelopeV1, RegisterStudentCommandPayloadV1, StudentRegisteredEventPayloadV1 } from "@famashines/the-vps-contracts";
import type pg from "pg";

export type RegisterStudent = CommandEnvelopeV1 & { payload: RegisterStudentCommandPayloadV1 };
export type Registered = { student: StudentRegisteredEventPayloadV1; replayed: boolean };

const schoolYear = (date: Date) => Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Karachi", year: "numeric" }).format(date));

async function replay(client: pg.PoolClient, commandId: string): Promise<Registered | undefined> {
  const { rows } = await client.query("select payload from events where causation_id = $1", [commandId]);
  return rows[0] ? { student: rows[0].payload, replayed: true } : undefined;
}

export async function registerStudent(pool: pg.Pool, command: RegisterStudent, now = new Date()): Promise<Registered> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const earlier = await replay(client, command.commandId);
    if (earlier) {
      await client.query("rollback");
      return earlier;
    }

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
      dateOfBirth: p.dateOfBirth,
      gender: p.gender,
      guardian: p.guardian,
    };

    await client.query(
      `insert into students (student_id, admission_number, first_name, last_name, date_of_birth, gender,
         guardian_name, guardian_relation, guardian_phone, registered_at, registered_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [student.studentId, student.admissionNumber, p.firstName, p.lastName, p.dateOfBirth, p.gender,
        p.guardian.name, p.guardian.relation, p.guardian.phone, now, command.issuedBy],
    );
    await client.query(
      `insert into events (event_id, event_type, version, aggregate_id, aggregate_version, occurred_at,
         correlation_id, causation_id, issued_by, payload)
       values ($1, 'admissions.StudentRegistered', 1, $2, 1, $3, $4, $5, $6, $7)`,
      [randomUUID(), student.studentId, now, command.correlationId, command.commandId, command.issuedBy, student],
    );
    await client.query("commit");
    return { student, replayed: false };
  } catch (error) {
    await client.query("rollback");
    if ((error as { code?: string }).code === "23505") {
      const earlier = await replay(client, command.commandId);
      if (earlier) return earlier;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listStudents(pool: pg.Pool): Promise<StudentRegisteredEventPayloadV1[]> {
  const { rows } = await pool.query(
    `select student_id, admission_number, first_name, last_name, date_of_birth, gender,
       guardian_name, guardian_relation, guardian_phone
     from students order by registered_at desc, admission_number desc`,
  );
  return rows.map((r) => ({
    studentId: r.student_id,
    admissionNumber: r.admission_number,
    firstName: r.first_name,
    lastName: r.last_name,
    dateOfBirth: r.date_of_birth,
    gender: r.gender,
    guardian: { name: r.guardian_name, relation: r.guardian_relation, phone: r.guardian_phone },
  }));
}
