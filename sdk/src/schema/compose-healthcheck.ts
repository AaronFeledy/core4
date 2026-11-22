import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";

import { parseComposeDuration } from "./compose-duration.ts";
import { executionSite } from "./execution-site.ts";
import { CommandSpec, ContainerUser, PortNumber } from "./primitives.ts";
import { ProbeIntervalSeconds, ProbeRetries, ProbeTimeoutSeconds } from "./probe-timing.ts";
import { ServiceProbeHttpUrl } from "./service-probe-url.ts";

const ComposeTest = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

// JSON Schema publishes the encoded side, so both sides carry the description.
const HEALTHCHECK_FIELD_DESCRIPTION =
  "Probe accepts false, a non-empty command string or argv array, or a command, HTTP, or TCP probe object with timing settings.";
// annotateKey keeps descriptions on transform/authoring encoded sides where plain annotate drops.
const ProbeUrl = Schema.optionalKey(ServiceProbeHttpUrl).annotateKey({
  description:
    "Required for kind: http. Absolute HTTP or HTTPS URL requested from inside the service container.",
});
const ProbePort = Schema.optionalKey(PortNumber).annotateKey({
  description:
    "TCP listener port (integer 1 to 65535), required for kind: tcp unless a service type supplies a listener target. Lando connects using the service network name.",
});

const IntervalSeconds = ProbeIntervalSeconds;
const TimeoutSeconds = ProbeTimeoutSeconds;

const ComposeHealthcheckAccepted = Schema.Struct({
  target: Schema.optionalKey(Schema.Literals(["service", "host"])).annotateKey({
    description: "Execution location; omitted means service. Host means the CLI machine.",
  }),
  user: Schema.optionalKey(ContainerUser).annotateKey({
    description: "Container identity for a service probe; not supported for host probes.",
  }),
  kind: Schema.optionalKey(Schema.Literals(["command", "http", "tcp", "none"])).annotateKey({
    description:
      "Probe kind: command, http, tcp, or none. Omitted with command implies command. Lando kind and related fields take precedence over Compose test, disable, and duration spellings.",
  }),
  command: Schema.optionalKey(CommandSpec).annotateKey({
    description:
      "Shell string or argv for a command probe. Empty commands are rejected; use false or kind none to disable.",
  }),
  url: ProbeUrl,
  port: ProbePort,
  intervalSeconds: Schema.optionalKey(IntervalSeconds).annotateKey({
    description:
      "Seconds between probe attempts after the start period. Non-negative. Planner default is 10 when omitted.",
  }),
  timeoutSeconds: Schema.optionalKey(TimeoutSeconds).annotateKey({
    description:
      "Per-attempt timeout in seconds; must be greater than zero. Planner default is 5 when omitted.",
  }),
  retries: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])).annotateKey({
    description:
      "Maximum attempts after the start period, with at least one attempt. Non-negative decimal integer or numeric string. Planner default is 5 when omitted.",
  }),
  startPeriodSeconds: Schema.optionalKey(IntervalSeconds).annotateKey({
    description:
      "Grace period in seconds: probing starts immediately, but failures during this period do not consume retries.",
  }),
  startIntervalSeconds: Schema.optionalKey(IntervalSeconds).annotateKey({
    description:
      "Seconds between attempts during the start period for native container healthchecks. Distinct from Compose start_interval; neither field rewrites the other.",
  }),
  test: Schema.optionalKey(ComposeTest).annotateKey({
    description:
      "Compose healthcheck test: a shell string, or a CMD, CMD-SHELL, or NONE argv array. Used only when no Lando kind, command, url, port, or numeric timing fields are set.",
  }),
  disable: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])).annotateKey({
    description:
      'Compose disable flag. true or "true" disables when no Lando fields win; false has no effect. Prefer healthcheck: false to replace a lower probe.',
  }),
  interval: Schema.optionalKey(Schema.String).annotateKey({
    description:
      'Compose duration between attempts (for example "30s" or "1m30s"). Normalized to intervalSeconds when Lando timing fields are absent.',
  }),
  timeout: Schema.optionalKey(Schema.String).annotateKey({
    description:
      "Compose per-attempt duration. Normalized to timeoutSeconds when Lando timing fields are absent; must decode to greater than zero.",
  }),
  start_period: Schema.optionalKey(Schema.String).annotateKey({
    description:
      "Compose start-period duration. Normalized to startPeriodSeconds when Lando timing fields are absent.",
  }),
  start_interval: Schema.optionalKey(Schema.String).annotateKey({
    description:
      "Raw Compose start_interval duration preserved losslessly for native runtime extensions. Not rewritten from startIntervalSeconds.",
  }),
}).annotate({ description: HEALTHCHECK_FIELD_DESCRIPTION });

