import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { APP_LABEL, APP_ROOT_LABEL, SERVICE_LABEL } from "@lando/container-runtime/labels";
import {
  type ManagedHealthUnit,
  managedHealthListArgv,
  managedHealthStopArgv,
  managedHealthTimerArgv,
  managedHealthUnitName,
  managedUserManagerEnv,
  parseManagedHealthUnits,
} from "@lando/container-runtime/podman/managed-health-units";
import { redactDetails, standaloneSecretsRedactor } from "@lando/container-runtime/redact";
import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { LANDO_DATA_ROOT_LABEL } from "@lando/sdk/schema";
import type { ProcessResult, ProcessRunner } from "@lando/sdk/services";
import { Clock, type Context, Effect, Result, Schema } from "effect";

import type { UserSystemdTools } from "./delegated-scope.ts";
import { type HealthRun, decodeHealthRun, healthTimerPlan } from "./native-health-plan.ts";

/** Runs host `systemd-run`/`systemctl` argv against the user's manager; tests inject a fake. */
export interface UserSystemd {
  readonly run: (argv: ReadonlyArray<string>) => Effect.Effect<ProcessResult, ProviderUnavailableError>;
}

const NATIVE_HEALTH_REMEDIATION =
  "Run `lando doctor` and check `managed-runtime-native-health`; Lando recreates missing healthcheck timers the next time it starts or stops containers.";

const failure = (message: string, details?: unknown) => {
  const redactor = standaloneSecretsRedactor({ ...process.env });
  return new ProviderUnavailableError({
    providerId: "lando",
    operation: "nativeHealth",
    message: redactor.redactString(message),
    remediation: NATIVE_HEALTH_REMEDIATION,
    ...(details === undefined ? {} : { details: redactDetails(details, redactor) }),
  });
};

/** `ProcessRunner` with only `XDG_RUNTIME_DIR`: no D-Bus address, no host PATH. */
export const processUserSystemd = (
  runner: Context.Service.Shape<typeof ProcessRunner>,
  userRuntimeDir: string,
): UserSystemd => ({
  run: ([cmd = "", ...args]) =>
    runner
      .run({
        cmd,
        args,
        env: managedUserManagerEnv(userRuntimeDir),
        replaceEnv: true,
        capture: true,
        timeoutMs: 15_000,
      })
      .pipe(mapFailures((cause) => failure(`Could not run ${cmd} for native healthchecks.`, { cause }))),
});

export interface NativeHealthTimerDeps {
  readonly systemd: UserSystemd;
  readonly tools: UserSystemdTools;
  readonly api: EngineHttpApi;
  /** `managedHealthUnitPrefix` of the managed runtime's private dir. */
  readonly prefix: string;
  readonly runtimeBinDir: string;
  readonly socketPath: string;
  readonly runtimeConfigDir: string;
  /** Containers labeled with this data root (and app, root and service) are Lando's to schedule. */
  readonly dataRoot: string | undefined;
  /** The managed service's scope unit, when one is observed. */
  readonly scope: Effect.Effect<string | undefined>;
  /** The lock shared by enrollment, reconcile and teardown removal. */
  readonly withLock: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E | ProviderUnavailableError>;
  readonly warn: (error: ProviderUnavailableError) => Effect.Effect<void>;
}

const RunningContainers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    }),
  ),
);

const apiGet = (api: EngineHttpApi, path: `/${string}`) =>
  api.request === undefined
    ? Effect.fail(failure("The managed runtime API is unavailable for native healthchecks."))
    : api.request({ method: "GET", path }).pipe(mapFailures((cause) => failure(cause.message)));

/** A container's scheduled healthcheck, or undefined when it is gone or nothing should run. */
const inspectHealthRun = Effect.fnUntraced(function* (api: EngineHttpApi, ref: string) {
  const response = yield* apiGet(api, `/libpod/containers/${encodeURIComponent(ref)}/json`);
  if (response.status === 404) return undefined;
  if (response.status < 200 || response.status >= 300)
    return yield* failure(
      `Inspecting container ${ref} for its healthcheck failed with HTTP ${response.status}.`,
    );
  return decodeHealthRun(response.body);
});

