import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { ProviderError, RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

export type RuntimeObservation =
  | { readonly kind: "running" }
  | { readonly kind: "idle" }
  | { readonly kind: "unavailable"; readonly error: ProviderError | undefined };

type ObservableRuntime = Pick<RuntimeProviderShape, "id" | "isAvailable" | "getStatus">;

export const observeRuntime = Effect.fn("RuntimeObservation.observe")(function* (
  provider: ObservableRuntime,
): Effect.fn.Return<RuntimeObservation> {
  return yield* Effect.gen(function* () {
    if (!(yield* provider.isAvailable))
      return {
        kind: "unavailable" as const,
        error: undefined,
      };
    const status = yield* provider.getStatus;
    return { kind: status.state };
  }).pipe(Effect.catch((error) => Effect.succeed({ kind: "unavailable" as const, error })));
});

export const liveInventoryObservable = (observation: RuntimeObservation): boolean =>
  observation.kind === "running";

export const workloadsProvablyStopped = (observation: RuntimeObservation): boolean =>
  observation.kind === "idle";

export const runtimeOnline = (provider: ObservableRuntime) =>
  observeRuntime(provider).pipe(
    Effect.flatMap((observation) =>
      observation.kind === "unavailable" && observation.error !== undefined
        ? Effect.fail(observation.error)
        : Effect.succeed(liveInventoryObservable(observation)),
    ),
  );

export const prepareTeardownOwners = Effect.fn("RuntimeObservation.prepareTeardownOwners")(function* (
  providers: readonly RuntimeProviderShape[],
) {
  for (const provider of new Map(providers.map((provider) => [provider.id, provider])).values()) {
    const observed = yield* observeRuntime(provider);
    switch (observed.kind) {
      case "running":
        continue;
      case "unavailable":
        if (observed.error === undefined || provider.ensureReady === undefined)
          return yield* Effect.fail(observed.error ?? unavailableRuntime(provider.id));
        break;
      case "idle":
        break;
      default:
        return observed satisfies never;
    }
    yield* provider.ensureReady ?? Effect.void;
    const prepared = yield* observeRuntime(provider);
    switch (prepared.kind) {
      case "running":
        break;
      case "unavailable":
        return yield* Effect.fail(prepared.error ?? unavailableRuntime(provider.id));
      case "idle":
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: provider.id,
            operation: "ensureReady",
            message: "The owning runtime remains idle after teardown preparation.",
            remediation: "Repair the owning runtime provider and retry destroy.",
          }),
        );
      default:
        return prepared satisfies never;
    }
  }
});

const unavailableRuntime = (providerId: string) =>
  new ProviderUnavailableError({
    providerId,
    operation: "getStatus",
    message: "The owning runtime provider is unavailable.",
    remediation: "Restore the owning runtime provider and retry.",
  });
