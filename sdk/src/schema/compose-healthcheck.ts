import { SchemaIssue } from "effect";
import { Effect, SchemaTransformation } from "effect";
import { Schema } from "effect";

import { parseComposeDuration } from "./compose-duration.ts";
import { CommandSpec, ContainerUser } from "./primitives.ts";
import { ProbeIntervalSeconds, ProbeRetries, ProbeTimeoutSeconds } from "./probe-timing.ts";

const ComposeTest = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

// JSON Schema publishes the encoded side, so both sides carry the description.
const HEALTHCHECK_FIELD_DESCRIPTION =
  "Probe accepts false, a non-empty command string, a non-empty argv array, or an object with command, execution target, identity, and timing settings.";

const IntervalSeconds = ProbeIntervalSeconds;
const TimeoutSeconds = ProbeTimeoutSeconds;

const ComposeHealthcheckAccepted = Schema.Struct({
  target: Schema.optionalKey(Schema.Literals(["service", "host"])).annotate({
    description: "Execution location; omitted means service. Host means the CLI machine.",
  }),
  user: Schema.optionalKey(ContainerUser).annotate({
    description: "Container identity for a service probe; not supported for host probes.",
  }),
  kind: Schema.optionalKey(Schema.Literals(["command", "http", "tcp", "none"])),
  command: Schema.optionalKey(CommandSpec),
  url: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  intervalSeconds: Schema.optionalKey(IntervalSeconds),
  timeoutSeconds: Schema.optionalKey(TimeoutSeconds),
  retries: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  startPeriodSeconds: Schema.optionalKey(IntervalSeconds),
  startInterval: Schema.optionalKey(Schema.String),
  test: Schema.optionalKey(ComposeTest),
  disable: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  interval: Schema.optionalKey(Schema.String),
  timeout: Schema.optionalKey(Schema.String),
  start_period: Schema.optionalKey(Schema.String),
  start_interval: Schema.optionalKey(Schema.String),
}).annotate({ description: HEALTHCHECK_FIELD_DESCRIPTION });

const HealthcheckCanonicalBase = Schema.Struct({
  target: Schema.optionalKey(Schema.Literals(["service", "host"])),
  user: Schema.optionalKey(ContainerUser),
  kind: Schema.optionalKey(Schema.Literals(["command", "http", "tcp", "none"])),
  command: Schema.optionalKey(CommandSpec),
  url: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  intervalSeconds: Schema.optionalKey(IntervalSeconds),
  timeoutSeconds: Schema.optionalKey(TimeoutSeconds),
  retries: Schema.optionalKey(ProbeRetries),
  startPeriodSeconds: Schema.optionalKey(IntervalSeconds),
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
  const test = landoWins && !disabled ? {} : normalizeTest(input.test);
  if (disabled) {
    normalizeDisable(input.disable);
    for (const duration of [input.interval, input.timeout, input.start_period, input.start_interval]) {
      if (duration === undefined) continue;
      const seconds = parseComposeDuration(duration);
      if (duration === input.timeout && seconds <= 0)
        throw new SchemaIssue.InvalidValue({ message: "Probe timeout must be greater than zero." }, duration);
    }
  }
  const command = input.command ?? (test === false ? undefined : test.command);
  if (command !== undefined) validateCommand(command);
  const retries = normalizeRetries(input.retries);
  const startInterval = input.startInterval ?? input.start_interval;
  if (startInterval !== undefined) parseComposeDuration(startInterval);
  const intervalSeconds = landoWins
    ? input.intervalSeconds
    : input.interval === undefined
      ? undefined
      : parseComposeDuration(input.interval);
  const timeoutSeconds = landoWins
    ? input.timeoutSeconds
    : input.timeout === undefined
      ? undefined
      : parseComposeDuration(input.timeout);
  const startPeriodSeconds = landoWins
    ? input.startPeriodSeconds
    : input.start_period === undefined
      ? undefined
      : parseComposeDuration(input.start_period);
  if (timeoutSeconds !== undefined && timeoutSeconds <= 0)
    throw new SchemaIssue.InvalidValue(
      { message: "Probe timeout must be greater than zero." },
      timeoutSeconds,
    );
  const shared = {
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.user === undefined ? {} : { user: input.user }),
    ...(retries === undefined ? {} : { retries }),
    ...(startInterval === undefined ? {} : { startInterval }),
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(startPeriodSeconds === undefined ? {} : { startPeriodSeconds }),
  };
  if (disabled || test === false) {
    return Object.keys(shared).length === 0 ? false : { kind: "none", ...shared };
  }

  if (landoWins) {
    const kind = input.kind ?? (input.command === undefined ? undefined : "command");
    return {
      ...(kind === undefined ? {} : { kind }),
      ...(input.command === undefined ? {} : { command: input.command }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.port === undefined ? {} : { port: input.port }),
      ...shared,
    };
  }

  return {
    ...test,
    ...shared,
  };
};

const encodeHealthcheck = (
  input: typeof HealthcheckCanonicalObject.Type,
): typeof ComposeHealthcheckAccepted.Type => ({
  ...(input.target === undefined ? {} : { target: input.target }),
  ...(input.user === undefined ? {} : { user: input.user }),
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

const validateCommand = (command: typeof CommandSpec.Type) => {
  if ((typeof command === "string" ? command : (command[0] ?? "")).trim().length === 0)
    throw new SchemaIssue.InvalidValue({ message: EMPTY_HEALTHCHECK_COMMAND }, command);
};

const HealthcheckAccepted = Schema.Union([
  Schema.Literal(false),
  Schema.String.check(Schema.isMinLength(1, { message: EMPTY_HEALTHCHECK_COMMAND })),
  Schema.Array(Schema.String).check(Schema.isMinLength(1, { message: EMPTY_HEALTHCHECK_COMMAND })),
  ComposeHealthcheckAccepted,
]).annotate({
  identifier: "HealthcheckInput",
  description: HEALTHCHECK_FIELD_DESCRIPTION,
  expected: "false, a command string, an argv array, or a healthcheck object",
  message: "Expected false, a command string, an argv array, or a healthcheck object",
});

export const HealthcheckInput = HealthcheckAccepted.pipe(
  Schema.decodeTo(
    ComposeHealthcheckCanonical,
    SchemaTransformation.transformEffect({
      decode: (input): Effect.Effect<typeof ComposeHealthcheckCanonical.Type, SchemaIssue.Issue> => {
        if (input === false) return Effect.succeed(false);
        try {
          if (typeof input === "string" || "length" in input) {
            validateCommand(input);
            return Effect.succeed({ kind: "command" as const, command: input });
          }
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
