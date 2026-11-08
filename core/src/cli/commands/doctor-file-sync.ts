import {
  fileSyncMetadata,
  fileSyncSelectionInput,
  makeFileSyncPolicy,
} from "@lando/engine/plugins/file-sync-policy";
import { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { GlobalConfig, HostPlatform, ProviderCapabilities } from "@lando/sdk/schema";
import { Effect, Option } from "effect";

export const selectedDoctorFileSyncEngine = Effect.fnUntraced(function* (input: {
  readonly modules: ReadonlyArray<LandoPluginModule>;
  readonly defaultEngine: GlobalConfig["defaultFileSyncEngine"];
  readonly platform: HostPlatform;
  readonly capabilities: ProviderCapabilities;
}) {
  const resolver = yield* Effect.serviceOption(FileSyncResolver);
  const policy = { capabilities: input.capabilities, defaultEngine: input.defaultEngine };
  const selected = yield* Option.isSome(resolver)
    ? resolver.value.select(fileSyncSelectionInput(input.platform, policy))
    : makeFileSyncPolicy({
        candidates: fileSyncMetadata(input.modules.map(({ manifest }) => manifest)),
        platform: input.platform,
      }).select(policy);
  return selected?.id;
});
