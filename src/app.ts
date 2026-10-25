import Fastify, { type FastifyServerOptions } from "fastify";
import type pg from "pg";
import { listStudents, registerStudent, type RegisterStudent } from "./students.ts";
import { errorsOf, validEnvelope, validRegisterStudent } from "./validate.ts";

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

  app.post("/commands/register-student", async (request, reply) => {
    const command = request.body as RegisterStudent;
    if (!validEnvelope(command)) return reply.code(400).send({ error: errorsOf(validEnvelope) });
    if (command.commandType !== "admissions.RegisterStudent" || command.version !== 1) {
      return reply.code(400).send({ error: "commandType must be admissions.RegisterStudent, version 1" });
    }
    if (!validRegisterStudent(command.payload)) return reply.code(400).send({ error: errorsOf(validRegisterStudent) });
    const { student, replayed } = await registerStudent(pool, command);
    request.log.info({ commandId: command.commandId, studentId: student.studentId, replayed }, "student registered");
    return reply.code(replayed ? 200 : 201).send(student);
  });

  app.get("/students", async () => listStudents(pool));

  return app;
}
