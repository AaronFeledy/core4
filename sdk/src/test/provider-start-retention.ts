import { Cause, Effect, Exit, Result } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  appIdentityKey,
  landoAppNetworkName,
} from "../schema/index.ts";
import type { RuntimeProviderShape, ServiceRuntimeInfo } from "../services/index.ts";
import {
  type ContractFailure,
  makeTestAppPlan,
  makeTestServicePlan,
  mapProviderFailure,
  planMetadata,
  requireContract,
} from "./_shared.ts";

/**
 * Minimal fault injection and native network/volume observations for start-retention
 * contract runs.
 *
 * Plugin fakes implement these against their in-memory Engine/Docker API so the
 * shared suite can arm a second-service start failure, abort mid-start, and read
 * retained network/volume presence. Container identity and running state come from
 * `provider.inspect({ app, service, plan })` only.
 */
export interface ProviderStartRetentionHooks {
  /**
   * Arm HTTP/start failures for the given native container names.
   * Pass an empty array to clear. Called by the contract before each failing apply.
   */
  readonly setFailStartFor: (containerNames: ReadonlyArray<string>) => void;
  /**
   * After `count` successful container starts in the current apply, abort `controller`.
   * Pass `count: 0` to clear. Used for mid-start interruption.
   */
  readonly setAbortAfterStarts: (count: number, controller?: AbortController) => void;
  /** Whether the named network still exists. */
  readonly hasNetwork: (networkName: string) => boolean;
  /** Whether the named volume still exists. */
  readonly hasVolume: (volumeName: string) => boolean;
}

