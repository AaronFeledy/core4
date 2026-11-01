import { readFile } from "node:fs/promises";
import { normalizeHostPlatform } from "@lando/paths";
import { DebuggerHostUnavailableError, isErrnoCode } from "@lando/sdk/errors";
import { type AppPlan, DEBUGGER_HOST_ALIAS, HOST_GATEWAY_TARGET, type HostPlatform } from "@lando/sdk/schema";
import { ConfigService, PathsService, ProcessRunner } from "@lando/sdk/services";
import { Effect, Option } from "effect";

const REMEDIATION =
  "Set the reachable IDE address with `lando config set debugger.host <address>`, or use the Lando host with `lando config unset debugger.host`.";

const unavailable = (reason: DebuggerHostUnavailableError["reason"], networkingMode?: string) =>
  new DebuggerHostUnavailableError({
    message:
      "Cannot resolve the Windows debugger host. Automatic discovery requires WSL 2 with NAT networking.",
    reason,
    ...(networkingMode === undefined ? {} : { networkingMode }),
    remediation: REMEDIATION,
  });

export interface DebuggerHostDiscovery {
  readonly platform: HostPlatform;
  readonly readFile?: (path: string) => Promise<string>;
  readonly runner: Pick<ProcessRunner["Service"], "run">;
}

export const windowsDefaultGateway = (table: string): string | undefined => {
  const routes = table.split(/\r?\n/u).flatMap((row) => {
    const [iface, destination, gateway, flags, , , metric, mask] = row.trim().split(/\s+/u);
    if (destination !== "00000000" || mask !== "00000000") return [];
    if (gateway === undefined || !/^[0-9a-f]{8}$/iu.test(gateway) || gateway === "00000000") return [];
    if (flags === undefined || !/^[0-9a-f]+$/iu.test(flags) || (Number.parseInt(flags, 16) & 3) !== 3)
      return [];
    if (metric === undefined || !/^\d+$/u.test(metric)) return [];
    return [{ iface, gateway, metric: Number(metric) }];
  });
  routes.sort((a, b) => Number(b.iface === "eth0") - Number(a.iface === "eth0") || a.metric - b.metric);
  const route = routes[0];
  if (route === undefined) return undefined;
  return [6, 4, 2, 0].map((offset) => Number.parseInt(route.gateway.slice(offset, offset + 2), 16)).join(".");
};

export const discoverWindowsDebuggerHost = Effect.fn("DebuggerHost.discoverWindows")(function* (
  options: DebuggerHostDiscovery,
) {
  if (options.platform !== "linux" && options.platform !== "wsl") {
    return yield* Effect.fail(unavailable("not-wsl"));
  }
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const release = yield* Effect.tryPromise({
    try: () => read("/proc/sys/kernel/osrelease"),
    catch: () => unavailable("not-wsl"),
  });
  if (!/microsoft-standard|wsl2/iu.test(release)) return yield* Effect.fail(unavailable("not-wsl"));
  const mode = yield* options.runner
    .run({
      cmd: "wslinfo",
      args: ["--networking-mode"],
      timeoutMs: 2_000,
      capture: true,
    })
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout.trim())
          : Effect.fail(unavailable("wslinfo-failed")),
      ),
      Effect.catchTag("ProcessExecError", (error) =>
        error.errno === -2 || isErrnoCode(error.cause, "ENOENT")
          ? Effect.succeed("nat")
          : Effect.fail(unavailable("wslinfo-failed")),
      ),
      Effect.catchTag("ProcessTimeoutError", () => Effect.fail(unavailable("wslinfo-failed"))),
    );
  if (mode !== "nat") return yield* Effect.fail(unavailable("networking-mode", mode));
  const routes = yield* Effect.tryPromise({
    try: () => read("/proc/net/route"),
    catch: () => unavailable("no-default-route"),
  });
  const gateway = windowsDefaultGateway(routes);
  if (gateway === undefined) return yield* Effect.fail(unavailable("no-default-route"));
  return gateway;
});

export const hasDebuggerConsumer = (plan: AppPlan): boolean =>
  Object.values(plan.services).some((service) =>
    service.hostAliases.some((alias) => alias.hostname === DEBUGGER_HOST_ALIAS),
  );

/** True when a consumer must receive a configured address, without resolving it. */
export const debuggerHostConfigured = Effect.fn("DebuggerHost.configured")(function* (plan: AppPlan) {
  if (!hasDebuggerConsumer(plan)) return false;
  const config = yield* Effect.serviceOption(ConfigService);
  return Option.isSome(config) && (yield* config.value.get("debugger"))?.host !== undefined;
});

export const resolveDebuggerHost = Effect.fn("DebuggerHost.resolve")(function* (
  plan: AppPlan,
  discovery?: DebuggerHostDiscovery,
) {
  if (!hasDebuggerConsumer(plan)) return undefined;
  const config = yield* Effect.serviceOption(ConfigService);
  if (Option.isNone(config)) return undefined;
  const host = (yield* config.value.get("debugger"))?.host;
  if (host !== "windows") return host;
  if (discovery !== undefined) return yield* discoverWindowsDebuggerHost(discovery);
  const paths = yield* Effect.serviceOption(PathsService);
  const runner = yield* Effect.serviceOption(ProcessRunner);
  if (Option.isNone(runner)) return yield* Effect.fail(unavailable("wslinfo-failed"));
  return yield* discoverWindowsDebuggerHost({
    platform: Option.isSome(paths) ? paths.value.platform : normalizeHostPlatform(),
    runner: runner.value,
  });
});

export const applyDebuggerHost = (plan: AppPlan, address: string | undefined): AppPlan => {
  if (address === undefined) return plan;
  return {
    ...plan,
    services: Object.fromEntries(
      Object.entries(plan.services).map(([name, service]) => [
        name,
        {
          ...service,
          hostAliases: service.hostAliases.map((alias) =>
            alias.hostname === DEBUGGER_HOST_ALIAS ? { ...alias, ip: address } : alias,
          ),
        },
      ]),
    ),
  };
};

export const stripDebuggerHost = (plan: AppPlan): AppPlan => applyDebuggerHost(plan, HOST_GATEWAY_TARGET);
