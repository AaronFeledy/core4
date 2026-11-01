import type { NetworkTrustPlan } from "@lando/sdk/network-trust";
import { Effect, Schema } from "effect";

export class BunChildNetworkPolicyError extends Schema.TaggedError<BunChildNetworkPolicyError>()(
  "BunChildNetworkPolicyError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    kind: Schema.Literals([
      "empty-strict-trust",
      "unsupported-strict-bunx",
      "unsupported-strict-command",
      "invalid-ca",
      "bundle-write",
    ]),
  },
) {}

export const BUN_CHILD_PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;
export const BUN_PACKAGE_CAFILE_VERBS = new Set([
  "install",
  "i",
  "add",
  "a",
  "remove",
  "rm",
  "r",
  "update",
  "outdated",
  "publish",
]);
export const BUN_CAFILE_FLAG = "--cafile";
export const BUN_NO_INSTALL_FLAG = "--no-install";
export const NODE_EXTRA_CA_CERTS_ENV = "NODE_EXTRA_CA_CERTS";

export const applyProxyPlanToEnv = (env: Record<string, string>, proxy: NetworkTrustPlan["proxy"]): void => {
  for (const key of Object.keys(env)) {
    if (["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].includes(key.toUpperCase())) delete env[key];
  }
  if (proxy.http !== undefined) env.HTTP_PROXY = proxy.http;
  if (proxy.https !== undefined) env.HTTPS_PROXY = proxy.https;
  if (proxy.noProxy.length > 0) env.NO_PROXY = proxy.noProxy.join(",");
};

export const applyRemoveEnv = (env: Record<string, string>, keys: readonly string[] | undefined): void => {
  const wanted = new Set(keys?.map((key) => key.toUpperCase()));
  for (const key of Object.keys(env)) if (wanted.has(key.toUpperCase())) delete env[key];
};

type CaMode =
  | {
      readonly mode:
        | "none"
        | "bunx-no-install"
        | "fail-empty-strict"
        | "fail-strict-bunx"
        | "fail-strict-command";
    }
  | { readonly mode: "extra" | "cafile"; readonly bundlePath: string };

const hasBunxInstallOverride = (argv: readonly string[]): boolean => {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined || arg === "--" || !arg.startsWith("-")) return false;
    if (arg === "--install" || arg.startsWith("--install=")) return true;
    if (arg === "-p" || arg === "--package") index++;
  }
  return false;
};

export const resolveBunChildCaMode = (input: {
  readonly trustHost: boolean;
  readonly hasCustomCa: boolean;
  readonly verb: string;
  readonly argv: readonly string[];
  readonly bundlePath?: string;
}): CaMode => {
  const verb = input.argv[0] ?? input.verb;
  if (input.trustHost)
    return input.bundlePath === undefined
      ? { mode: "none" }
      : { mode: "extra", bundlePath: input.bundlePath };
  if (!input.hasCustomCa || input.bundlePath === undefined) return { mode: "fail-empty-strict" };
  if (verb === "x") {
    return hasBunxInstallOverride(input.argv) ? { mode: "fail-strict-bunx" } : { mode: "bunx-no-install" };
  }
  if (BUN_PACKAGE_CAFILE_VERBS.has(verb)) return { mode: "cafile", bundlePath: input.bundlePath };
  return ["run", "build", "test", "repl", "--help", "--version", "-h", "-v"].includes(verb) ||
    /\.[cm]?[jt]sx?$/u.test(verb)
    ? { mode: "none" }
    : { mode: "fail-strict-command" };
};

const stripCaFlags = (argv: readonly string[]): string[] => {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--cafile" || arg === "--ca") index++;
    else if (!arg.startsWith("--cafile=") && !arg.startsWith("--ca=")) result.push(arg);
  }
  return result;
};

export const applyBunCaMode = Effect.fnUntraced(function* (
  inputEnv: Record<string, string>,
  argv: readonly string[],
  mode: CaMode,
) {
  const { NODE_EXTRA_CA_CERTS: _extra, NODE_TLS_REJECT_UNAUTHORIZED: _verification, ...env } = inputEnv;
  switch (mode.mode) {
    case "none":
      return { env, argv };
    case "extra":
      env.NODE_EXTRA_CA_CERTS = mode.bundlePath;
      return { env, argv };
    case "cafile": {
      const cleaned = stripCaFlags(argv);
      return { env, argv: [cleaned[0] ?? "install", "--cafile", mode.bundlePath, ...cleaned.slice(1)] };
    }
    case "bunx-no-install": {
      return {
        env,
        argv: ["x", "--no-install", ...argv.slice(1)],
      };
    }
    case "fail-empty-strict":
      return yield* Effect.fail(
        new BunChildNetworkPolicyError({
          kind: "empty-strict-trust",
          message: "Strict network trust has no custom CA certificates for this Bun child.",
          remediation:
            "Add readable PEM certificates under network.ca.certs or LANDO_NETWORK_CA_CERTS before running Bun.",
        }),
      );
    case "fail-strict-bunx":
      return yield* Effect.fail(
        new BunChildNetworkPolicyError({
          kind: "unsupported-strict-bunx",
          message: "Strict trust cannot permit bunx registry installation.",
          remediation:
            "Install the package with `lando bun add`, then run its local binary with `lando x --no-install`. Remove conflicting --install flags.",
        }),
      );
    case "fail-strict-command":
      return yield* Effect.fail(
        new BunChildNetworkPolicyError({
          kind: "unsupported-strict-command",
          message: "This Bun command has no verified strict registry trust projection.",
          remediation:
            "Use install, add, remove, update, outdated or publish, or run an installed local binary with `lando x --no-install`.",
        }),
      );
    default:
      return mode satisfies never;
  }
});
