/**
 * Proven owner exit permits immediate reclamation; legacy helpers keep the
 * ten-minute output-drain margin. Uncertainty always keeps the helper.
 */
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Clock, DateTime, Duration, Effect, Option, Schema } from "effect";
import { buildContainerRemoveRequest } from "./engine-api.ts";
import { encodeEngineFilters } from "./engine-json.ts";
import type { VolumeHolder } from "./ephemeral-data-helpers.ts";
import {
  type HelperOwnerIdentity,
  type HelperReclaimOptions,
  helperOwnerIdentityFor,
  isActiveHelper,
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
import { type OwnerProcessObservation, probeHelperOwnerPid } from "./process-start-token.ts";
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
  readonly probe: (pid: number) => Effect.Effect<OwnerProcessObservation>;
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
  const start = labels[HELPER_OWNER_START_LABEL];
  // A process-owned helper always carries a start token; without one its owner is unreadable.
  if (start === undefined || start.length === 0) return undefined;
  const boot = labels[HELPER_OWNER_BOOT_LABEL];
  return {
    machine,
    pidDomain,
    pid: Number(pidText),
    ...(boot === undefined || boot.length === 0 ? {} : { boot }),
    start,
  };
};

const KEEP: Effect.Effect<DataHelperVerdict> = Effect.succeed("keep");
const REMOVE: Effect.Effect<DataHelperVerdict> = Effect.succeed("remove");

const processOwnerVerdict = (
  owner: HelperOwnerIdentity,
  input: DataHelperReclaimInput,
): Effect.Effect<DataHelperVerdict> => {
  const self = input.identity;
  // Never authorize removal without a known self identity to compare against.
  if (self === undefined) return KEEP;
  if (owner.machine !== self.machine) return KEEP;
  if (owner.boot !== undefined && self.boot !== undefined && owner.boot !== self.boot) return REMOVE;
  if (owner.pidDomain !== self.pidDomain) return KEEP;
  if (owner.pid === self.pid) {
    // A different start token for our pid is a previous process that reused it.
    if (owner.start !== self.start) return REMOVE;
    return input.isActive(input.name) ? KEEP : REMOVE;
  }
  // Probe lazily: a helper this process owns needs no liveness lookup at all.
  return input.probe(owner.pid).pipe(
    Effect.map((observed): DataHelperVerdict => {
      if (observed.state === "absent") return "remove";
      // The pid now belongs to a different process, so the original owner exited.
      if (observed.state === "present" && observed.start !== undefined && owner.start !== observed.start) {
        return "remove";
      }
      return "keep";
    }),
  );
};

export const dataHelperReclaimVerdict = (input: DataHelperReclaimInput): Effect.Effect<DataHelperVerdict> => {
  if (!isProviderDataHelperLabels(input.labels, input.providerId)) return KEEP;
  const lifecycle = input.labels[HELPER_LIFECYCLE_LABEL];
  if (lifecycle === undefined) return isLegacyStaleDataHelper(input) ? REMOVE : KEEP;
  if (lifecycle === HELPER_LIFECYCLE_RETAIN) return KEEP;
  if (lifecycle !== HELPER_LIFECYCLE_PROCESS) return KEEP;
  const owner = readOwner(input.labels);
  // Partial metadata is not proof of anything; leave the helper alone.
  if (owner === undefined) return KEEP;
  return processOwnerVerdict(owner, input);
};

/**
 * Prepares one cleanup pass. Our own identity is captured before the pass's deadline starts
 * (its lookups carry their own timeouts and are cached per process), and each owner pid is
 * probed at most once per pass, because a start-token read can spawn `ps` or PowerShell.
 */
const reclaimPass = (options: HelperReclaimOptions | undefined) =>
  helperOwnerIdentityFor(options).pipe(
    Effect.map((identity) => {
      const probeOwner = options?.probe ?? probeHelperOwnerPid;
      const observed = new Map<number, OwnerProcessObservation>();
      const probe = (pid: number): Effect.Effect<OwnerProcessObservation> => {
        const seen = observed.get(pid);
        return seen === undefined
          ? probeOwner(pid).pipe(
              Effect.tap((observation) => Effect.sync(() => observed.set(pid, observation))),
            )
          : Effect.succeed(seen);
      };
      return { identity, probe, isActive: options?.isActive ?? isActiveHelper };
    }),
  );

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
  input: Pick<DataHelperReclaimInput, "providerId" | "name" | "nowMs" | "identity" | "isActive" | "probe">,
): Effect.Effect<DataHelperVerdict> =>
  dataHelperReclaimVerdict({
    ...input,
    labels: life.Config.Labels,
    name: containerName(life.Name) ?? input.name,
    state: life.State.Status,
    running: life.State.Running === true,
    startedAt: life.State.StartedAt,
    finishedAt: life.State.FinishedAt,
    created: life.Created,
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
  return reclaimPass(input.helperReclaim).pipe(
    Effect.flatMap(({ identity: self, probe, isActive }) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const stale: string[] = [];
        for (const holder of input.holders) {
          const life = yield* inspectHelper(request, holder.id);
          // A holder another process already removed no longer blocks the volume.
          if (life === undefined) continue;
          const verdict = yield* reclaimVerdict(life, {
            providerId: input.providerId,
            name: holder.name,
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
      }).pipe(Effect.timeout(STALE_DATA_HELPER_SWEEP_DEADLINE)),
    ),
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
  return reclaimPass(input.helperReclaim).pipe(
    Effect.flatMap(({ identity: self, probe, isActive }) =>
      Effect.gen(function* () {
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
          if (life === undefined) continue;
          const fallbackName = containerName(helper.Names?.[0]) ?? helper.Id;
          const verdict = yield* reclaimVerdict(life, {
            providerId: input.providerId,
            name: fallbackName,
            nowMs,
            identity: self,
            isActive,
            probe,
          });
          if (verdict === "remove") yield* removeHelper(request, helper.Id);
        }
      }).pipe(Effect.timeout(STALE_DATA_HELPER_SWEEP_DEADLINE)),
    ),
    Effect.catchCause((cause) => logJanitorFailure(cause, input.redactor)),
  );
};
