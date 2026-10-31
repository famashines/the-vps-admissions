# the-vps-admissions

The admissions service of the-vps: it registers students. It is internal:
only the gateway (`the-vps-gateway`) calls it, inside the cluster.

Fastify on Node 24 (TypeScript, run directly), PostgreSQL through `pg`, the
contracts of `@famashines/the-vps-contracts`.

## Endpoints

| Method | Path                         | Does                                                        |
| ------ | ---------------------------- | ----------------------------------------------------------- |
| GET    | `/health`                    | Liveness: `{"status":"ok","release":"<commit>"}`             |
| GET    | `/ready`                     | Readiness: 200 when the database answers, else 503           |
| POST   | `/commands/register-student` | Body: `CommandEnvelopeV1` with `RegisterStudentCommandPayloadV1`. 201 with the student (`StudentRegisteredEventPayloadV1`), 200 when the same `commandId` came before, 400 when invalid, 422 when the student is not 2 to 25 years old on the registration day (Pakistan time) |
| POST   | `/commands/open-academic-year`   | `OpenAcademicYearCommandPayloadV1`: name like `2026-27`, start and end. 422 when the end is not after the start, 409 for a used name or an overlap |
| POST   | `/commands/open-class`           | `OpenClassCommandPayloadV1`: year and grade. One class for each grade in a year: 409 when the grade has a class, 404 for an unknown year |
| POST   | `/commands/close-class`          | `CloseClassCommandPayloadV1`: removes a class. 409 while the class has students |
| POST   | `/commands/enroll-student`       | `EnrollStudentCommandPayloadV1`: student and class. 409 when the student has a class in that year or has left the school, 404 for an unknown student or class |
| POST   | `/commands/update-student-details` | `UpdateStudentDetailsCommandPayloadV1`: all details except the admission number. 422 for the age rule (on the registration day) |
| POST   | `/commands/change-student-class`   | `ChangeStudentClassCommandPayloadV1`: a new class for an enrollment. 422 when the class is in another school year |
| POST   | `/commands/update-academic-year`   | `UpdateAcademicYearCommandPayloadV1`: name and dates. Same rules as open |
| POST   | `/commands/mark-student-left`      | `MarkStudentLeftCommandPayloadV1`: the leaving day and an optional reason. 422 when the day is in the future or before the registration day, 409 when the student has already left |
| POST   | `/commands/cancel-student-leaving` | `CancelStudentLeavingCommandPayloadV1`: the student is active again. 409 when the student has not left |
| GET    | `/students`                  | All students, newest first, each with `version`, `leftOn` and `leftReason` (null while active) and `enrollments` (newest year first, each with `enrollmentId` and `version`) |
| GET    | `/academic-years`            | All years, newest first, each with `version` and its `classes` (grade order, each with `version` and the number of students) |

## Register a student

One transaction does all of this:

1. If an event with this `commandId` exists, answer that student (no second student).
2. Take the next number of the year in Pakistan time: `2026-0001`, `2026-0002`, ...
3. Insert the row in `students` (the read side).
4. Insert `admissions.StudentRegistered` in `events` (append-only, `aggregateVersion` 1).

## Commands

Each command runs in `src/command.ts`: one transaction, a replay check on
the `commandId`, the domain rows, and one event (`StudentRegistered`,
`AcademicYearOpened`, `ClassOpened`, `StudentEnrolled`). A
database rule with a name (see `migrations/002_enrollment.sql`) becomes a
clear 404 or 409 message.

## Edits and versions

The version of a student, enrollment, class or school year is the
`aggregateVersion` of its last event. An edit command sends
`expectedVersion`. When it is not the current version, the answer is 409
("changed by someone else"), and nothing changes. The new event gets
`expectedVersion + 1`. Two edits at the same time with the same version: the
unique rule on (`aggregate_id`, `aggregate_version`) lets only one pass.

## Grades and classes

```
pre-primary  playgroup, kg-1, kg-2
primary      class-1 .. class-5
middle       class-6 .. class-8
secondary    class-9, class-10
```

A school year has at most one class for each grade, with no section.
Migration `005_classes.sql` merged the old sections of a grade into one
class: the oldest section stays, the students of the other sections get a
`StudentClassChanged` event each, and the other sections get a `ClassClosed`
event. The stream still has the events from before with the old names
(`ClassSectionCreated`, `StudentSectionChanged`, with `classSectionId`).

## Events to NATS

The `events` table is the outbox. Every second a relay takes the rows with no
`published_at`, publishes each one to JetStream on its type subject (for
example `admissions.StudentEnrolled`) as an `EventEnvelopeV1`
envelope with the header `Nats-Msg-Id` = `eventId`, and then sets
`published_at`. A crash between the publish and the mark sends the row again;
the stream drops the duplicate by its id. The stream `ADMISSIONS`
(`admissions.>`, file storage) is made at start when it is missing.

When NATS is down, the service still works and the events wait in the outbox.
Settings: `NATS_URL`, `NATS_USER`, `NATS_PASSWORD` (no `NATS_URL`: no relay).

## Telemetry

`npm start` loads `src/telemetry.ts` first (`node --import`). It is the same
file in the 3 services:

- Traces: OpenTelemetry, OTLP HTTP to Tempo. Spans for each request (with
  `http.route`) and for each SQL query in a request (pg, only under a parent
  span, so the relay that runs each second makes no traces). The probes and
  `/metrics` are not traced.
- A command stores the `traceparent` of its request with its event
  (`events.trace_parent`, migration `007_trace_parent.sql`). The relay publishes the event in a
  `publish <event type>` producer span under that trace, and sends the
  `traceparent` of that span as a NATS header. A consumer such as the fees
  saga continues the same trace.
- Metrics, a Prometheus exporter on port `9464` (`METRICS_PORT`):
  `http_server_request_duration` (seconds) by `http_route`, `commands_total` by
  `command_type` and `result` (done, replayed, refused, failed),
  `events_published_total` by `event_type`, and `outbox_unpublished_events`.
- Logs: each line has `trace_id` and `span_id` when a span is active.

Settings: `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_RESOURCE_ATTRIBUTES`, and `OTEL_SDK_DISABLED=true` to turn it off. The
tests do not load the telemetry. At shutdown, the spans of the last 5 seconds
can be lost.

## Database

`DATABASE_URL` comes from the CNPG secret `the-vps-db-app`. The SQL files in
`migrations/` run in name order at start, each one once (`schema_migrations`),
under an advisory lock.

## Work on it

    npm ci
    npm run check
    TEST_DATABASE_URL=postgres://... npm test   # each run uses a new schema and drops it

Without `TEST_DATABASE_URL` the tests are skipped. CI starts a PostgreSQL
container for them.
