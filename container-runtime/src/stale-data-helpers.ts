/** An output drain takes seconds; ten minutes protects another process's just-finished helper. */
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Clock, DateTime, Duration, Effect, Option, Schema } from "effect";
import { buildContainerRemoveRequest } from "./engine-api.ts";
import { encodeEngineFilters } from "./engine-json.ts";
import type { VolumeHolder } from "./ephemeral-data-helpers.ts";
import { DATA_HELPER_ROLE, PROVIDER_LABEL, ROLE_LABEL } from "./labels.ts";
import { redactString } from "./redact.ts";

export const STALE_DATA_HELPER_AGE_MS = 10 * 60 * 1000;
export const STALE_DATA_HELPER_SWEEP_DEADLINE = Duration.seconds(5);

export type StaleHelperRequester = (input: {
  readonly method: "GET" | "DELETE" | "POST" | "PUT";
  readonly path: `/${string}`;
}) => Effect.Effect<{ readonly status: number; readonly body: string }, unknown>;

const ListedHelpers = Schema.fromJsonString(Schema.Array(Schema.Struct({ Id: Schema.String })));
const Lifecycle = Schema.fromJsonString(
  Schema.Struct({
    State: Schema.Struct({
      Status: Schema.String,
      Running: Schema.optionalKey(Schema.Boolean),
      StartedAt: Schema.optionalKey(Schema.String),
      FinishedAt: Schema.optionalKey(Schema.String),
    }),
    Created: Schema.optionalKey(Schema.String),
    Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
  }),
);

export const isRemovableDataHelperState = (state: string): boolean =>
  state === "exited" || state === "created" || state === "dead";

export const isProviderDataHelperLabels = (
  labels: Readonly<Record<string, string>>,
  providerId: string,
): boolean => labels[ROLE_LABEL] === DATA_HELPER_ROLE && labels[PROVIDER_LABEL] === providerId;

export const engineTimestampMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value !== "string" || value.length === 0 || value.startsWith("0001-01-01")) return undefined;
  return Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.toEpochMillis));
};

export const isStaleDataHelper = (input: {
  readonly labels: Readonly<Record<string, string>>;
  readonly providerId: string;
  readonly state: string;
  readonly running?: boolean;
  readonly startedAt?: unknown;
  readonly finishedAt?: unknown;
  readonly created?: unknown;
  readonly nowMs: number;
}): boolean => {
  if (!isProviderDataHelperLabels(input.labels, input.providerId) || input.running === true) return false;
  if (!isRemovableDataHelperState(input.state)) return false;
  const neverStarted =
    input.state === "created" ||
    (typeof input.startedAt === "string" &&
      (input.startedAt.length === 0 || input.startedAt.startsWith("0001-01-01")));
  const anchor =
    engineTimestampMs(input.finishedAt) ?? (neverStarted ? engineTimestampMs(input.created) : undefined);
  return anchor !== undefined && input.nowMs - anchor > STALE_DATA_HELPER_AGE_MS;
};

const inspectHelper = (request: StaleHelperRequester, id: string) =>
  request({ method: "GET", path: `/containers/${encodeURIComponent(id)}/json` }).pipe(
    Effect.flatMap((response): Effect.Effect<typeof Lifecycle.Type | undefined, unknown> => {
      if (response.status === 404) return Effect.succeed(undefined);
      if (response.status !== 200) return Effect.fail(response);
      return Schema.decodeUnknownEffect(Lifecycle)(response.body);
    }),
  );

const staleLifecycle = (life: typeof Lifecycle.Type, providerId: string, nowMs: number): boolean =>
  isStaleDataHelper({
    labels: life.Config.Labels,
    providerId,
    state: life.State.Status,
    running: life.State.Running === true,
    startedAt: life.State.StartedAt,
    finishedAt: life.State.FinishedAt,
    created: life.Created,
    nowMs,
  });

const removeHelper = (request: StaleHelperRequester, id: string) =>
  request(buildContainerRemoveRequest(id)).pipe(
    Effect.flatMap((response) =>
      response.status === 200 || response.status === 204 || response.status === 404
        ? Effect.void
        : Effect.fail(response),
    ),
  );

const logJanitorFailure = (cause: Cause.Cause<unknown>, redactor: Redactor) =>
  // Best-effort janitor: the user's operation does not depend on reclaiming leftovers.
  Effect.logDebug("Skipped stale data-helper cleanup after a failure.").pipe(
    Effect.annotateLogs({ reason: redactString(Cause.pretty(cause), redactor) }),
  );

/** Validate every holder before removing any; uncertainty keeps the original named error. */
export const removeAllStaleVolumeHolders = (
  request: StaleHelperRequester | undefined,
  input: {
    readonly providerId: string;
    readonly holders: ReadonlyArray<VolumeHolder>;
    readonly redactor: Redactor;
  },
): Effect.Effect<boolean> => {
  if (request === undefined || input.holders.length === 0) return Effect.succeed(false);
  return Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const stale: string[] = [];
    for (const holder of input.holders) {
      const life = yield* inspectHelper(request, holder.id);
      // A holder another process already removed no longer blocks the volume.
      if (life === undefined) continue;
      if (!staleLifecycle(life, input.providerId, nowMs)) return false;
      stale.push(holder.id);
    }
    for (const id of stale) yield* removeHelper(request, id);
    return true;
  }).pipe(
    Effect.timeout(STALE_DATA_HELPER_SWEEP_DEADLINE),
    Effect.catchCause((cause) => logJanitorFailure(cause, input.redactor).pipe(Effect.as(false))),
  );
};

export const sweepStaleDataHelpers = (
  request: StaleHelperRequester | undefined,
  input: { readonly providerId: string; readonly redactor: Redactor },
): Effect.Effect<void> => {
  if (request === undefined) return Effect.void;
  return Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const response = yield* request({
      method: "GET",
      path: `/containers/json?all=true&filters=${encodeEngineFilters({
        label: [`${ROLE_LABEL}=${DATA_HELPER_ROLE}`, `${PROVIDER_LABEL}=${input.providerId}`],
      })}`,
    });
    if (response.status !== 200) return yield* Effect.fail(response);
    const helpers = yield* Schema.decodeUnknownEffect(ListedHelpers)(response.body);
    for (const helper of helpers) {
      const life = yield* inspectHelper(request, helper.Id);
      if (life !== undefined && staleLifecycle(life, input.providerId, nowMs)) {
        yield* removeHelper(request, helper.Id);
      }
    }
  }).pipe(
    Effect.timeout(STALE_DATA_HELPER_SWEEP_DEADLINE),
    Effect.catchCause((cause) => logJanitorFailure(cause, input.redactor)),
  );
};
