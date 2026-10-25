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
| POST   | `/commands/create-class-section` | `CreateClassSectionCommandPayloadV1`: year, grade, section. 409 when the section exists in the year, 404 for an unknown year |
| POST   | `/commands/enroll-student`       | `EnrollStudentCommandPayloadV1`: student and section. 409 when the student has a section in that year, 404 for an unknown student or section |
| POST   | `/commands/update-student-details` | `UpdateStudentDetailsCommandPayloadV1`: all details except the admission number. 422 for the age rule (on the registration day) |
| POST   | `/commands/change-student-section` | `ChangeStudentSectionCommandPayloadV1`: a new section for an enrollment. 422 when the section is in another school year |
| POST   | `/commands/update-class-section`   | `UpdateClassSectionCommandPayloadV1`: grade and name. 409 for a grade change while the section has students, or a name that exists |
| POST   | `/commands/update-academic-year`   | `UpdateAcademicYearCommandPayloadV1`: name and dates. Same rules as open |
| GET    | `/students`                  | All students, newest first, each with `version` and `enrollments` (newest year first, each with `enrollmentId` and `version`) |
| GET    | `/academic-years`            | All years, newest first, each with `version` and its `sections` (grade order, each with `version` and the number of students) |

## Register a student

One transaction does all of this:

1. If an event with this `commandId` exists, answer that student (no second student).
2. Take the next number of the year in Pakistan time: `2026-0001`, `2026-0002`, ...
3. Insert the row in `students` (the read side).
4. Insert `admissions.StudentRegistered` in `events` (append-only, `aggregateVersion` 1).

## Commands

Each command runs in `src/command.ts`: one transaction, a replay check on
the `commandId`, the domain rows, and one event (`StudentRegistered`,
`AcademicYearOpened`, `ClassSectionCreated`, `StudentEnrolled`). A
database rule with a name (see `migrations/002_enrollment.sql`) becomes a
clear 404 or 409 message.

## Edits and versions

The version of a student, enrollment, section or school year is the
`aggregateVersion` of its last event. An edit command sends
`expectedVersion`. When it is not the current version, the answer is 409
("changed by someone else"), and nothing changes. The new event gets
`expectedVersion + 1`. Two edits at the same time with the same version: the
unique rule on (`aggregate_id`, `aggregate_version`) lets only one pass.

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
