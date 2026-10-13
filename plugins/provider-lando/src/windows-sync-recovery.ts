import type { EngineHttpRequest, PodmanApiClient } from "@lando/container-runtime/engine-api";
import { APP_LABEL, APP_ROOT_LABEL, SERVICE_LABEL } from "@lando/container-runtime/labels";
import { removeObservedContainer } from "@lando/container-runtime/service-lifecycle";
import { sameRealpath } from "@lando/paths";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ProviderError, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

import { verifiedFileSyncSessions } from "./applied-file-sync.ts";

type Api = Pick<PodmanApiClient, "request">;

/** Each entry must first be checked against its durable helper ownership receipt. */
export interface RetainedWindowsSyncTarget {
  readonly volumeName: string;
  readonly containerId?: string;
}

const context = {
  providerId: "lando",
  remediation:
    "Inspect the retained app's containers and sync volumes, restore their ownership records, and retry destroy.",
} as const;
const failure = (message: string) =>
  new ProviderUnavailableError({
    ...context,
    operation: "quiesceRetainedFileSync",
    message,
  });

const Inventory = Schema.Array(Schema.Struct({ Id: Schema.String }));
const Container = Schema.Struct({
  Id: Schema.String,
  Config: Schema.Struct({ Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)) }),
  Mounts: Schema.Array(Schema.Struct({ Type: Schema.String, Name: Schema.optionalKey(Schema.String) })),
});
type Container = typeof Container.Type;

const decode = <A, I>(schema: Schema.Codec<A, I>, body: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(JSON.parse(body)),
    catch: () => failure("Podman returned invalid container ownership or mount metadata."),
  });

/**
 * Quiesce a retained start without assuming that provider.apply saved a plan.
 * Container app/root/service labels are the runtime ownership proof; names are
 * never mutation addresses. Validate every volume user before removing any
 * writer, and recheck the inventory before the caller drains persistent sync.
 * This function changes no helper, volume, session, or recovery receipt.
 */
export const quiesceRetainedWindowsSyncWriters = Effect.fn("ProviderLando.quiesceRetainedWindowsSyncWriters")(
  function* (
    api: Api,
    plan: AppPlan,
    targets: ReadonlyArray<RetainedWindowsSyncTarget>,
  ): Effect.fn.Return<void, ProviderError> {
    const sessions = verifiedFileSyncSessions(plan);
    if (plan.provider !== "lando" || sessions === undefined)
      return yield* Effect.fail(failure("The retained accelerated mount plan cannot be verified."));
    const volumes = new Set(sessions.map(({ target }) => (target._tag === "volume" ? target.name : "")));
    const helpers = new Map<string, string>();
    const targetVolumes = new Set<string>();
    for (const target of targets) {
      if (!volumes.has(target.volumeName) || targetVolumes.has(target.volumeName))
        return yield* Effect.fail(
          failure("Retained helper identities do not match the planned sync volumes."),
        );
      targetVolumes.add(target.volumeName);
      if (target.containerId !== undefined) {
        if (target.containerId.length === 0 || helpers.has(target.containerId))
          return yield* Effect.fail(failure("Retained helper container identities are ambiguous."));
        helpers.set(target.containerId, target.volumeName);
      }
    }
    const request = api.request;
    if (request === undefined)
      return yield* Effect.fail(failure("The managed Podman API cannot inspect retained app writers."));
    const read = (input: EngineHttpRequest) =>
      request(input).pipe(Effect.mapError(() => failure("Podman could not inspect retained app writers.")));
    const inspect = (id: string) =>
      read({ method: "GET", path: `/containers/${encodeURIComponent(id)}/json` }).pipe(
        Effect.flatMap((response) => {
          if (response.status === 404) return Effect.succeed<Container | undefined>(undefined);
          if (response.status !== 200)
            return Effect.fail(failure("Podman could not verify a retained container before quiescence."));
          return decode(Container, response.body).pipe(
            Effect.flatMap((container) =>
              container.Id === id
                ? Effect.succeed(container)
                : Effect.fail(
                    failure("Podman returned a different container than the inspected immutable ID."),
                  ),
            ),
          );
        }),
      );
    const inventory = Effect.gen(function* () {
      const response = yield* read({ method: "GET", path: "/containers/json?all=true" });
      if (response.status !== 200)
        return yield* Effect.fail(failure("Podman could not list all users of the retained sync volumes."));
      const listed = yield* decode(Inventory, response.body);
      if (
        listed.some(({ Id }) => Id.length === 0) ||
        new Set(listed.map(({ Id }) => Id)).size !== listed.length
      )
        return yield* Effect.fail(failure("Podman returned ambiguous retained container identities."));
      const inspected = yield* Effect.forEach(listed, ({ Id }) => inspect(Id));
      const writers: ServiceRuntimeInfo[] = [];
      for (const container of inspected) {
        if (container === undefined) continue;
        const helperVolume = helpers.get(container.Id);
        if (helperVolume !== undefined) {
          if (
            container.Mounts.length !== 1 ||
            container.Mounts[0]?.Type !== "volume" ||
            container.Mounts[0]?.Name !== helperVolume
          )
            return yield* Effect.fail(failure("A verified sync helper no longer mounts its owned volume."));
          continue;
        }
        if (
          container.Mounts.some(
            (mount) => mount.Type === "volume" && (mount.Name === undefined || mount.Name.length === 0),
          )
        )
          return yield* Effect.fail(
            failure("Podman omitted a volume identity; retained writers cannot be verified."),
          );
        const labels = container.Config.Labels ?? {};
        const service = labels[SERVICE_LABEL];
        const root = labels[APP_ROOT_LABEL];
        const owned =
          labels[APP_LABEL] === String(plan.id) &&
          root !== undefined &&
          sameRealpath(root, plan.identity?.appRoot ?? plan.root) &&
          service !== undefined &&
          Object.hasOwn(plan.services, service);
        const usesSyncVolume = container.Mounts.some(
          (mount) => mount.Type === "volume" && mount.Name !== undefined && volumes.has(mount.Name),
        );
        if (usesSyncVolume && !owned)
          return yield* Effect.fail(
            failure(
              "A foreign or unplanned container uses a retained sync volume; safe quiescence cannot be confirmed.",
            ),
          );
        if (owned && service !== undefined && root !== undefined) {
          writers.push({
            providerId: ProviderId.make("lando"),
            app: plan.id,
            appRoot: AbsolutePath.make(root),
            service: ServiceName.make(service),
            containerId: container.Id,
            status: "stopped",
            labels,
          });
        }
      }
      return writers;
    });
    const writers = yield* inventory;
    for (const writer of writers) {
      yield* removeObservedContainer(writer, { api, ctx: context });
    }
    const remaining = yield* inventory;
    if (remaining.length !== 0)
      return yield* Effect.fail(
        failure(
          "App writers appeared or remained during retained-start quiescence; sync data and recovery records were preserved.",
        ),
      );
  },
);
