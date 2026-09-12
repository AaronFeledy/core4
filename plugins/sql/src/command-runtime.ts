import { Effect } from "effect";

import { AppId, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  DataMover,
  EventService,
  InteractionService,
  LandofileService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  StateStore,
  physicalVolumeLockKey,
} from "@lando/sdk/services";

import { type DbCommandInput, executeDbCommand } from "./execute.ts";
import { setSqlSeedStatus, sqlSeedState } from "./seed-state.ts";
import { resolveSqlTarget } from "./target.ts";
import { sqlPlanFromLandofile, toSqlLandofile, toSqlPlan } from "./views.ts";

export const runDbCommand = (input: DbCommandInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const landofiles = yield* LandofileService;
      const planner = yield* AppPlanner;
      const registry = yield* RuntimeProviderRegistry;
      const mover = yield* DataMover;
      const interaction = yield* InteractionService;
      const events = yield* EventService;
      const stateStore = yield* StateStore;
      const landofile = yield* landofiles.discover;
      const authored = toSqlLandofile(landofile);
      const prePlan = sqlPlanFromLandofile(authored);
      const earlyTarget = resolveSqlTarget(prePlan, input.service);
      if (earlyTarget._tag === "Left") return yield* Effect.fail(earlyTarget.left);
      const capabilities = yield* registry.capabilities;
      const planned = yield* planner.plan(landofile, capabilities);
      const provider = yield* registry.select(planned);
      const plan = toSqlPlan(planned);
      return yield* executeDbCommand(
        {
          landofile: authored,
          plan,
          transfer: (spec) => Effect.scoped(mover.transfer(spec)),
          snapshot: (store, opts) => Effect.scoped(mover.snapshot(store, opts)),
          restore: (id, store) => Effect.scoped(mover.restore(id, store)),
          listSnapshots: (filter) => mover.listSnapshots(filter),
          exec: (service, command, env) =>
            provider
              .exec(
                { app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned },
                { command, ...(env === undefined ? {} : { env }) },
              )
              .pipe(Effect.map((result) => ({ ok: result.exitCode === 0, stdout: result.stdout }))),
          start: (service) =>
            provider.start({ app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned }),
          stop: (service) =>
            provider.stop({ app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned }),
          inspect: (service) =>
            provider
              .inspect({ app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned })
              .pipe(
                Effect.map((info) => ({
                  running: info.status === "running" || info.state === "running",
                  ...(info.imageIdentity === undefined ? {} : { imageIdentity: info.imageIdentity }),
                })),
              ),
          inspectVolume: (_service, store) =>
            provider
              .listVolumes({ app: AppId.make(plan.id), store })
              .pipe(Effect.map((volumes) => volumes.find((volume) => volume.ref.store === store))),
          withVolumeLock: (instanceId, body) => stateStore.withLock(physicalVolumeLockKey(instanceId), body),
          getSeedStatus: (instanceId) =>
            sqlSeedState(stateStore, instanceId).pipe(
              Effect.flatMap((bucket) => bucket.get),
              Effect.map((state) => state?.status ?? "fresh"),
            ),
          setSeedStatus: (instanceId, status) => setSqlSeedStatus(stateStore, instanceId, status),
          confirm: (message) => Effect.scoped(interaction.confirm({ message, default: false })),
          publish: (event) => events.publish(event),
        },
        input,
      ).pipe(Effect.provideService(RuntimeProvider, provider));
    }),
  );
