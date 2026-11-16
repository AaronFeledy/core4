/**
 * Stale data-helper reclamation.
 *
 * Helpers stamped with an owner identity are reclaimed once the Lando process
 * that created them is proven gone, which lets cleanup act immediately instead
 * of waiting out an output-drain margin. Helpers created before that metadata
 * existed keep the old stopped-for-ten-minutes rule. Uncertainty always keeps
 * the helper: none of these checks may remove one it cannot prove abandoned.
 */
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Clock, DateTime, Duration, Effect, Option, Schema } from "effect";
import { buildContainerRemoveRequest } from "./engine-api.ts";
import { encodeEngineFilters } from "./engine-json.ts";
import type { VolumeHolder } from "./ephemeral-data-helpers.ts";
import {
  type HelperOwnerIdentity,
  type HelperReclaimOptions,
  type OwnerProcessObservation,
  helperOwnerIdentityFor,
  isActiveHelper,
  probeHelperOwnerPid,
} from "./helper-owner.ts";
import {
  DATA_HELPER_ROLE,
  HELPER_LIFECYCLE_LABEL,
  HELPER_LIFECYCLE_PROCESS,
  HELPER_LIFECYCLE_RETAIN,
  HELPER_OWNER_BOOT_LABEL,
  HELPER_OWNER_MACHINE_LABEL,
  HELPER_OWNER_PID_DOMAIN_LABEL,
  HELPER_OWNER_PID_LABEL,
  HELPER_OWNER_START_LABEL,
  PROVIDER_LABEL,
  ROLE_LABEL,
} from "./labels.ts";
import { redactString } from "./redact.ts";

export const STALE_DATA_HELPER_AGE_MS = 10 * 60 * 1000;
export const STALE_DATA_HELPER_SWEEP_DEADLINE = Duration.seconds(5);

export type StaleHelperRequester = (input: {
  readonly method: "GET" | "DELETE" | "POST" | "PUT";
  readonly path: `/${string}`;
}) => Effect.Effect<{ readonly status: number; readonly body: string }, unknown>;

export type DataHelperVerdict = "remove" | "keep";

export interface DataHelperReclaimInput {
  readonly labels: Readonly<Record<string, string>>;
  readonly providerId: string;
  /** Container name, used to match this process's live helpers. */
  readonly name: string;
  readonly state: string;
  readonly running?: boolean;
  readonly startedAt?: unknown;
  readonly finishedAt?: unknown;
  readonly created?: unknown;
  readonly nowMs: number;
  readonly identity: HelperOwnerIdentity | undefined;
  readonly isActive: (name: string) => boolean;
  readonly probe: (pid: number) => OwnerProcessObservation;
}

