import { CommandInputValidationError } from "@lando/sdk/errors";
import type {
  ExecutableCommandArgSpec,
  ExecutableCommandFlagSpec,
  ExecutableCommandInput,
} from "@lando/sdk/plugins";
import { Effect } from "effect";

/**
 * Structural subset of `ExecutableCommandSpec` this parser actually reads.
 * Both `ExecutableCommandSpec` (plugin/tooling) and `LandoCommandSpec`
 * (built-in) satisfy this shape, so callers holding an `EventCommandTarget`
 * union can pass `target.spec` without widening the built-in spec to the
 * SDK's Effect-returning `render`/`successExitCode` contract.
 */
export interface EventCommandInputSpec {
  readonly id: string;
  readonly flags?: Readonly<Record<string, ExecutableCommandFlagSpec>>;
  readonly args?: Readonly<Record<string, ExecutableCommandArgSpec>>;
  readonly strict?: boolean;
}

type InputKind = "flag" | "arg";
type InputDefinition = ExecutableCommandFlagSpec | ExecutableCommandArgSpec;

const failure = (
  target: string,
  kind: InputKind,
  field: string,
  reason: string,
  message: string,
  remediation: string,
  cause?: unknown,
): CommandInputValidationError =>
  new CommandInputValidationError({
    target,
    kind,
    field,
    reason,
    message,
    remediation,
    ...(cause === undefined ? {} : { cause }),
  });

const typeFailure = (
  target: string,
  kind: InputKind,
  field: string,
  expected: string,
): CommandInputValidationError => {
  const label = kind === "arg" ? "argument" : kind;
  return failure(
    target,
    kind,
    field,
    "type",
    `${label} ${field} for ${target} must be ${expected}.`,
    `Pass ${expected} for ${field}.`,
  );
};

const convertPrimitive = (
  target: string,
  kind: InputKind,
  field: string,
  value: unknown,
  definition: InputDefinition,
): Effect.Effect<string | number | boolean, CommandInputValidationError> => {
  if (definition.type === "boolean") {
    return typeof value === "boolean"
      ? Effect.succeed(value)
      : Effect.fail(typeFailure(target, kind, field, "true or false"));
  }

  if (definition.type === "number" || definition.valueType === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return Effect.fail(
        typeFailure(target, kind, field, definition.valueType === "integer" ? "an integer" : "a number"),
      );
    }
    if (definition.valueType === "integer" && !Number.isInteger(value)) {
      return Effect.fail(typeFailure(target, kind, field, "an integer"));
    }
    return Effect.succeed(value);
  }

  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(typeFailure(target, kind, field, "a string"));
};

const parseConfiguredValue = (
  target: string,
  kind: InputKind,
  field: string,
  value: string | number | boolean,
  definition: InputDefinition,
): Effect.Effect<unknown, CommandInputValidationError> => {
  if (!("parse" in definition) || definition.parse === undefined) return Effect.succeed(value);
  return Effect.tryPromise({
    try: async () => definition.parse?.(String(value)),
    catch: (cause) =>
      failure(
        target,
        kind,
        field,
        "parse",
        `${kind} ${field} for ${target} could not be parsed.`,
        `Pass a value accepted by ${field}.`,
        cause,
      ),
  });
};

const validateOptions = (
  target: string,
  kind: InputKind,
  field: string,
  value: unknown,
  definition: InputDefinition,
): Effect.Effect<unknown, CommandInputValidationError> =>
  definition.options === undefined || (typeof value === "string" && definition.options.includes(value))
    ? Effect.succeed(value)
    : Effect.fail(
        failure(
          target,
          kind,
          field,
          "option",
          `${kind} ${field} for ${target} must be one of: ${definition.options.join(", ")}.`,
          `Choose a declared value for ${field}.`,
        ),
      );

const parseOccurrence = (
  target: string,
  kind: InputKind,
  field: string,
  value: unknown,
  definition: InputDefinition,
): Effect.Effect<unknown, CommandInputValidationError> =>
  convertPrimitive(target, kind, field, value, definition).pipe(
    Effect.flatMap((converted) => parseConfiguredValue(target, kind, field, converted, definition)),
    Effect.flatMap((parsed) => validateOptions(target, kind, field, parsed, definition)),
  );

const parseValue = (
  target: string,
  kind: InputKind,
  field: string,
  value: unknown,
  definition: InputDefinition,
): Effect.Effect<unknown, CommandInputValidationError> => {
  if (definition.multiple !== true) {
    return Array.isArray(value)
      ? Effect.fail(typeFailure(target, kind, field, "a single value"))
      : parseOccurrence(target, kind, field, value, definition);
  }
  if (!Array.isArray(value)) {
    return Effect.fail(typeFailure(target, kind, field, "an array"));
  }
  return Effect.forEach(value, (occurrence) => parseOccurrence(target, kind, field, occurrence, definition), {
    concurrency: 1,
  });
};

const parseRecord = (
  target: string,
  kind: InputKind,
  values: Readonly<Record<string, unknown>>,
  definitions: Readonly<Record<string, InputDefinition>>,
): Effect.Effect<Readonly<Record<string, unknown>>, CommandInputValidationError> =>
  Effect.gen(function* () {
    const label = kind === "arg" ? "argument" : kind;
    for (const field of Object.keys(values)) {
      if (!Object.hasOwn(definitions, field)) {
        return yield* Effect.fail(
          failure(
            target,
            kind,
            field,
            "unknown",
            `Unknown ${label} ${field} for canonical command ${target}.`,
            `Remove ${field} or use a ${label} declared by ${target}.`,
          ),
        );
      }
    }

    const parsed: Record<string, unknown> = Object.create(null);
    for (const field of Object.keys(definitions)) {
      const definition = definitions[field];
      if (definition === undefined) continue;
      const supplied = Object.hasOwn(values, field);
      const value = supplied ? values[field] : definition.default;
      if (!supplied && value === undefined) {
        if (definition.required === true) {
          return yield* Effect.fail(
            failure(
              target,
              kind,
              field,
              "required",
              `Missing required ${label} ${field} for ${target}.`,
              `Provide ${field}.`,
            ),
          );
        }
        continue;
      }
      parsed[field] = yield* parseValue(target, kind, field, value, definition);
    }
    return parsed;
  });

export const validateEventCommandInput = (
  spec: EventCommandInputSpec,
  input: {
    readonly flags: Readonly<Record<string, unknown>>;
    readonly args: Readonly<Record<string, unknown>>;
    readonly raw: ReadonlyArray<string>;
  },
): Effect.Effect<ExecutableCommandInput, CommandInputValidationError> =>
  Effect.gen(function* () {
    const flags = yield* parseRecord(spec.id, "flag", input.flags, spec.flags ?? {});
    const args = yield* parseRecord(spec.id, "arg", input.args, spec.args ?? {});
    if (spec.strict !== false && input.raw.length > 0) {
      return yield* Effect.fail(
        failure(
          spec.id,
          "arg",
          "raw",
          "strict",
          `Canonical command ${spec.id} does not accept raw arguments.`,
          "Remove raw arguments.",
        ),
      );
    }
    const parsedArgv = [
      ...Object.values(args).flatMap((value) =>
        Array.isArray(value) ? value.map((occurrence) => String(occurrence)) : [String(value)],
      ),
      ...input.raw,
    ];
    return { argv: input.raw, parsedArgv, flags, args };
  });
