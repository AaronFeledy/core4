import { ParseResult, Schema } from "effect";

import { parseComposeDuration } from "./compose-duration.ts";
import { CommandSpec } from "./primitives.ts";

const ComposeTest = Schema.Union(Schema.String, Schema.Array(Schema.String));

export const ComposeHealthcheckAccepted = Schema.Struct({
  kind: Schema.optional(Schema.Literal("command", "http", "tcp", "none")),
  command: Schema.optional(CommandSpec),
  url: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  intervalSeconds: Schema.optional(Schema.Number),
  timeoutSeconds: Schema.optional(Schema.Number),
  retries: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
  startPeriodSeconds: Schema.optional(Schema.Number),
  startInterval: Schema.optional(Schema.String),
  test: Schema.optional(ComposeTest),
  disable: Schema.optional(Schema.Union(Schema.Boolean, Schema.String)),
  interval: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.String),
  start_period: Schema.optional(Schema.String),
  start_interval: Schema.optional(Schema.String),
});

/**
 * Canonical Lando healthcheck fields, re-exported by `landofile.ts` as the
 * public `HealthcheckInput`. It lives here so {@link ComposeHealthcheckCanonical}
 * can extend it without an import cycle back through `landofile.ts`.
 */
export const HealthcheckCanonicalBase = Schema.Struct({
  kind: Schema.optional(Schema.Literal("command", "http", "tcp", "none")),
  command: Schema.optional(CommandSpec),
  url: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  intervalSeconds: Schema.optional(Schema.Number),
  timeoutSeconds: Schema.optional(Schema.Number),
  retries: Schema.optional(Schema.Number),
  startPeriodSeconds: Schema.optional(Schema.Number),
});

export const ComposeHealthcheckCanonical = Schema.extend(
  HealthcheckCanonicalBase,
  Schema.Struct({
    startInterval: Schema.optional(Schema.String).annotations({
      description: "Raw Compose start_interval duration preserved losslessly for runtime extensions.",
    }),
  }),
);

type AcceptedHealthcheck = typeof ComposeHealthcheckAccepted.Type;
type NormalizedTest = Readonly<{
  kind?: "command" | "none";
  command?: typeof CommandSpec.Type;
}>;

const normalizeTest = (test: AcceptedHealthcheck["test"]): NormalizedTest => {
  if (test === undefined) return {};
  if (typeof test === "string") return { kind: "command", command: test };

  const marker = test[0];
  switch (marker) {
    case "NONE":
      if (test.length !== 1) {
        throw new ParseResult.Type(
          ComposeTest.ast,
          test,
          'Landofile service healthcheck.test marker "NONE" must be the only array entry.',
        );
      }
      return { kind: "none" };
    case "CMD":
      if (test.length < 2) {
        throw new ParseResult.Type(
          ComposeTest.ast,
          test,
          'Landofile service healthcheck.test marker "CMD" requires at least one argv entry.',
        );
      }
      return { kind: "command", command: test.slice(1) };
    case "CMD-SHELL": {
      const command = test[1];
      if (test.length !== 2 || command === undefined) {
        throw new ParseResult.Type(
          ComposeTest.ast,
          test,
          'Landofile service healthcheck.test marker "CMD-SHELL" requires exactly one command string.',
        );
      }
      return { kind: "command", command };
    }
    case undefined:
      throw new ParseResult.Type(
        ComposeTest.ast,
        test,
        'Landofile service healthcheck.test must use a non-empty array beginning with "CMD", "CMD-SHELL", or "NONE".',
      );
    default:
      throw new ParseResult.Type(
        ComposeTest.ast,
        test,
        `Landofile service healthcheck.test marker unsupported: ${JSON.stringify(marker)}; expected "CMD", "CMD-SHELL", or "NONE".`,
      );
  }
};

const normalizeDisable = (disable: AcceptedHealthcheck["disable"]): boolean | undefined => {
  if (disable === undefined || typeof disable === "boolean") return disable;
  const normalized = disable.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new ParseResult.Type(
    ComposeHealthcheckAccepted.ast,
    disable,
    `Landofile service healthcheck.disable must be a boolean or the string "true" or "false"; received ${JSON.stringify(disable)}.`,
  );
};

const normalizeRetries = (retries: AcceptedHealthcheck["retries"]): number | undefined => {
  if (retries === undefined) return undefined;
  const normalized =
    typeof retries === "number" ? retries : /^[0-9]+$/.test(retries) ? Number(retries) : Number.NaN;
  if (Number.isSafeInteger(normalized) && normalized >= 0) return normalized;
  throw new ParseResult.Type(
    ComposeHealthcheckAccepted.ast,
    retries,
    `Landofile service healthcheck.retries must be a non-negative decimal integer; received ${JSON.stringify(retries)}.`,
  );
};

const decodeHealthcheck = (input: AcceptedHealthcheck): typeof ComposeHealthcheckCanonical.Type => {
  const retries = normalizeRetries(input.retries);
  const startInterval = input.startInterval ?? input.start_interval;
  const shared = {
    ...(retries === undefined ? {} : { retries }),
    ...(startInterval === undefined ? {} : { startInterval }),
  };
  const landoWins =
    "kind" in input ||
    "command" in input ||
    "url" in input ||
    "port" in input ||
    "intervalSeconds" in input ||
    "timeoutSeconds" in input ||
    "startPeriodSeconds" in input;

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

  const disable = normalizeDisable(input.disable);
  const test = normalizeTest(input.test);
  const intervalSeconds = input.interval === undefined ? undefined : parseComposeDuration(input.interval);
  const timeoutSeconds = input.timeout === undefined ? undefined : parseComposeDuration(input.timeout);
  const startPeriodSeconds =
    input.start_period === undefined ? undefined : parseComposeDuration(input.start_period);
  return {
    ...(disable === true ? { kind: "none" as const } : test),
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(startPeriodSeconds === undefined ? {} : { startPeriodSeconds }),
    ...shared,
  };
};

const encodeHealthcheck = (
  input: typeof ComposeHealthcheckCanonical.Type,
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

export const HealthcheckField = Schema.transformOrFail(
  ComposeHealthcheckAccepted,
  ComposeHealthcheckCanonical,
  {
    strict: true,
    decode: (input) => {
      try {
        return ParseResult.succeed(decodeHealthcheck(input));
      } catch (error) {
        if (error instanceof ParseResult.Type) return ParseResult.fail(error);
        throw error;
      }
    },
    encode: (input) => ParseResult.succeed(encodeHealthcheck(input)),
  },
);
