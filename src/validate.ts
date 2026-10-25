import { CommandEnvelopeV1Schema, RegisterStudentCommandPayloadV1Schema } from "@famashines/the-vps-contracts";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ allErrors: true });
addFormats.default(ajv);

export const validEnvelope = ajv.compile(structuredClone(CommandEnvelopeV1Schema) as object);
export const validRegisterStudent = ajv.compile(structuredClone(RegisterStudentCommandPayloadV1Schema) as object);
export const errorsOf = (validate: { errors?: unknown }) => ajv.errorsText(validate.errors as never, { separator: "; " });
