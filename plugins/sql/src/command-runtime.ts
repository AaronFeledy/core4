import { realpath } from "node:fs/promises";

import { Effect } from "effect";

import { PlanReplanRequiredError, SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, ServiceName } from "@lando/sdk/schema";
import {
  DataMover,
  EnvironmentValueResolver,
  EventService,
  InteractionService,
  LandofileService,
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  StateStore,
  physicalVolumeLockKey,
} from "@lando/sdk/services";

import { validateExportCompressionLevel } from "./command-input.ts";
import { providerSqlExec } from "./dispatch.ts";
import { type DbCommandInput, executeDbCommand } from "./execute.ts";
import { resolveSqlTarget } from "./target.ts";
import { overlaySqliteFromLandofile, toSqlLandofile, toSqlPlan } from "./views.ts";

export const runDbCommand = Effect.fn("Sql.runDbCommand")(function* (input: DbCommandInput) {
  yield* validateExportCompressionLevel(input);
  const landofiles = yield* LandofileService;
  const environmentResolver = yield* EnvironmentValueResolver;
  const registry = yield* RuntimeProviderRegistry;
  const mover = yield* DataMover;
  const interaction = yield* InteractionService;
  const events = yield* EventService;
  const stateStore = yield* StateStore;
  const paths = yield* PathsService;
  const landofile = yield* landofiles.discover;
  const authored = toSqlLandofile(landofile.document);
  const planned = yield* registry.resolveAppliedPlan(landofile.context.appRoot);
  if (planned === undefined)
    return yield* Effect.fail(
      new PlanReplanRequiredError({
        app: landofile.document.name ?? landofile.context.appRoot,
        providerId: "unobserved",
        operation: "database connection",
        message: "No applied database plan is available for this app.",
        remediation: "Run `lando start` to apply the database plan, then retry.",
      }),
    );
  const plan = overlaySqliteFromLandofile(toSqlPlan(planned), authored);
  const earlyTarget = resolveSqlTarget(plan, input.service);
  if (earlyTarget._tag === "Failure") return yield* Effect.fail(earlyTarget.failure);
  const provider = yield* registry.select(planned);
  return yield* executeDbCommand(
    {
      landofile: authored,
      plan,
      environmentResolver,
      transfer: (spec) => Effect.scoped(mover.transfer(spec)),
      snapshot: (store, opts) => Effect.scoped(mover.snapshot(store, opts)),
      restore: (handle, store, opts) => Effect.scoped(mover.restore(handle, store, opts)),
      listSnapshots: (filter) => mover.listSnapshots(filter),
      resolveSnapshot: (reference, scope) => mover.resolveSnapshot(reference, scope),
      pruneSnapshots: (policy) => mover.pruneSnapshots(policy),
      providerId: planned.provider,
      ...(provider.appliedPlans === undefined ? {} : { appliedPlans: provider.appliedPlans }),
      inspectSource: (target) => provider.inspect(target),
      canonicalizeSourcePath: (path) =>
        Effect.tryPromise({
          try: () => realpath(path),
          catch: () =>
            new SqlRecoveryUnavailableError({
              message: `Cannot resolve source path ${path}.`,
              service: earlyTarget.success.name,
              reason: "The selected source path does not exist or is not accessible.",
              remediation: "Pass an existing app root with --from-path.",
            }),
        }).pipe(Effect.map(AbsolutePath.make)),
      exec: providerSqlExec(provider, planned),
      resume: (service, identity) => {
        const resume = provider.resume;
        return resume === undefined
          ? Effect.fail(
              new SqlRecoveryUnavailableError({
                message: `Cannot safely resume ${service} for recovery observation.`,
                service,
                reason: "The selected runtime provider cannot resume an exact inspected container identity.",
                remediation:
                  "Start the unchanged database service manually, create a logical export, then retry.",
              }),
            )
          : resume({ app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned }, identity);
      },
      suspend: (service, identity) => {
        const suspend = provider.suspend;
        return suspend === undefined
          ? Effect.fail(
              new SqlRecoveryUnavailableError({
                message: `Cannot safely return ${service} to its prior stopped state.`,
                service,
                reason: "The selected runtime provider cannot stop an exact inspected container identity.",
                remediation: "Leave the database stopped and create a logical export before recovery.",
              }),
            )
          : suspend(
              { app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned },
              identity,
            );
      },
      inspect: (service) =>
        provider
          .inspect({ app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned })
          .pipe(
            Effect.map((info) => ({
              status:
                info.containerId === undefined
                  ? "missing"
                  : info.status === "running" || info.state === "running"
                    ? "running"
                    : "stopped",
              running: info.status === "running" || info.state === "running",
              ...(info.containerId === undefined ? {} : { containerId: info.containerId }),
              ...(info.imageIdentity === undefined ? {} : { imageIdentity: info.imageIdentity }),
            })),
          ),
      inspectVolume: (service, store, destination) => {
        const mount = planned.services[ServiceName.make(service)]?.mounts.find(
          (entry) =>
            entry.type === "volume" &&
            entry.store === store &&
            (destination === undefined || entry.target === destination),
        );
        return mount === undefined || provider.observeVolume === undefined
          ? Effect.succeed(undefined)
          : provider.observeVolume(
              { app: planned.id, service: ServiceName.make(service), plan: planned },
              PortablePath.make(destination ?? mount.target),
            );
      },
      locateVolume: (volume) => provider.locateVolume(volume),
      adoptVolume: (service, store, destination) => {
        const mount = planned.services[ServiceName.make(service)]?.mounts.find(
          (entry) =>
            entry.type === "volume" &&
            entry.store === store &&
            (destination === undefined || entry.target === destination),
        );
        return mount === undefined || provider.adoptVolume === undefined
          ? Effect.succeed(undefined)
          : provider.adoptVolume(
              { app: planned.id, service: ServiceName.make(service), plan: planned },
              PortablePath.make(destination ?? mount.target),
            );
      },
      sqlite: {
        applied: planned,
        run: (spec) => Effect.scoped(provider.run(spec)),
        pullArtifact: (spec) => provider.pullArtifact(spec),
        paths: {
          ownerSnapshotsDir: paths.ownerSnapshotsDir,
        },
        stateStore,
      },
      withVolumeLock: (instanceId, body) => stateStore.withLock(physicalVolumeLockKey(instanceId), body),
      initialization: (identity) =>
        mover.volumeInitialization === undefined
          ? Effect.fail(
              new SqlRecoveryUnavailableError({
                message: "Shared volume initialization state is unavailable.",
                service: earlyTarget.success.name,
                reason: "The data mover does not provide initialization state.",
                remediation: "Use a data mover that supports generation-bound initialization.",
              }),
            )
          : mover.volumeInitialization(identity),
      confirm: (message) => Effect.scoped(interaction.confirm({ message, default: false })),
      publish: (event) => events.publish(event),
    },
    input,
  ).pipe(Effect.provideService(RuntimeProvider, provider));
}, Effect.scoped);