const HealthcheckCanonicalBase = Schema.Struct({
  target: Schema.optionalKey(Schema.Literals(["service", "host"])).annotateKey({
    description: "Execution location; omitted means service. Host means the CLI machine.",
  }),
  user: Schema.optionalKey(ContainerUser).annotateKey({
    description: "Container identity for a service probe; not supported for host probes.",
  }),
  kind: Schema.optionalKey(Schema.Literals(["command", "http", "tcp", "none"])).annotateKey({
    description: "Probe kind: command, http, tcp, or none. Omitted with command implies command.",
  }),
  command: Schema.optionalKey(CommandSpec).annotateKey({
    description: "Shell string or argv for a command probe.",
  }),
  url: ProbeUrl,
  port: ProbePort,
  intervalSeconds: Schema.optionalKey(IntervalSeconds).annotateKey({
    description: "Seconds between probe attempts after the start period.",
  }),
  timeoutSeconds: Schema.optionalKey(TimeoutSeconds).annotateKey({
    description: "Per-attempt timeout in seconds; must be greater than zero.",
  }),
  retries: Schema.optionalKey(ProbeRetries).annotateKey({
    description:
      "Maximum attempts after the start period, with at least one attempt; the first success completes the probe.",
  }),
  startPeriodSeconds: Schema.optionalKey(IntervalSeconds).annotateKey({
    description:
      "Grace period in seconds: probing starts immediately, but failures during this period do not consume retries.",
  }),
  startIntervalSeconds: Schema.optionalKey(IntervalSeconds).annotateKey({
    description:
      "Seconds between attempts during the start period for native container healthchecks. Distinct from Compose start_interval.",
  }),
});

const HealthcheckCanonicalObject = HealthcheckCanonicalBase.pipe(
  Schema.fieldsAssign({
    start_interval: Schema.optionalKey(Schema.String).annotateKey({
      description: "Raw Compose start_interval duration preserved losslessly for native runtime extensions.",
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
    "startPeriodSeconds" in input ||
    "startIntervalSeconds" in input;
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
  const startIntervalSeconds = input.startIntervalSeconds;
  const composeStartInterval = input.start_interval;
  if (composeStartInterval !== undefined) parseComposeDuration(composeStartInterval);
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
  // Lando startIntervalSeconds and Compose start_interval stay separate: the
  // numeric field never rewrites the lossless Compose duration string.
  const shared = {
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.user === undefined ? {} : { user: input.user }),
    ...(retries === undefined ? {} : { retries }),
    ...(startIntervalSeconds === undefined ? {} : { startIntervalSeconds }),
    ...(composeStartInterval === undefined ? {} : { start_interval: composeStartInterval }),
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
  ...(input.startIntervalSeconds === undefined ? {} : { startIntervalSeconds: input.startIntervalSeconds }),
  ...(input.start_interval === undefined ? {} : { start_interval: input.start_interval }),
});

const EMPTY_HEALTHCHECK_COMMAND =
  "Healthcheck command must not be empty; use healthcheck: false to disable the probe.";
const healthcheckArgvLength = Schema.isMinLength(1, { message: EMPTY_HEALTHCHECK_COMMAND });

const validateCommand = (command: typeof CommandSpec.Type) => {
  if ((typeof command === "string" ? command : (command[0] ?? "")).trim().length === 0)
    throw new SchemaIssue.InvalidValue({ message: EMPTY_HEALTHCHECK_COMMAND }, command);
};

const HealthcheckAccepted = executionSite(
  Schema.Union([
    Schema.Literal(false),
    Schema.String.check(Schema.isMinLength(1, { message: EMPTY_HEALTHCHECK_COMMAND })),
    Schema.Array(Schema.String)
      .annotate({ "lando/authoring-array-check": healthcheckArgvLength })
      .check(healthcheckArgvLength),
    ComposeHealthcheckAccepted,
  ]),
  "healthcheck",
).annotate({
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
