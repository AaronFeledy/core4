import { Effect } from "effect";
import { type LanguageSource, languageSource } from "../language/errors.ts";
import { expressionDataFromUnknownSync } from "../language/expressions.ts";
import { EventError, eventError } from "./errors.ts";
import { matchGlob, orderedMatch, validatePatterns } from "./glob.ts";

export type EventName = "push" | "pull_request" | "workflow_dispatch" | "workflow_call" | "schedule";
export interface InputDefinition {
  readonly type: "boolean" | "number" | "string" | "choice" | "environment";
  readonly required?: boolean;
  readonly default?: string | number | boolean;
  readonly options?: readonly string[];
}
export interface EventTrigger {
  readonly name: EventName;
  readonly branches?: readonly string[];
  readonly branchesIgnore?: readonly string[];
  readonly tags?: readonly string[];
  readonly tagsIgnore?: readonly string[];
  readonly paths?: readonly string[];
  readonly pathsIgnore?: readonly string[];
  readonly types?: readonly string[];
  readonly schedules?: readonly string[];
  readonly inputs?: Readonly<Record<string, InputDefinition>>;
  readonly secrets?: Readonly<Record<string, { readonly required?: boolean }>>;
}
export interface SimulationClock {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  readonly dayOfWeek: number;
}
export interface EventRequest {
  readonly mode: "supplied" | "simulation";
  readonly name: EventName;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly ref?: string;
  readonly baseRef?: string;
  readonly activity?: string;
  readonly changedFiles?: readonly string[];
  readonly inputs?: Readonly<Record<string, unknown>>;
  // Names of values already explicitly admitted by the host, never secret bytes.
  readonly secretNames?: readonly string[];
  readonly schedule?: string;
  readonly clock?: SimulationClock;
}
export type EventSelection =
  | {
      readonly kind: "selected";
      readonly mode: EventRequest["mode"];
      readonly name: EventName;
      readonly inputs: Readonly<Record<string, string | number | boolean>>;
      readonly schedule?: string;
    }
  | { readonly kind: "not-selected" }
  | { readonly kind: "deferred"; readonly reason: "event-data-unavailable"; readonly source: LanguageSource };
const deferred = (source: LanguageSource): EventSelection => ({
  kind: "deferred",
  reason: "event-data-unavailable",
  source: languageSource(source),
});

