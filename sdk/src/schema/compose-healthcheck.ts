import { SchemaIssue } from "effect";
import { Effect, SchemaTransformation } from "effect";
import { Schema } from "effect";

import { parseComposeDuration } from "./compose-duration.ts";
import { CommandSpec } from "./primitives.ts";

const ComposeTest = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

// JSON Schema publishes the encoded side, so both sides carry the description.
const HEALTHCHECK_FIELD_DESCRIPTION =
  "Healthcheck accepts false, a non-empty command string, a non-empty argv array, or an object with Lando fields or Compose test, disable, and duration spellings.";

const ComposeHealthcheckAccepted = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["command", "http", "tcp", "none"])),
  command: Schema.optionalKey(CommandSpec),
  url: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  intervalSeconds: Schema.optionalKey(Schema.Number),
  timeoutSeconds: Schema.optionalKey(Schema.Number),
  retries: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  startPeriodSeconds: Schema.optionalKey(Schema.Number),
  startInterval: Schema.optionalKey(Schema.String),
  test: Schema.optionalKey(ComposeTest),
  disable: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  interval: Schema.optionalKey(Schema.String),
  timeout: Schema.optionalKey(Schema.String),
  start_period: Schema.optionalKey(Schema.String),
  start_interval: Schema.optionalKey(Schema.String),
}).annotate({ description: HEALTHCHECK_FIELD_DESCRIPTION });

const HealthcheckCanonicalBase = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["command", "http", "tcp"])),
  command: Schema.optionalKey(CommandSpec),
  url: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  intervalSeconds: Schema.optionalKey(Schema.Number),
  timeoutSeconds: Schema.optionalKey(Schema.Number),
  retries: Schema.optionalKey(Schema.Number),
  startPeriodSeconds: Schema.optionalKey(Schema.Number),
});

const HealthcheckCanonicalObject = HealthcheckCanonicalBase.pipe(
  Schema.fieldsAssign({
    startInterval: Schema.optionalKey(Schema.String).annotate({
      description: "Raw Compose start_interval duration preserved losslessly for runtime extensions.",
    }),
  }),
);
const ComposeHealthcheckCanonical = Schema.Union([Schema.Literal(false), HealthcheckCanonicalObject]);

type AcceptedHealthcheck = typeof ComposeHealthcheckAccepted.Type;
type NormalizedTest =
  | false
  | Readonly<{
      kind?: "command";
      command?: typeof CommandSpec.Type;
    }>;

const normalizeTest = (test: AcceptedHealthcheck["test"]): NormalizedTest => {
  if (test === undefined) return {};
  if (typeof test === "string") return { kind: "command", command: test };

  const marker = test[0];
  switch (marker) {
    case "NONE":
      if (test.length !== 1) {
        throw new SchemaIssue.InvalidValue(
          { message: 'Landofile service healthcheck.test marker "NONE" must be the only array entry.' },
          test,
        );
      }
      return false;
    case "CMD":
      if (test.length < 2) {
        throw new SchemaIssue.InvalidValue(
          { message: 'Landofile service healthcheck.test marker "CMD" requires at least one argv entry.' },
          test,
        );
      }
      return { kind: "command", command: test.slice(1) };
    case "CMD-SHELL": {
      const command = test[1];
      if (test.length !== 2 || command === undefined) {
        throw new SchemaIssue.InvalidValue(
          {
            message:
              'Landofile service healthcheck.test marker "CMD-SHELL" requires exactly one command string.',
          },
          test,
        );
      }
      return { kind: "command", command };
    }
    case undefined:
      throw new SchemaIssue.InvalidValue(
        {
          message:
            'Landofile service healthcheck.test must use a non-empty array beginning with "CMD", "CMD-SHELL", or "NONE".',
        },
        test,
      );
    default:
      throw new SchemaIssue.InvalidValue(
        {
          message:
            'Landofile service healthcheck.test marker is unsupported; expected "CMD", "CMD-SHELL", or "NONE".',
        },
        test,
      );
  }
};

const normalizeDisable = (disable: AcceptedHealthcheck["disable"]): boolean | undefined => {
  if (disable === undefined || typeof disable === "boolean") return disable;
  const normalized = disable.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new SchemaIssue.InvalidValue(
    { message: 'Landofile service healthcheck.disable must be a boolean or the string "true" or "false".' },
    disable,
  );
};

const normalizeRetries = (retries: AcceptedHealthcheck["retries"]): number | undefined => {
  if (retries === undefined) return undefined;
  const normalized = Number(retries);
  const formatIsValid = typeof retries === "number" || /^[0-9]+$/.test(retries);
  if (formatIsValid && Number.isSafeInteger(normalized) && normalized >= 0) return normalized;
  throw new SchemaIssue.InvalidValue(
    { message: "Landofile service healthcheck.retries must be a non-negative decimal integer." },
    retries,
  );
};

