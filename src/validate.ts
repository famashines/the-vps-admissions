import {
  CommandEnvelopeV1Schema,
  CreateClassSectionCommandPayloadV1Schema,
  EnrollStudentCommandPayloadV1Schema,
  OpenAcademicYearCommandPayloadV1Schema,
  RegisterStudentCommandPayloadV1Schema,
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
  "admissions.CreateClassSection": compile(CreateClassSectionCommandPayloadV1Schema),
  "admissions.EnrollStudent": compile(EnrollStudentCommandPayloadV1Schema),
};
export const errorsOf = (validate: { errors?: unknown }) => ajv.errorsText(validate.errors as never, { separator: "; " });
