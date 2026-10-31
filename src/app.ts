import Fastify, { type FastifyServerOptions } from "fastify";
import type pg from "pg";
import { Refused, type Command, type Result, zeroCommandCounts } from "./command.ts";
import { changeStudentClass, closeClass, enrollStudent, listAcademicYears, openAcademicYear, openClass, updateAcademicYear } from "./enrollment.ts";
import { cancelStudentLeaving, listStudents, markStudentLeft, registerStudent, updateStudentDetails } from "./students.ts";
import { errorsOf, payloadValidators, validEnvelope } from "./validate.ts";

type CommandType = keyof typeof payloadValidators;

export function buildApp(pool: pg.Pool, options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  const release = process.env.RELEASE ?? "local";

  app.get("/health", { logLevel: "warn" }, async () => ({ status: "ok", release }));

  app.get("/ready", { logLevel: "warn" }, async (_request, reply) => {
    try {
      await pool.query("select 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "database unavailable" });
    }
  });

  const handlers: Record<CommandType, (command: Command<never>) => Promise<Result<object>>> = {
    "admissions.RegisterStudent": async (c) => {
      const { student, replayed } = await registerStudent(pool, c);
      return { value: student, replayed };
    },
    "admissions.OpenAcademicYear": (c) => openAcademicYear(pool, c),
    "admissions.OpenClass": (c) => openClass(pool, c),
    "admissions.EnrollStudent": (c) => enrollStudent(pool, c),
    "admissions.UpdateStudentDetails": (c) => updateStudentDetails(pool, c),
    "admissions.ChangeStudentClass": (c) => changeStudentClass(pool, c),
    "admissions.CloseClass": (c) => closeClass(pool, c),
    "admissions.UpdateAcademicYear": (c) => updateAcademicYear(pool, c),
    "admissions.MarkStudentLeft": (c) => markStudentLeft(pool, c),
    "admissions.CancelStudentLeaving": (c) => cancelStudentLeaving(pool, c),
  };
  zeroCommandCounts(Object.keys(handlers));

  const route = (path: string, type: CommandType) =>
    app.post(path, async (request, reply) => {
      const command = request.body as Command<never>;
      if (!validEnvelope(command)) return reply.code(400).send({ error: errorsOf(validEnvelope) });
      if (command.commandType !== type || command.version !== 1) {
        return reply.code(400).send({ error: `commandType must be ${type}, version 1` });
      }
      const validPayload = payloadValidators[type];
      if (!validPayload(command.payload)) return reply.code(400).send({ error: errorsOf(validPayload) });
      try {
        const { value, replayed } = await handlers[type](command);
        request.log.info({ commandType: type, commandId: command.commandId, replayed }, "command done");
        return reply.code(replayed ? 200 : 201).send(value);
      } catch (error) {
        if (error instanceof Refused) {
          const fields = error.field ? [{ field: error.field, message: error.message }] : undefined;
          return reply.code(error.status).send({ error: error.message, fields });
        }
        throw error;
      }
    });

  route("/commands/register-student", "admissions.RegisterStudent");
  route("/commands/open-academic-year", "admissions.OpenAcademicYear");
  route("/commands/open-class", "admissions.OpenClass");
  route("/commands/enroll-student", "admissions.EnrollStudent");
  route("/commands/update-student-details", "admissions.UpdateStudentDetails");
  route("/commands/change-student-class", "admissions.ChangeStudentClass");
  route("/commands/close-class", "admissions.CloseClass");
  route("/commands/update-academic-year", "admissions.UpdateAcademicYear");
  route("/commands/mark-student-left", "admissions.MarkStudentLeft");
  route("/commands/cancel-student-leaving", "admissions.CancelStudentLeaving");

  app.get("/students", async () => listStudents(pool));
  app.get("/academic-years", async () => listAcademicYears(pool));

  return app;
}
