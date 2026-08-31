import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import protocolMessageSchema from "./protocol-message.schema.json" with { type: "json" };
import type { ProtocolMessage } from "./types.js";

const ajv = new Ajv({
  allErrors: true,
  strict: true,
});

const protocolMessageValidator = ajv.compile<ProtocolMessage>(
  protocolMessageSchema,
);

export class ProtocolValidationError extends Error {
  readonly validationErrors: readonly ErrorObject[];

  constructor(validationErrors: readonly ErrorObject[]) {
    super(`Invalid protocol message: ${ajv.errorsText([...validationErrors])}`);
    this.name = "ProtocolValidationError";
    this.validationErrors = validationErrors;
  }
}

export function validateProtocolMessage(
  candidate: unknown,
): candidate is ProtocolMessage {
  return protocolMessageValidator(candidate);
}

export function getProtocolValidationErrors(): readonly ErrorObject[] {
  return protocolMessageValidator.errors ?? [];
}

export function assertProtocolMessage(
  candidate: unknown,
): asserts candidate is ProtocolMessage {
  if (!validateProtocolMessage(candidate)) {
    throw new ProtocolValidationError(getProtocolValidationErrors());
  }
}

export const compiledProtocolMessageSchema: ValidateFunction<ProtocolMessage> =
  protocolMessageValidator;
