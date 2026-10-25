import { randomUUID } from "node:crypto";
import type { CommandEnvelopeV1 } from "@famashines/the-vps-contracts";
import type pg from "pg";

export type Command<P> = CommandEnvelopeV1 & { payload: P };
export type Result<T> = { value: T; replayed: boolean };
export type NewEvent = { type: string; aggregateId: string; aggregateVersion: number; payload: object };

export class Refused extends Error {
  readonly status: 404 | 409 | 422;
  readonly field?: string;
  constructor(status: 404 | 409 | 422, message: string, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

const messages: Record<string, [404 | 409, string]> = {
  academic_years_name_unique: [409, "A school year with this name exists."],
  academic_years_no_overlap: [409, "This school year overlaps another school year."],
  class_sections_unique: [409, "This section exists in the school year."],
  class_sections_year_fk: [404, "The school year does not exist."],
  enrollments_one_per_year: [409, "The student is already enrolled in this school year."],
  enrollments_student_fk: [404, "The student does not exist."],
  enrollments_section_fk: [404, "The section does not exist."],
};

async function replay<T>(client: pg.PoolClient, commandId: string): Promise<Result<T> | undefined> {
  const { rows } = await client.query("select payload from events where causation_id = $1", [commandId]);
  return rows[0] ? { value: rows[0].payload, replayed: true } : undefined;
}

export async function runCommand<P, T extends object>(
  pool: pg.Pool,
  command: Command<P>,
  work: (client: pg.PoolClient) => Promise<{ value: T; event: NewEvent }>,
  now = new Date(),
): Promise<Result<T>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const earlier = await replay<T>(client, command.commandId);
    if (earlier) {
      await client.query("rollback");
      return earlier;
    }
    const { value, event } = await work(client);
    await client.query(
      `insert into events (event_id, event_type, version, aggregate_id, aggregate_version, occurred_at,
         correlation_id, causation_id, issued_by, payload)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)`,
      [randomUUID(), event.type, event.aggregateId, event.aggregateVersion, now, command.correlationId, command.commandId, command.issuedBy, event.payload],
    );
    await client.query("commit");
    return { value, replayed: false };
  } catch (error) {
    await client.query("rollback");
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === "23505" && constraint === "events_causation_id_key") {
      const earlier = await replay<T>(client, command.commandId);
      if (earlier) return earlier;
    }
    const known = constraint && messages[constraint];
    if (known) throw new Refused(known[0], known[1]);
    throw error;
  } finally {
    client.release();
  }
}
