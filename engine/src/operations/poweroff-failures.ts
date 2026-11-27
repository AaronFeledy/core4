import { RedactionService } from "@lando/redaction/service";
import { causeRemediation } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type ProviderId, StopAppResult } from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";

const PoweroffAppKind = Schema.Literals(["user", "scratch", "global"]);
const PoweroffAppOutcome = Schema.Literals(["stopped", "unchanged", "destroyed", "skipped"]);

export const PoweroffAppResultSchema = Schema.Struct({
  kind: PoweroffAppKind,
  appId: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  outcome: PoweroffAppOutcome,
  servicesStopped: Schema.optionalKey(StopAppResult.fields.servicesStopped),
  landofileEvents: StopAppResult.fields.landofileEvents,
  shutdownObservations: StopAppResult.fields.shutdownObservations,
});

type PoweroffAppResult = typeof PoweroffAppResultSchema.Type;

export const PoweroffStopFailureSchema = Schema.Struct({
  kind: PoweroffAppKind,
  appId: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.NonEmptyString,
});

type PoweroffStopFailure = typeof PoweroffStopFailureSchema.Type;

export type StopFailure = {
  readonly kind: PoweroffAppResult["kind"];
  readonly appId: string;
  readonly appRoot: string;
  readonly providerId: string;
  readonly error: unknown;
};

const failureTag = (error: unknown): string => {
  if (error !== null && typeof error === "object") {
    const tag = Reflect.get(error, "_tag");
    if (typeof tag === "string" && tag.length > 0) return tag;
  }
  return error instanceof Error && error.name.length > 0 ? error.name : "UnknownError";
};

const failureMessage = (error: unknown): string => {
  if (error !== null && typeof error === "object") {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
};

const failureRemediation = (error: unknown): string =>
  causeRemediation(error) ?? "Resolve the reported failure for this app, then retry `lando poweroff`.";

const redacted = Effect.fnUntraced(function* (text: string) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isNone(redaction)) return text;
  const profile = yield* redaction.value.forProfile("secrets", { sourceEnv: process.env });
  return profile.redactString(text);
});

const stopFailure = Effect.fnUntraced(function* (
  target: Pick<StopFailure, "kind" | "appId" | "appRoot" | "providerId">,
  error: unknown,
) {
  // App-scoped failures name the app; provider and inventory failures carry no root to name.
  const message =
    target.appRoot === ""
      ? failureMessage(error)
      : `${target.appId} (${target.appRoot}): ${failureMessage(error)}`;
  return {
    ...target,
    _tag: failureTag(error),
    message: yield* redacted(message),
    remediation: yield* redacted(failureRemediation(error)),
  } satisfies PoweroffStopFailure;
});

export const stopEntries = (failures: ReadonlyArray<StopFailure>): Effect.Effect<PoweroffStopFailure[]> =>
  Effect.forEach(failures, (failure) => stopFailure(failure, failure.error), { concurrency: 1 });

export const appResult = (
  target: Pick<StopFailure, "kind" | "appId" | "appRoot" | "providerId">,
  outcome: PoweroffAppResult["outcome"],
  result?: StopAppResult,
): PoweroffAppResult => ({
  ...target,
  outcome,
  ...(result?.servicesStopped === undefined ? {} : { servicesStopped: result.servicesStopped }),
  ...(result?.landofileEvents === undefined ? {} : { landofileEvents: result.landofileEvents }),
  ...(result?.shutdownObservations === undefined
    ? {}
    : { shutdownObservations: result.shutdownObservations }),
});

export const providerInventoryFailure = (providerId: string, error: unknown) => ({
  kind: "user" as const,
  appId: providerId,
  appRoot: "",
  providerId,
  error,
});

export const unobservedRuntimeError = (providerId: ProviderId) =>
  new ProviderUnavailableError({
    providerId,
    operation: "getStatus",
    message: "The provider reported a running runtime but no runtime inventory was observed.",
    remediation: "Restore provider access or stop its recorded apps explicitly, then retry `lando poweroff`.",
  });