const inspectHealthRuns = Effect.fnUntraced(function* (api: EngineHttpApi, ids: ReadonlyArray<string>) {
  const runs = yield* Effect.forEach(ids, (id) => inspectHealthRun(api, id), { concurrency: 4 });
  return runs.filter((healthRun): healthRun is HealthRun => healthRun !== undefined);
});

/** Every running container of the runtime, split into Lando's own for this data root and the rest. */
const runningContainers = Effect.fnUntraced(function* (api: EngineHttpApi, dataRoot: string | undefined) {
  const filters = JSON.stringify({ status: ["running"] });
  const response = yield* apiGet(api, `/libpod/containers/json?filters=${encodeURIComponent(filters)}`);
  const decoded = Schema.decodeUnknownResult(RunningContainers)(response.body);
  if (response.status < 200 || response.status >= 300 || Result.isFailure(decoded))
    return yield* failure(
      `Listing running containers for native healthchecks failed with HTTP ${response.status}.`,
    );
  const owned = (labels: Readonly<Record<string, string>> | null | undefined) =>
    dataRoot !== undefined &&
    labels?.[LANDO_DATA_ROOT_LABEL] === dataRoot &&
    [APP_LABEL, APP_ROOT_LABEL, SERVICE_LABEL].every((label) => (labels[label] ?? "") !== "");
  return {
    owned: decoded.success.filter(({ Labels }) => owned(Labels)).map(({ Id }) => Id),
    others: decoded.success.filter(({ Labels }) => !owned(Labels)).map(({ Id }) => Id),
  };
});

/**
 * Healthchecks of the running containers Lando owns in this data root: labeled with the data root
 * and with an app, app root and service. Other runtimes' and unlabeled containers are not Lando's.
 */
export const ownedHealthRuns = Effect.fnUntraced(function* (
  api: EngineHttpApi,
  dataRoot: string | undefined,
) {
  return yield* inspectHealthRuns(api, (yield* runningContainers(api, dataRoot)).owned);
});