export const validateEventInputs = (
  trigger: EventTrigger,
  request: EventRequest,
  source: LanguageSource,
): Readonly<Record<string, string | number | boolean>> => {
  expressionDataFromUnknownSync(trigger, { limits: { valueNodes: 5000, valueBytes: 65536 } });
  expressionDataFromUnknownSync(request.inputs ?? {}, { limits: { valueNodes: 1000, valueBytes: 65536 } });
  expressionDataFromUnknownSync(request.secretNames ?? [], {
    limits: { valueNodes: 1000, valueBytes: 65536 },
  });
  const definitions = trigger.inputs ?? {};
  const supplied = request.inputs ?? {};
  if (Object.keys(definitions).length > 100 || Object.keys(supplied).length > 100)
    throw eventError("event-limit", source);
  if (Object.keys(supplied).some((name) => !Object.hasOwn(definitions, name)))
    throw eventError("event-input", source);
  const result: Record<string, string | number | boolean> = Object.create(null);
  for (const [name, definition] of Object.entries(definitions)) {
    if (
      trigger.name === "workflow_call" &&
      (definition.type === "choice" || definition.type === "environment")
    )
      throw eventError("event-input", source);
    if (!["boolean", "number", "string", "choice", "environment"].includes(definition.type))
      throw eventError("event-input", source);
    const value = Object.hasOwn(supplied, name) ? supplied[name] : definition.default;
    if (value === null || (Object.hasOwn(supplied, name) && value === undefined))
      throw eventError("event-input", source);
    if (value === undefined && definition.required) throw eventError("event-input", source);
    const chosen = value ?? (definition.type === "boolean" ? false : definition.type === "number" ? 0 : "");
    if (
      (definition.type === "boolean"
        ? typeof chosen !== "boolean"
        : definition.type === "number"
          ? typeof chosen !== "number"
          : typeof chosen !== "string") ||
      (typeof chosen === "number" && !Number.isFinite(chosen)) ||
      (definition.type === "choice" &&
        (!definition.options?.length || !definition.options.includes(chosen as string)))
    )
      throw eventError("event-input", source);
    result[name] = chosen as string | number | boolean;
  }
  const secrets = trigger.secrets ?? {};
  if (
    (request.secretNames ?? []).some((name) => !Object.hasOwn(secrets, name)) ||
    Object.entries(secrets).some(([name, rule]) => rule.required && !request.secretNames?.includes(name))
  )
    throw eventError("event-secret", source);
  return result;
};
const cronMatches = (cron: string, clock: SimulationClock, source: LanguageSource): boolean => {
  const parts = cron.trim().split(/\s+/u);
  const values = [clock.minute, clock.hour, clock.dayOfMonth, clock.month, clock.dayOfWeek];
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const;
  if (parts.length !== 5) throw eventError("schedule-unsupported", source);
  for (const [index, range] of ranges.entries()) {
    const part = parts[index];
    const value = values[index];
    if (
      part === undefined ||
      (part !== "*" && (!/^\d{1,2}$/u.test(part) || Number(part) < range[0] || Number(part) > range[1]))
    )
      throw eventError("schedule-unsupported", source);
    if (value === undefined || !Number.isInteger(value) || value < range[0] || value > range[1])
      throw eventError("event-invalid", source);
  }
  const matches = parts.map((part, i) => part === "*" || Number(part) === values[i]);
  return (
    matches[0] === true &&
    matches[1] === true &&
    matches[3] === true &&
    (parts[2] !== "*" && parts[4] !== "*"
      ? matches[2] === true || matches[4] === true
      : matches[2] === true && matches[4] === true)
  );
};
export const selectEvent = (
  triggers: readonly EventTrigger[],
  request: EventRequest,
  source: LanguageSource,
): Effect.Effect<EventSelection, EventError> =>
  Effect.try({
    try: (): EventSelection => {
      expressionDataFromUnknownSync(triggers, { limits: { valueNodes: 10000, valueBytes: 131072 } });
      expressionDataFromUnknownSync(request, { limits: { valueNodes: 10000, valueBytes: 262144 } });
      if (
        !["supplied", "simulation"].includes(request.mode) ||
        !["push", "pull_request", "workflow_dispatch", "workflow_call", "schedule"].includes(request.name) ||
        request.payload === null ||
        typeof request.payload !== "object" ||
        Array.isArray(request.payload)
      )
        throw eventError("event-invalid", source);
      if (
        (request.name === "push" &&
          (typeof request.ref !== "string" || !/^refs\/(?:heads|tags)\/.+$/u.test(request.ref))) ||
        (request.name === "pull_request" &&
          (typeof request.baseRef !== "string" ||
            !request.baseRef ||
            typeof request.activity !== "string" ||
            !request.activity)) ||
        (request.name === "schedule" &&
          request.mode === "supplied" &&
          (typeof request.schedule !== "string" || !request.schedule))
      )
        throw eventError("event-invalid", source);
      if (triggers.length > 100 || (request.changedFiles?.length ?? 0) > 3000)
        throw eventError("event-limit", source);
      const budget = { remaining: 2_000_000 };
      // Validate every pattern before matching; unsupported intent must not masquerade as false.
      for (const trigger of triggers)
        for (const [include, ignore] of [
          [trigger.branches, trigger.branchesIgnore],
          [trigger.tags, trigger.tagsIgnore],
          [trigger.paths, trigger.pathsIgnore],
        ]) {
          if (include && ignore) throw eventError("event-invalid", source);
          if (include) {
            validatePatterns(include, source, "event");
            if (!include.some((p) => !p.startsWith("!"))) throw eventError("event-invalid", source);
          }
          if (ignore) validatePatterns(ignore, source, "event", false);
        }
      for (const trigger of triggers) {
        if (trigger.name !== request.name) continue;
        if (request.name === "workflow_dispatch" || request.name === "workflow_call")
          return {
            kind: "selected",
            mode: request.mode,
            name: request.name,
            inputs: validateEventInputs(trigger, request, source),
          };
        if (request.name === "schedule") {
          if (request.schedule !== undefined) {
            if (trigger.schedules?.includes(request.schedule))
              return {
                kind: "selected",
                mode: request.mode,
                name: request.name,
                inputs: {},
                schedule: request.schedule,
              };
          } else {
            if (request.mode === "supplied" || request.clock === undefined) return deferred(source);
            const clock = request.clock;
            const matches = trigger.schedules?.map((cron) => ({
              cron,
              matches: cronMatches(cron, clock, source),
            }));
            const schedule = matches?.find((entry) => entry.matches)?.cron;
            if (schedule)
              return { kind: "selected", mode: request.mode, name: request.name, inputs: {}, schedule };
          }
          continue;
        }
        const isPr = request.name === "pull_request";
        if (isPr) {
          if (!(trigger.types ?? ["opened", "synchronize", "reopened"]).includes(request.activity ?? ""))
            continue;
        }
        const requestedRef = request.ref ?? "";
        const tag = !isPr && requestedRef.startsWith("refs/tags/");
        if (!isPr && !tag && !requestedRef.startsWith("refs/heads/"))
          throw eventError("event-invalid", source);
        const ref = isPr ? (request.baseRef ?? "") : requestedRef.slice(tag ? 10 : 11);
        const include = tag ? trigger.tags : trigger.branches;
        const ignore = tag ? trigger.tagsIgnore : trigger.branchesIgnore;
        if (tag && !include && !ignore && (trigger.branches || trigger.branchesIgnore)) continue;
        if (!tag && !include && !ignore && (trigger.tags || trigger.tagsIgnore)) continue;
        if (include && !orderedMatch(include, ref, budget, source)) continue;
        if (ignore?.some((pattern) => matchGlob(pattern, ref, budget, source))) continue;
        if (!tag && (trigger.paths || trigger.pathsIgnore)) {
          if (!request.changedFiles) return deferred(source);
          const paths = trigger.paths;
          const pathsIgnore = trigger.pathsIgnore;
          if (paths && !request.changedFiles.some((file) => orderedMatch(paths, file, budget, source)))
            continue;
          if (
            pathsIgnore &&
            request.changedFiles.every((file) =>
              pathsIgnore.some((pattern) => matchGlob(pattern, file, budget, source)),
            )
          )
            continue;
        }
        return { kind: "selected", mode: request.mode, name: request.name, inputs: {} };
      }
      return { kind: "not-selected" };
    },
    catch: (error) => (error instanceof EventError ? error : eventError("event-invalid", source)),
  });
