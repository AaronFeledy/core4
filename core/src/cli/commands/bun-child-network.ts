import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeLandoPaths } from "@lando/paths";
import {
  type NetworkTrustPlan,
  NetworkTrustResolutionError,
  resolveNetworkTrustPlan,
} from "@lando/sdk/network-trust";
import { ConfigService, FileSystem, PathsService } from "@lando/sdk/services";
import { Effect } from "effect";
import { ensureNetworkTrustCaBundle, loadBunCaCertificates } from "./bun-child-ca-bundle";
import {
  BunChildNetworkPolicyError,
  applyBunCaMode,
  applyProxyPlanToEnv,
  resolveBunChildCaMode,
} from "./bun-child-network-policy";

export { BunChildNetworkPolicyError } from "./bun-child-network-policy";

export interface BunChildNetworkProjectionInput {
  readonly env: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
  readonly verb: string;
  readonly plan?: NetworkTrustPlan;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
}

const resolvePlan = Effect.fnUntraced(function* (input: BunChildNetworkProjectionInput) {
  if (input.plan !== undefined) return input.plan;
  const config = yield* Effect.serviceOption(ConfigService);
  const network = config._tag === "Some" ? yield* config.value.get("network") : undefined;
  return yield* Effect.try({
    try: () => resolveNetworkTrustPlan({ network }, input.env),
    catch: (cause) => {
      if (!(cause instanceof NetworkTrustResolutionError)) throw cause;
      return new BunChildNetworkPolicyError({
        kind: "invalid-ca",
        message: cause.message,
        remediation: "Set LANDO_NETWORK_CA_CERTS to a JSON array of readable PEM certificate paths.",
      });
    },
  });
});

export const projectBunChildNetwork = Effect.fn("BunChildNetwork.project")(function* (
  input: BunChildNetworkProjectionInput,
) {
  const env = { ...input.env };
  const plan = yield* resolvePlan(input);
  applyProxyPlanToEnv(env, plan.proxy);
  const parentEnv = input.parentEnv ?? input.env;
  const parentExtra = plan.trustHost ? parentEnv.NODE_EXTRA_CA_CERTS : undefined;
  const caPaths = [...(parentExtra?.trim() ? [parentExtra] : []), ...plan.caCertPaths];
  let bundle: { readonly bundlePath: string; readonly digest: string } | undefined;
  if (caPaths.length > 0) {
    const suppliedFs = yield* Effect.serviceOption(FileSystem);
    const fs =
      suppliedFs._tag === "Some"
        ? suppliedFs.value
        : yield* FileSystem.pipe(Effect.provide(BunFileSystem.layer));
    const paths = yield* Effect.serviceOption(PathsService);
    const resolved = paths._tag === "Some" ? paths.value : makeLandoPaths({ env: input.env });
    const cas = yield* loadBunCaCertificates(caPaths, fs);
    bundle = yield* ensureNetworkTrustCaBundle({
      userCacheRoot: resolved.roots.userCacheRoot,
      platform: resolved.platform,
      cas,
      fileSystem: fs,
    });
  }
  const mode = resolveBunChildCaMode({
    trustHost: plan.trustHost,
    hasCustomCa: bundle !== undefined,
    verb: input.verb,
    argv: input.argv,
    ...(bundle === undefined ? {} : { bundlePath: bundle.bundlePath }),
  });
  const applied = yield* applyBunCaMode(env, input.argv, mode);
  return {
    ...applied,
    plan,
    ...(bundle === undefined ? {} : { bundlePath: bundle.bundlePath, bundleDigest: bundle.digest }),
  };
});
