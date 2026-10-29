import { normalizeHostPlatform } from "@lando/paths";
import type { FileSyncSelectionError } from "@lando/sdk/errors";
import type {
  FileSyncPolicyReason,
  FileSyncServicePolicy,
  HostPlatform,
  PluginManifest,
  ProviderCapabilities,
  FileSyncPolicy as RecordedFileSyncPolicy,
} from "@lando/sdk/schema";
import { PathsService, PluginRegistry } from "@lando/sdk/services";
import { Context, Effect, Layer, Option, Result } from "effect";
import { FileSyncResolver } from "./file-sync-resolver.ts";
import {
  type FileSyncCandidateDefinition,
  matchesDefaultFor,
  selectFileSyncCandidate,
} from "./file-sync-selection.ts";

export type SelectedFileSyncPolicy = FileSyncCandidateDefinition & {
  readonly selectionReason: FileSyncPolicyReason;
};

export interface FileSyncPolicyInput {
  readonly capabilities: Pick<ProviderCapabilities, "bindMountPerformance" | "fileSyncTargets">;
  readonly defaultEngine?: string | undefined;
}

export const fileSyncOrdinaryReason = (input: FileSyncPolicyInput): FileSyncPolicyReason =>
  input.defaultEngine === "passthrough"
    ? "global-passthrough"
    : input.capabilities.bindMountPerformance !== "slow"
      ? "native-provider"
      : "no-compatible-engine";

export const serviceFileSyncPolicy = (input: {
  readonly mounted: boolean;
  readonly optedOut: boolean;
  readonly selected: SelectedFileSyncPolicy | undefined;
  readonly ordinaryReason: FileSyncPolicyReason;
}): FileSyncServicePolicy => ({
  mode: !input.mounted ? "absent" : input.selected === undefined ? "ordinary" : "accelerated",
  reason: !input.mounted
    ? "absent-app-mount"
    : input.optedOut
      ? "service-opt-out"
      : (input.selected?.selectionReason ?? input.ordinaryReason),
});

export const recordFileSyncPolicy = (input: {
  readonly selected: SelectedFileSyncPolicy | undefined;
  readonly services: RecordedFileSyncPolicy["services"];
  readonly ordinaryReason: FileSyncPolicyReason;
}): RecordedFileSyncPolicy => ({
  ...(input.selected === undefined ? {} : { engineId: input.selected.id }),
  reason:
    input.selected?.selectionReason ??
    (Object.values(input.services).every(({ mode }) => mode === "absent")
      ? "absent-app-mount"
      : Object.values(input.services).every(
            ({ mode, reason }) => mode === "absent" || reason === "service-opt-out",
          )
        ? "service-opt-out"
        : input.ordinaryReason),
  services: input.services,
});

export const fileSyncSelectionInput = (platform: HostPlatform, policy: FileSyncPolicyInput) => ({
  platform,
  bindMountPerformance:
    policy.capabilities.bindMountPerformance === "slow" ? ("slow" as const) : ("native" as const),
  ...(policy.capabilities.fileSyncTargets === undefined
    ? {}
    : { fileSyncTargets: policy.capabilities.fileSyncTargets }),
  ...(policy.defaultEngine === undefined ? {} : { defaultEngine: policy.defaultEngine }),
});

export const makeFileSyncPolicy = (input: {
  readonly candidates: readonly FileSyncCandidateDefinition[];
  readonly platform: HostPlatform;
}) => ({
  get candidates() {
    return input.candidates;
  },
  platform: input.platform,
  select: (policy: FileSyncPolicyInput) =>
    Result.match(selectFileSyncCandidate(input.candidates, fileSyncSelectionInput(input.platform, policy)), {
      onFailure: Effect.fail,
      onSuccess: (selected) =>
        Effect.succeed(
          selected === undefined
            ? undefined
            : {
                ...selected,
                selectionReason:
                  policy.defaultEngine !== undefined
                    ? ("explicit-engine" as const)
                    : matchesDefaultFor(selected.defaultFor, fileSyncSelectionInput(input.platform, policy))
                      ? ("default-engine" as const)
                      : ("sole-engine" as const),
              },
        ),
    }),
});

export const fileSyncMetadata = (
  manifests: readonly PluginManifest[],
): readonly FileSyncCandidateDefinition[] =>
  manifests.flatMap((manifest) =>
    (manifest.contributes?.fileSyncEngines ?? []).map((descriptor) => ({
      ...descriptor,
      pluginName: String(manifest.name),
      source: "manifest",
    })),
  );

export class FileSyncPolicy extends Context.Service<
  FileSyncPolicy,
  {
    readonly candidates: readonly FileSyncCandidateDefinition[];
    readonly platform: HostPlatform;
    readonly select: (
      input: FileSyncPolicyInput,
    ) => Effect.Effect<SelectedFileSyncPolicy | undefined, FileSyncSelectionError>;
  }
>()("@lando/engine/FileSyncPolicy") {
  static readonly make = Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    const resolver = yield* Effect.serviceOption(FileSyncResolver);
    const paths = yield* Effect.serviceOption(PathsService);
    const metadata = Option.isSome(resolver) ? [] : fileSyncMetadata(yield* registry.list);
    return makeFileSyncPolicy({
      get candidates() {
        return Option.isSome(resolver) ? resolver.value.candidates : metadata;
      },
      platform: Option.isSome(paths) ? paths.value.platform : normalizeHostPlatform(),
    });
  });
  static readonly layer = Layer.effect(this, this.make);
}
