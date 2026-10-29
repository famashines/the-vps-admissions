import {
  CancelStudentLeavingCommandPayloadV1Schema,
  ChangeStudentClassCommandPayloadV1Schema,
  CloseClassCommandPayloadV1Schema,
  CommandEnvelopeV1Schema,
  EnrollStudentCommandPayloadV1Schema,
  MarkStudentLeftCommandPayloadV1Schema,
  OpenAcademicYearCommandPayloadV1Schema,
  OpenClassCommandPayloadV1Schema,
  RegisterStudentCommandPayloadV1Schema,
  UpdateAcademicYearCommandPayloadV1Schema,
  UpdateStudentDetailsCommandPayloadV1Schema,
} from "@famashines/the-vps-contracts";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ allErrors: true });
addFormats.default(ajv);
const compile = (schema: object) => ajv.compile(structuredClone(schema));

export const validEnvelope = compile(CommandEnvelopeV1Schema);
export const payloadValidators = {
  "admissions.RegisterStudent": compile(RegisterStudentCommandPayloadV1Schema),
  "admissions.OpenAcademicYear": compile(OpenAcademicYearCommandPayloadV1Schema),
  "admissions.OpenClass": compile(OpenClassCommandPayloadV1Schema),
  "admissions.EnrollStudent": compile(EnrollStudentCommandPayloadV1Schema),
  "admissions.UpdateStudentDetails": compile(UpdateStudentDetailsCommandPayloadV1Schema),
  "admissions.ChangeStudentClass": compile(ChangeStudentClassCommandPayloadV1Schema),
  "admissions.CloseClass": compile(CloseClassCommandPayloadV1Schema),
  "admissions.UpdateAcademicYear": compile(UpdateAcademicYearCommandPayloadV1Schema),
  "admissions.MarkStudentLeft": compile(MarkStudentLeftCommandPayloadV1Schema),
  "admissions.CancelStudentLeaving": compile(CancelStudentLeavingCommandPayloadV1Schema),
};
export const errorsOf = (validate: { errors?: unknown }) => ajv.errorsText(validate.errors as never, { separator: "; " });