const decodeHealthcheck = (input: AcceptedHealthcheck): typeof ComposeHealthcheckCanonical.Type => {
  const landoWins =
    "kind" in input ||
    "command" in input ||
    "url" in input ||
    "port" in input ||
    "intervalSeconds" in input ||
    "timeoutSeconds" in input ||
    "startPeriodSeconds" in input;
  const disabled = input.kind === "none" || (!landoWins && normalizeDisable(input.disable) === true);
  if (disabled || (!landoWins && normalizeTest(input.test) === false)) {
    normalizeDisable(input.disable);
    normalizeTest(input.test);
    normalizeRetries(input.retries);
    for (const duration of [
      input.interval,
      input.timeout,
      input.start_period,
      input.start_interval,
      input.startInterval,
    ]) {
      if (duration !== undefined) parseComposeDuration(duration);
    }
    if (input.command !== undefined && input.command.length === 0) {
      throw new SchemaIssue.InvalidValue(
        { message: "Disabled healthcheck command must not be empty; omit command instead." },
        input.command,
      );
    }
    return false;
  }
  const test = landoWins ? {} : normalizeTest(input.test);
  if (test === false) return false;
  const retries = normalizeRetries(input.retries);
  const startInterval = input.startInterval ?? input.start_interval;
  const shared = {
    ...(retries === undefined ? {} : { retries }),
    ...(startInterval === undefined ? {} : { startInterval }),
  };

  if (landoWins) {
    const kind = input.kind ?? (input.command === undefined ? undefined : "command");
    return {
      ...(kind === undefined ? {} : { kind }),
      ...(input.command === undefined ? {} : { command: input.command }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.intervalSeconds === undefined ? {} : { intervalSeconds: input.intervalSeconds }),
      ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
      ...(input.startPeriodSeconds === undefined ? {} : { startPeriodSeconds: input.startPeriodSeconds }),
      ...shared,
    };
  }

  const intervalSeconds = input.interval === undefined ? undefined : parseComposeDuration(input.interval);
  const timeoutSeconds = input.timeout === undefined ? undefined : parseComposeDuration(input.timeout);
  const startPeriodSeconds =
    input.start_period === undefined ? undefined : parseComposeDuration(input.start_period);
  return {
    ...test,
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(startPeriodSeconds === undefined ? {} : { startPeriodSeconds }),
    ...shared,
  };
};

const encodeHealthcheck = (
  input: typeof HealthcheckCanonicalObject.Type,
): typeof ComposeHealthcheckAccepted.Type => ({
  ...(input.kind === undefined ? {} : { kind: input.kind }),
  ...(input.command === undefined ? {} : { command: input.command }),
  ...(input.url === undefined ? {} : { url: input.url }),
  ...(input.port === undefined ? {} : { port: input.port }),
  ...(input.intervalSeconds === undefined ? {} : { intervalSeconds: input.intervalSeconds }),
  ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
  ...(input.retries === undefined ? {} : { retries: input.retries }),
  ...(input.startPeriodSeconds === undefined ? {} : { startPeriodSeconds: input.startPeriodSeconds }),
  ...(input.startInterval === undefined ? {} : { start_interval: input.startInterval }),
});

const EMPTY_HEALTHCHECK_COMMAND =
  "Healthcheck command must not be empty; use healthcheck: false to disable the probe.";

const HealthcheckAccepted = Schema.Union([
  Schema.Literal(false),
  Schema.String.check(Schema.isMinLength(1, { message: EMPTY_HEALTHCHECK_COMMAND })),
  Schema.Array(Schema.String).check(Schema.isMinLength(1, { message: EMPTY_HEALTHCHECK_COMMAND })),
  ComposeHealthcheckAccepted,
]).annotate({
  description: HEALTHCHECK_FIELD_DESCRIPTION,
  expected: "false, a command string, an argv array, or a healthcheck object",
});

export const HealthcheckInput = HealthcheckAccepted.pipe(
  Schema.decodeTo(
    ComposeHealthcheckCanonical,
    SchemaTransformation.transformEffect({
      decode: (input): Effect.Effect<typeof ComposeHealthcheckCanonical.Type, SchemaIssue.Issue> => {
        if (input === false) return Effect.succeed(false);
        if (typeof input === "string" || "length" in input)
          return Effect.succeed({ kind: "command" as const, command: input });
        try {
          return Effect.succeed(decodeHealthcheck(input));
        } catch (error) {
          if (error instanceof SchemaIssue.InvalidValue) return Effect.fail(error);
          throw error;
        }
      },
      encode: (input) => Effect.succeed(input === false ? false : encodeHealthcheck(input)),
    }),
  ),
).annotate({ description: HEALTHCHECK_FIELD_DESCRIPTION });
export type HealthcheckInput = typeof HealthcheckInput.Type;
