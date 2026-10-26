import {
  type CommandResultOutcome,
  type ProjectedFailure,
  buildCommandResultEnvelope,
  identityRedactor,
  taggedErrorJson,
} from "@lando/sdk/command-result";
import { McpTransportError } from "@lando/sdk/errors";
import { FailureRole } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { BoundedDataInspector, inspectionFailure } from "./bounded-data-inspector";
import { isRuntimeProxy } from "./runtime-proxy";
import { stdioTransportError } from "./stdio-limits";

export const MAX_ADDITIONAL_FAILURE_COUNT = 128;

export interface McpProgressData {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
}

export const projectMcpProgressFrame = (value: unknown): McpProgressData => {
  const context = "MCP progress payload";
  if (value === null || typeof value !== "object" || isRuntimeProxy(value)) throw inspectionFailure(context);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw inspectionFailure(context);
  if (Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined) throw inspectionFailure(context);
  const tag = Object.getOwnPropertyDescriptor(value, "_tag")?.value;
  const chunk = Object.getOwnPropertyDescriptor(value, "chunk")?.value;
  const serviceDescriptor = Object.getOwnPropertyDescriptor(value, "service");
  const sourceDescriptor = Object.getOwnPropertyDescriptor(value, "source");
  if ((tag !== "stdout" && tag !== "stderr") || typeof chunk !== "string") throw inspectionFailure(context);
  if (serviceDescriptor !== undefined && typeof serviceDescriptor.value !== "string")
    throw inspectionFailure(context);
  if (sourceDescriptor !== undefined && typeof sourceDescriptor.value !== "string")
    throw inspectionFailure(context);
  return {
    _tag: tag,
    chunk,
    ...(serviceDescriptor === undefined ? {} : { service: serviceDescriptor.value }),
    ...(sourceDescriptor === undefined ? {} : { source: sourceDescriptor.value }),
  };
};

const ownString = (value: object, key: string): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw inspectionFailure("MCP command failure");
  return typeof descriptor.value === "string" && descriptor.value.length > 0 ? descriptor.value : undefined;
};

const projectFailure = (error: unknown): object => {
  if (error !== null && typeof error === "object" && isRuntimeProxy(error))
    throw inspectionFailure("MCP command failure");
  if (error !== null && typeof error === "object") {
    for (const field of ["_tag", "message", "remediation", "reason"]) ownString(error, field);
  }
  return taggedErrorJson(error);
};

const inspectAdditionalFailures = (
  errors: ProjectedFailure["additionalErrors"],
): ProjectedFailure["additionalErrors"] => {
  const context = "MCP command failure";
  if (isRuntimeProxy(errors)) throw inspectionFailure(context);
  if (Object.getPrototypeOf(errors) !== Array.prototype || Object.hasOwn(errors, "toJSON"))
    throw inspectionFailure(context);
  if (errors.length > MAX_ADDITIONAL_FAILURE_COUNT)
    throw stdioTransportError(
      `MCP command failure exceeded the ${MAX_ADDITIONAL_FAILURE_COUNT} additional failure count limit.`,
    );
  const additionalErrors: Array<{ readonly role: FailureRole; readonly error: unknown }> = [];
  for (let index = 0; index < errors.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(errors, String(index));
    if (descriptor === undefined || !("value" in descriptor)) throw inspectionFailure(context);
    const entry: unknown = descriptor.value;
    if (entry === null || typeof entry !== "object" || isRuntimeProxy(entry))
      throw inspectionFailure(context);
    const role = ownString(entry, "role");
    const error = Object.getOwnPropertyDescriptor(entry, "error");
    if (!Schema.is(FailureRole)(role) || error === undefined || !("value" in error))
      throw inspectionFailure(context);
    additionalErrors.push({ role, error: projectFailure(error.value) });
  }
  return additionalErrors;
};

export const inspectMcpCommandOutcome = (
  outcome: CommandResultOutcome,
): Effect.Effect<CommandResultOutcome, McpTransportError> =>
  Effect.try({
    try: (): CommandResultOutcome => {
      if (outcome._tag === "success")
        return {
          _tag: "success",
          value: new BoundedDataInspector("MCP command result").inspect(outcome.value),
        };
      const inspected = {
        _tag: "failure",
        error: projectFailure(outcome.error),
        additionalErrors: inspectAdditionalFailures(outcome.additionalErrors),
        ...(Object.hasOwn(outcome, "value")
          ? { value: new BoundedDataInspector("MCP command result").inspect(outcome.value) }
          : {}),
      } as const;
      const envelope = Effect.runSync(
        buildCommandResultEnvelope({
          command: "mcp:inspect",
          resultSchema: Schema.Unknown,
          outcome: inspected,
          redactor: identityRedactor,
        }),
      );
      new BoundedDataInspector("MCP command failure").inspect(envelope.error);
      return inspected;
    },
    catch: (cause) => (cause instanceof McpTransportError ? cause : inspectionFailure("MCP command result")),
  });
