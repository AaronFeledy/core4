import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as dataMoverLayer } from "@lando/data-mover/service";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, type VolumeRef, appIdentityKey } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";

const rootKeys = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;
let root: string;
let previous: ReadonlyArray<string | undefined>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-data-mover-roots-"));
  previous = rootKeys.map((key) => process.env[key]);
  for (const key of rootKeys) process.env[key] = join(root, key);
});
afterEach(async () => {
  for (const [index, key] of rootKeys.entries()) {
    const value = previous[index];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

export const fixtureOwnerRoot = AbsolutePath.make("/tmp/lando-sdk-test");
export const fixtureOwnerKey = appIdentityKey("owner", fixtureOwnerRoot);
export const fixtureVolume = (ref: VolumeRef = { app: AppId.make("data-app"), store: "data" }) => ({
  ref,
  provenance: "known" as const,
  instanceId: "00000000-0000-4000-8000-000000000001",
  identity: {
    coordinationKey: JSON.stringify(["endpoint:test", ref.store]),
    nativeName: ref.store,
    generation: "00000000-0000-4000-8000-000000000001",
    ownerRoot: fixtureOwnerRoot,
    origin: "created" as const,
  },
});

export const registryLayer = Layer.succeed(RuntimeProviderRegistry, {
  appliedPlansFor: () => Effect.succeed([]),
  resolveAppliedPlan: () => Effect.succeed(undefined),
  resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
  list: Effect.succeed([ProviderId.make("test")]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: (target) =>
    target === "test"
      ? Effect.succeed(TestRuntimeProvider)
      : Effect.fail(
          new ProviderUnavailableError({
            providerId: typeof target === "string" ? target : "unknown",
            operation: "select",
            message: "Provider is not installed in this test fixture.",
            remediation:
              "Install or start the selected runtime provider and confirm it can perform `select`.",
          }),
        ),
});
export const layer = dataMoverLayer.pipe(Layer.provide(registryLayer));
