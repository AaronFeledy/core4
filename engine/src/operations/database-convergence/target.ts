import { mapFailures } from "@lando/sdk/command-result";
import { SqlCredentialTargetError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type ServicePlan,
  type VolumeLocator,
  clonedServiceParent,
  planAppIdentity,
} from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { heldVolumeLocks } from "@lando/state-store/volume-lock";
import { Effect } from "effect";

const dataPaths = {
  postgres: "/var/lib/postgresql/data",
  mysql: "/var/lib/mysql",
  mariadb: "/var/lib/mysql",
  mongodb: "/data/db",
  mssql: "/var/opt/mssql",
} as const;

export const targetError = (reason: SqlCredentialTargetError["reason"], message: string, service?: string) =>
  new SqlCredentialTargetError({
    reason,
    message,
    ...(service === undefined ? {} : { service }),
    remediation:
      reason === "not-running"
        ? "Start the database service and retry."
        : "Check the catalog service, applied placement, and owned database storage before retrying.",
  });

export const catalogMount = (plan: AppPlan, service: ServicePlan, retained: readonly ServicePlan[] = []) => {
  const family = service.connection?.family;
  if (family === undefined || clonedServiceParent(service) !== undefined) return undefined;
  const destination = dataPaths[family];
  const mount = service.mounts.find((entry) => entry.target === destination);
  if (mount?.type !== "volume" || mount.subpath !== undefined) return undefined;
  if (service.mounts.some((entry) => entry.target.startsWith(`${destination}/`))) return undefined;
  const store = plan.stores.find((entry) => entry.name === mount.store);
  if (store?.kind !== "data" || store.scope !== "service") return undefined;
  const references = [...Object.values(plan.services), ...retained]
    .flatMap((entry) => entry.mounts)
    .filter((entry) => entry.type === "volume" && entry.store === mount.store);
  return references.length === 1 ? mount : undefined;
};

export interface ActivatedDatabaseTarget {
  readonly containerId: string;
  readonly volume: VolumeLocator | undefined;
}

export const observeTarget = Effect.fn("DatabaseConvergence.observeTarget")(function* (input: {
  readonly plan: AppPlan;
  readonly service: ServicePlan;
  readonly provider: RuntimeProviderShape;
  readonly applying?: ActivatedDatabaseTarget;
  readonly retained?: readonly ServicePlan[];
}) {
  const { plan, service, provider } = input;
  const unsupported = targetError(
    "unsupported-target",
    "Could not prove private database storage for the selected service.",
    service.name,
  );
  const mount = catalogMount(plan, service, input.retained);
  if (mount === undefined || !provider.capabilities.serviceExec || provider.observeBoundVolume === undefined)
    return yield* unsupported;
  const target = { app: plan.id, service: service.name, plan };
  const info = yield* provider.inspect(target).pipe(mapFailures(() => unsupported));
  if (info.status !== "running")
    return yield* targetError("not-running", "The selected database container is not running.", service.name);
  const root = planAppIdentity(plan).appRoot;
  if (
    !info.containerId ||
    info.app !== plan.id ||
    info.appRoot !== root ||
    info.providerId !== plan.provider ||
    info.service !== service.name
  )
    return yield* unsupported;
  const replaced = targetError(
    "target-changed",
    "The database container or its coordinated storage changed during activation.",
    service.name,
  );
  if (input.applying !== undefined && info.containerId !== input.applying.containerId) return yield* replaced;
  const volume = yield* provider
    .observeBoundVolume({ ...target, expectedContainerId: info.containerId }, mount.target)
    .pipe(mapFailures(() => unsupported));
  const physical = volume?.identity;
  if (physical === undefined || physical.ownerRoot !== root || physical.nativeName !== volume?.ref.store)
    return yield* unsupported;
  if (input.applying !== undefined) {
    const expected = input.applying.volume;
    const lock = (yield* heldVolumeLocks).get(physical.coordinationKey);
    if (
      expected?.coordinationKey !== physical.coordinationKey ||
      expected.nativeName !== physical.nativeName ||
      (expected.identity !== undefined && expected.identity.generation !== physical.generation) ||
      lock?.mode !== "exclusive" ||
      lock.name !== physical.nativeName
    )
      return yield* replaced;
  }
  return {
    containerId: info.containerId,
    startedAt: info.lastStartedAt?.getTime(),
    physical,
  };
});