/** Native container name convention shared by bundled providers (`lando-<slug>-<service>`). */
const retentionContainerName = (slug: string, service: string): string =>
  `lando-${slug}-${service}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const DB = ServiceName.make("db");
const WEB = ServiceName.make("web");

const makeService = (
  providerId: ProviderId,
  name: ServiceName,
  overrides: Partial<Pick<ServicePlan, "dependsOn" | "primary" | "mounts">> = {},
): ServicePlan => ({
  ...makeTestServicePlan(providerId),
  name,
  primary: name === WEB,
  command: ["sh", "-c", "sleep infinity"],
  ...overrides,
});

const makeRetentionPlan = (providerId: ProviderId): AppPlan => {
  const id = `start-retention-${crypto.randomUUID()}`;
  const root = AbsolutePath.make(`/tmp/${id}`);
  const dataStore = `${id}-data`;
  const base = makeTestAppPlan(providerId);
  const db = makeService(providerId, DB, { primary: false });
  const web = makeService(providerId, WEB, {
    dependsOn: [{ service: DB, condition: "service_started", required: true }],
    mounts: [
      {
        type: "volume",
        store: dataStore,
        target: PortablePath.make("/data"),
        readOnly: false,
      },
    ],
  });
  return {
    ...base,
    id: AppId.make(id),
    name: "Start Retention",
    slug: id,
    root,
    identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
    services: { [DB]: db, [WEB]: web },
    stores: [{ name: dataStore, scope: "app", kind: "data" }],
    metadata: planMetadata,
  };
};

const nonemptyContainerId = (info: ServiceRuntimeInfo): boolean =>
  typeof info.containerId === "string" && info.containerId.length > 0;

const isRunning = (info: ServiceRuntimeInfo): boolean => info.status === "running";

const inspectService = (
  provider: RuntimeProviderShape,
  plan: AppPlan,
  service: ServiceName,
): Effect.Effect<ServiceRuntimeInfo, ContractFailure> =>
  provider
    .inspect({ app: plan.id, service, plan })
    .pipe(Effect.mapError(mapProviderFailure(`inspect ${String(service)} returns a structured snapshot`)));

/**
 * Prove that a failed or interrupted multi-service apply retains containers,
 * networks, and volumes; that a retry reuses the first service's container id;
 * and that destroy with volumes cleans store volumes and the private network.
 */
export const runProviderStartRetentionContract = Effect.fnUntraced(function* (
  provider: RuntimeProviderShape,
  hooks: ProviderStartRetentionHooks,
): Effect.fn.Return<void, ContractFailure> {
  const providerId = ProviderId.make(provider.id);
  const plan = makeRetentionPlan(providerId);
  const webName = retentionContainerName(plan.slug, WEB);
  const networkName = landoAppNetworkName(plan);
  const volumeName = plan.stores[0]?.name ?? "";
  yield* requireContract(volumeName.length > 0, "retention plan includes a data store");

  // --- Second-service start failure retains first + failing resources ---
  hooks.setFailStartFor([webName]);
  hooks.setAbortAfterStarts(0);
  const failed = yield* Effect.result(Effect.scoped(provider.apply(plan, { reconcile: false })));
  yield* requireContract(Result.isFailure(failed), "second-service start failure fails apply", failed);

  const failedDb = yield* inspectService(provider, plan, DB);
  const failedWeb = yield* inspectService(provider, plan, WEB);
  yield* requireContract(
    nonemptyContainerId(failedDb),
    "start failure retains first service with a nonempty provider-inspected containerId",
    failedDb,
  );
  yield* requireContract(isRunning(failedDb), "start failure leaves the first service running", failedDb);
  yield* requireContract(
    nonemptyContainerId(failedWeb),
    "start failure retains the failing created service with a nonempty provider-inspected containerId",
    failedWeb,
  );
  yield* requireContract(
    !isRunning(failedWeb),
    "start failure leaves the failing service created but not ready",
    failedWeb,
  );
  yield* requireContract(
    networkName !== undefined && hooks.hasNetwork(networkName),
    "start failure retains the private app network",
    networkName,
  );
  yield* requireContract(hooks.hasVolume(volumeName), "start failure retains planned volumes", volumeName);

  const firstId = failedDb.containerId ?? "";
  yield* requireContract(firstId.length > 0, "retained first service exposes a native container id", firstId);

  // --- Retry clears the fault, converges, and preserves the first container id ---
  hooks.setFailStartFor([]);
  yield* Effect.scoped(provider.apply(plan, { reconcile: false })).pipe(
    Effect.mapError(mapProviderFailure("retry after start failure converges")),
  );
  const retryDb = yield* inspectService(provider, plan, DB);
  const retryWeb = yield* inspectService(provider, plan, WEB);
  yield* requireContract(retryDb.containerId === firstId, "retry preserves the first service container id", {
    firstId,
    retryId: retryDb.containerId,
  });
  yield* requireContract(
    isRunning(retryDb) && isRunning(retryWeb),
    "converged retry inspect shows both services running",
    { db: retryDb, web: retryWeb },
  );
  yield* requireContract(
    nonemptyContainerId(retryWeb),
    "converged retry exposes a nonempty containerId for the second service",
    retryWeb,
  );

  // --- Destroy with volumes cleans store volumes and the private network ---
  yield* Effect.scoped(provider.destroy({ app: plan.id, plan }, { volumes: true })).pipe(
    Effect.mapError(mapProviderFailure("destroy with volumes after retention converges")),
  );
  yield* requireContract(
    !hooks.hasVolume(volumeName),
    "destroy with volumes removes the retained data store",
    volumeName,
  );
  yield* requireContract(
    networkName !== undefined && !hooks.hasNetwork(networkName),
    "destroy removes the private app network",
    networkName,
  );
  const destroyedDb = yield* inspectService(provider, plan, DB);
  const destroyedWeb = yield* inspectService(provider, plan, WEB);
  yield* requireContract(
    !nonemptyContainerId(destroyedDb) && !isRunning(destroyedDb),
    "destroy removes the first service container (inspect has no containerId)",
    destroyedDb,
  );
  yield* requireContract(
    !nonemptyContainerId(destroyedWeb) && !isRunning(destroyedWeb),
    "destroy removes the second service container (inspect has no containerId)",
    destroyedWeb,
  );

  // --- Mid-start interruption retains resources; retry converges ---
  const interruptPlan = makeRetentionPlan(providerId);
  const interruptNetwork = landoAppNetworkName(interruptPlan);
  const interruptVolume = interruptPlan.stores[0]?.name ?? "";
  const controller = new AbortController();
  hooks.setFailStartFor([]);
  hooks.setAbortAfterStarts(1, controller);
  const interrupted = yield* Effect.exit(
    Effect.scoped(provider.apply(interruptPlan, { reconcile: false, signal: controller.signal })),
  );
  yield* requireContract(
    Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause) && controller.signal.aborted,
    "mid-start abort interrupts apply (interrupts-only) and aborts the controller",
    {
      exitTag: interrupted._tag,
      aborted: controller.signal.aborted,
      interruptsOnly: Exit.isFailure(interrupted) ? Cause.hasInterruptsOnly(interrupted.cause) : false,
    },
  );

  const interruptedDb = yield* inspectService(provider, interruptPlan, DB);
  yield* requireContract(
    nonemptyContainerId(interruptedDb) && isRunning(interruptedDb),
    "mid-start interruption retains the already-started container running with a nonempty containerId",
    interruptedDb,
  );
  yield* requireContract(
    interruptNetwork !== undefined && hooks.hasNetwork(interruptNetwork),
    "mid-start interruption retains the private app network",
    interruptNetwork,
  );
  yield* requireContract(
    hooks.hasVolume(interruptVolume),
    "mid-start interruption retains planned volumes",
    interruptVolume,
  );
  const retainedInterruptId = interruptedDb.containerId ?? "";
  yield* requireContract(
    retainedInterruptId.length > 0,
    "interrupted start exposes a native container id for the retained service",
    retainedInterruptId,
  );

  hooks.setAbortAfterStarts(0);
  yield* Effect.scoped(provider.apply(interruptPlan, { reconcile: false })).pipe(
    Effect.mapError(mapProviderFailure("retry after mid-start interruption converges")),
  );
  const afterInterruptDb = yield* inspectService(provider, interruptPlan, DB);
  const afterInterruptWeb = yield* inspectService(provider, interruptPlan, WEB);
  yield* requireContract(
    afterInterruptDb.containerId === retainedInterruptId,
    "retry after interruption preserves the first service container id",
    { retainedInterruptId, after: afterInterruptDb.containerId },
  );
  yield* requireContract(
    isRunning(afterInterruptDb) && isRunning(afterInterruptWeb),
    "retry after interruption inspect shows both services running",
    { db: afterInterruptDb, web: afterInterruptWeb },
  );

  yield* Effect.scoped(
    provider.destroy({ app: interruptPlan.id, plan: interruptPlan }, { volumes: true }),
  ).pipe(Effect.mapError(mapProviderFailure("interrupt retention contract cleanup succeeds")));
});