const ListedHelpers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      Names: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
);
const Lifecycle = Schema.fromJsonString(
  Schema.Struct({
    Name: Schema.optionalKey(Schema.String),
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

const isLegacyStaleDataHelper = (input: DataHelperReclaimInput): boolean => {
  if (input.running === true) return false;
  if (!isRemovableDataHelperState(input.state)) return false;
  const neverStarted =
    input.state === "created" ||
    (typeof input.startedAt === "string" &&
      (input.startedAt.length === 0 || input.startedAt.startsWith("0001-01-01")));
  const anchor =
    engineTimestampMs(input.finishedAt) ?? (neverStarted ? engineTimestampMs(input.created) : undefined);
  return anchor !== undefined && input.nowMs - anchor > STALE_DATA_HELPER_AGE_MS;
};

const readOwner = (labels: Readonly<Record<string, string>>): HelperOwnerIdentity | undefined => {
  const machine = labels[HELPER_OWNER_MACHINE_LABEL];
  const pidDomain = labels[HELPER_OWNER_PID_DOMAIN_LABEL];
  const pidText = labels[HELPER_OWNER_PID_LABEL];
  if (machine === undefined || machine.length === 0) return undefined;
  if (pidDomain === undefined || pidDomain.length === 0) return undefined;
  if (pidText === undefined || !/^[1-9]\d*$/u.test(pidText)) return undefined;
  const boot = labels[HELPER_OWNER_BOOT_LABEL];
  const start = labels[HELPER_OWNER_START_LABEL];
  return {
    machine,
    pidDomain,
    pid: Number(pidText),
    ...(boot === undefined || boot.length === 0 ? {} : { boot }),
    ...(start === undefined || start.length === 0 ? {} : { start }),
  };
};

const processOwnerVerdict = (
  owner: HelperOwnerIdentity,
  input: DataHelperReclaimInput,
): DataHelperVerdict => {
  const self = input.identity;
  // Never authorize removal without a known self identity to compare against.
  if (self === undefined) return "keep";
  if (owner.machine !== self.machine) return "keep";
  if (owner.boot !== undefined && self.boot !== undefined && owner.boot !== self.boot) return "remove";
  if (owner.pidDomain !== self.pidDomain) return "keep";
  if (owner.pid === self.pid) {
    // A different start token for our pid is a previous process that reused it.
    if (owner.start !== undefined && self.start !== undefined && owner.start !== self.start) return "remove";
    return input.isActive(input.name) ? "keep" : "remove";
  }
  const observation = input.probe(owner.pid);
  if (observation.state === "absent") return "remove";
  if (
    observation.state === "present" &&
    owner.start !== undefined &&
    observation.start !== undefined &&
    owner.start !== observation.start
  ) {
    // The pid now belongs to a different process, so the original owner exited.
    return "remove";
  }
  return "keep";
};

export const dataHelperReclaimVerdict = (input: DataHelperReclaimInput): DataHelperVerdict => {
  if (!isProviderDataHelperLabels(input.labels, input.providerId)) return "keep";
  const lifecycle = input.labels[HELPER_LIFECYCLE_LABEL];
  if (lifecycle === undefined) return isLegacyStaleDataHelper(input) ? "remove" : "keep";
  if (lifecycle === HELPER_LIFECYCLE_RETAIN) return "keep";
  if (lifecycle !== HELPER_LIFECYCLE_PROCESS) return "keep";
  const owner = readOwner(input.labels);
  // Partial metadata is not proof of anything; leave the helper alone.
  if (owner === undefined) return "keep";
  return processOwnerVerdict(owner, input);
};

const reclaimDependencies = (
  options: HelperReclaimOptions | undefined,
): {
  readonly identity: Effect.Effect<HelperOwnerIdentity | undefined>;
  readonly probe: (pid: number) => OwnerProcessObservation;
  readonly isActive: (name: string) => boolean;
} => ({
  identity: helperOwnerIdentityFor(options),
  probe: options?.probe ?? probeHelperOwnerPid,
  isActive: options?.isActive ?? isActiveHelper,
});

const inspectHelper = (request: StaleHelperRequester, id: string) =>
  request({ method: "GET", path: `/containers/${encodeURIComponent(id)}/json` }).pipe(
    Effect.flatMap((response): Effect.Effect<typeof Lifecycle.Type | undefined, unknown> => {
      if (response.status === 404) return Effect.succeed(undefined);
      if (response.status !== 200) return Effect.fail(response);
      return Schema.decodeUnknownEffect(Lifecycle)(response.body);
    }),
  );

const containerName = (value: string | undefined): string | undefined =>
  value?.replace(/^\//u, "").trim() || undefined;

const reclaimVerdict = (
  life: typeof Lifecycle.Type,
  input: {
    readonly providerId: string;
    readonly fallbackName: string;
    readonly nowMs: number;
    readonly identity: HelperOwnerIdentity | undefined;
    readonly isActive: (name: string) => boolean;
    readonly probe: (pid: number) => OwnerProcessObservation;
  },
): DataHelperVerdict =>
  dataHelperReclaimVerdict({
    labels: life.Config.Labels,
    providerId: input.providerId,
    name: containerName(life.Name) ?? input.fallbackName,
    state: life.State.Status,
    running: life.State.Running === true,
    startedAt: life.State.StartedAt,
    finishedAt: life.State.FinishedAt,
    created: life.Created,
    nowMs: input.nowMs,
    identity: input.identity,
    isActive: input.isActive,
    probe: input.probe,
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
    readonly helperReclaim?: HelperReclaimOptions;
  },
): Effect.Effect<boolean> => {
  if (request === undefined || input.holders.length === 0) return Effect.succeed(false);
  return Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const { identity, probe, isActive } = reclaimDependencies(input.helperReclaim);
    const self = yield* identity;
    const stale: string[] = [];
    for (const holder of input.holders) {
      const life = yield* inspectHelper(request, holder.id);
      // A holder another process already removed no longer blocks the volume.
      if (life === undefined) continue;
      const verdict = reclaimVerdict(life, {
        providerId: input.providerId,
        fallbackName: holder.name,
        nowMs,
        identity: self,
        isActive,
        probe,
      });
      if (verdict === "keep") return false;
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
  input: {
    readonly providerId: string;
    readonly redactor: Redactor;
    readonly helperReclaim?: HelperReclaimOptions;
  },
): Effect.Effect<void> => {
  if (request === undefined) return Effect.void;
  return Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const { identity, probe, isActive } = reclaimDependencies(input.helperReclaim);
    const self = yield* identity;
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
      if (life === undefined) continue;
      const fallbackName = containerName(helper.Names?.[0]) ?? helper.Id;
      if (
        reclaimVerdict(life, {
          providerId: input.providerId,
          fallbackName,
          nowMs,
          identity: self,
          isActive,
          probe,
        }) === "remove"
      ) {
        yield* removeHelper(request, helper.Id);
      }
    }
  }).pipe(
    Effect.timeout(STALE_DATA_HELPER_SWEEP_DEADLINE),
    Effect.catchCause((cause) => logJanitorFailure(cause, input.redactor)),
  );
};
