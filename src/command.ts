import { randomUUID } from "node:crypto";
import type { CommandEnvelopeV1 } from "@famashines/the-vps-contracts";
import { context, metrics, propagation } from "@opentelemetry/api";
import type pg from "pg";

export type Command<P> = CommandEnvelopeV1 & { payload: P };
export type Result<T> = { value: T; replayed: boolean };
export type NewEvent = { type: string; aggregateId: string; aggregateVersion: number; payload: object };

const commands = metrics.getMeter("the-vps-admissions").createCounter("commands", { description: "Commands by type and result" });

export function zeroCommandCounts(types: string[]) {
  for (const command_type of types) for (const result of ["done", "replayed", "refused", "failed"]) commands.add(0, { command_type, result });
}

export function traceParent() {
  const carrier: { traceparent?: string } = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

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
  classes_one_per_grade: [409, "This grade has a class in the school year."],
  classes_year_fk: [404, "The school year does not exist."],
  enrollments_one_per_year: [409, "The student is already enrolled in this school year."],
  enrollments_student_fk: [404, "The student does not exist."],
  enrollments_class_fk: [404, "The class does not exist."],
  students_b_form_number_unique: [409, "A student with this B-Form number is already registered."],
  events_aggregate_id_aggregate_version_key: [409, "Someone else changed this at the same time. Reload to see the changes."],
};

export async function nextVersion(client: pg.PoolClient, aggregateId: string, expectedVersion: number, what: string) {
  const { rows } = await client.query("select max(aggregate_version) as version from events where aggregate_id = $1", [aggregateId]);
  if (rows[0].version === null) throw new Refused(404, `The ${what} does not exist.`);
  if (rows[0].version !== expectedVersion) throw new Refused(409, `This ${what} was changed by someone else. Reload to see the changes.`);
  return expectedVersion + 1;
}

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
  const count = (result: "done" | "replayed" | "refused" | "failed") => commands.add(1, { command_type: command.commandType, result });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const earlier = await replay<T>(client, command.commandId);
    if (earlier) {
      await client.query("rollback");
      count("replayed");
      return earlier;
    }
    const { value, event } = await work(client);
    await client.query(
      `insert into events (event_id, event_type, version, aggregate_id, aggregate_version, occurred_at,
         correlation_id, causation_id, issued_by, payload, trace_parent)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [randomUUID(), event.type, event.aggregateId, event.aggregateVersion, now, command.correlationId, command.commandId, command.issuedBy, event.payload, traceParent()],
    );
    await client.query("commit");
    count("done");
    return { value, replayed: false };
  } catch (error) {
    await client.query("rollback");
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === "23505" && constraint === "events_causation_id_key") {
      const earlier = await replay<T>(client, command.commandId);
      if (earlier) {
        count("replayed");
        return earlier;
      }
    }
    const known = constraint && messages[constraint];
    count(known || error instanceof Refused ? "refused" : "failed");
    if (known) throw new Refused(known[0], known[1]);
    throw error;
  } finally {
    client.release();
  }
}