export const makeNativeHealthTimers = (deps: NativeHealthTimerDeps) => {
  const run = Effect.fnUntraced(function* (argv: ReadonlyArray<string>) {
    const result = yield* deps.systemd.run(argv);
    if (result.exitCode === 0) return result.stdout;
    return yield* failure(`${argv[0]} ${argv[2]} exited with code ${result.exitCode}.`, {
      argv: argv.slice(1, 5),
      stderr: result.stderr.slice(0, 2000),
    });
  });
  const listUnits = run(managedHealthListArgv(deps.tools.systemctl, deps.prefix)).pipe(
    Effect.map((output) => parseManagedHealthUnits(deps.prefix, output)),
  );
  const stopKeys = (keys: ReadonlyArray<string>) =>
    keys.length === 0
      ? Effect.void
      : run(
          managedHealthStopArgv(
            deps.tools.systemctl,
            [...new Set(keys)].map((key) => `${deps.prefix}${key}-*`),
          ),
        );
  /**
   * Creates each missing role; an active timer with the role's exact name already satisfies it. A
   * missing role that still has loaded units can be pinned by its sibling's `Conflicts=`, so the
   * whole run is stopped and recreated rather than colliding on the name.
   */
  const ensureRoles = Effect.fnUntraced(function* (
    healthRun: HealthRun,
    units: ReadonlyArray<ManagedHealthUnit>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const scope = yield* deps.scope;
    const runUnits = units.filter((unit) => unit.key === healthRun.key);
    const planned = healthTimerPlan(healthRun, now);
    const missing = planned.filter(
      (timer) => !runUnits.some((unit) => unit.role === timer.role && unit.kind === "timer" && unit.active),
    );
    const restart = missing.some((timer) => runUnits.some((unit) => unit.role === timer.role));
    if (restart) yield* stopKeys([healthRun.key]);
    const start = managedHealthUnitName(deps.prefix, healthRun.key, "start");
    for (const timer of restart ? planned : missing) {
      yield* run(
        managedHealthTimerArgv({
          systemdRun: deps.tools.systemdRun,
          unit: managedHealthUnitName(deps.prefix, healthRun.key, timer.role),
          firstMs: timer.firstMs,
          cadenceMs: timer.cadenceMs,
          timeoutSeconds: healthRun.timeoutSeconds,
          ...(scope === undefined ? {} : { scope }),
          ...(timer.takesOverFromStart ? { takesOverFrom: start } : {}),
          runtimeBinDir: deps.runtimeBinDir,
          socketPath: deps.socketPath,
          runtimeConfigDir: deps.runtimeConfigDir,
          containerId: healthRun.containerId,
        }),
      );
    }
  });

  const scheduleLocked = (healthRun: HealthRun) =>
    deps.withLock(
      Effect.gen(function* () {
        const units = yield* listUnits;
        const previous = units.filter(
          (unit) => unit.key.startsWith(`${healthRun.containerId}-`) && unit.key !== healthRun.key,
        );
        yield* stopKeys(previous.map((unit) => unit.key));
        yield* ensureRoles(healthRun, units);
      }),
    );

  const schedule = Effect.fnUntraced(function* (healthRun: HealthRun, ref: string) {
    const startPhase = healthTimerPlan(healthRun, yield* Clock.currentTimeMillis).length > 1;
    yield* scheduleLocked(healthRun).pipe(
      Effect.catch((error) =>
        startPhase
          ? Effect.fail(
              failure(
                `Lando could not schedule the start interval healthcheck for container ${ref}, which may already be running: ${error.message}`,
                error.details,
              ),
            )
          : deps.warn(error),
      ),
    );
  });

  /**
   * Schedules one container right after it starts. A failure warns, unless the container needs
   * Lando's start-phase timer to honor its start interval: then the activation fails.
   */
  const enroll = (ref: string): Effect.Effect<void, ProviderUnavailableError> =>
    inspectHealthRun(deps.api, ref).pipe(
      Effect.matchEffect({
        onFailure: deps.warn,
        onSuccess: (healthRun) => (healthRun === undefined ? Effect.void : schedule(healthRun, ref)),
      }),
    );

  /** Schedules one container and fails on any error; setup's smoke check proves scheduling with it. */
  const enrollStrictly = (ref: string): Effect.Effect<void, ProviderUnavailableError> =>
    inspectHealthRun(deps.api, ref).pipe(
      Effect.flatMap((healthRun) =>
        healthRun === undefined
          ? Effect.fail(failure(`Container ${ref} is not running with a scheduled healthcheck.`))
          : scheduleLocked(healthRun),
      ),
    );

  /**
   * Repairs missing timers for owned running containers and stops the timers of every run that is
   * no longer running. A running container Lando does not own keeps the timers of its current run,
   * such as setup's smoke container, which is scheduled explicitly; reconcile never creates them.
   */
  const reconcile = deps
    .withLock(
      Effect.gen(function* () {
        const units = yield* listUnits;
        const containers = yield* runningContainers(deps.api, deps.dataRoot);
        const runs = yield* inspectHealthRuns(deps.api, containers.owned);
        const unowned = new Set(containers.others);
        const timed = [...new Set(units.map((unit) => unit.key.slice(0, unit.key.lastIndexOf("-"))))];
        const kept = yield* inspectHealthRuns(
          deps.api,
          timed.filter((id) => unowned.has(id)),
        );
        const current = new Set([...runs, ...kept].map((healthRun) => healthRun.key));
        yield* stopKeys(units.filter((unit) => !current.has(unit.key)).map((unit) => unit.key));
        yield* Effect.forEach(runs, (healthRun) => ensureRoles(healthRun, units), {
          concurrency: 4,
          discard: true,
        });
      }),
    )
    .pipe(Effect.catch(deps.warn));

  return { enroll, enrollStrictly, reconcile };
};

/** Stops every health unit of one runtime; teardown runs it before the service stops. */
export const removeNativeHealthTimers = (systemd: UserSystemd, systemctl: string, prefix: string) =>
  systemd.run(managedHealthStopArgv(systemctl, [`${prefix}*`])).pipe(Effect.asVoid);
