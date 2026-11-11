import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { runtimeLayoutPaths } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { hostPlatformFamily } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import {
  type DelegatedScopeHost,
  delegatedLaunchEligibility,
  delegatedScopeRemediation,
  observeServicePlacement,
  processCgroupPath,
  systemDelegatedScopeHost,
} from "./delegated-scope.ts";
import { readRuntimePid } from "./linux-runtime-reaper.ts";
import { providerContextForEnv } from "./provider-context.ts";
import { readLaunchState } from "./runtime-launch-state.ts";

const CHECK = "managed-runtime-container-cgroups";

/** Host PIDs of the service's running containers, or undefined when the inventory is unreadable. */
export type RunningContainerPids = (
  socketPath: string,
  env: Readonly<Record<string, string | undefined>>,
) => Effect.Effect<ReadonlyArray<number> | undefined>;

const RunningContainers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ Pid: Schema.optionalKey(Schema.Number), State: Schema.optionalKey(Schema.String) }),
  ),
);

const runningContainerPidsOverSocket: RunningContainerPids = (socketPath, env) => {
  const request = makePodmanApiClient(socketPath, providerContextForEnv(env)).request;
  if (request === undefined) return Effect.succeed(undefined);
  return request({ method: "GET", path: "/libpod/containers/json" }).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Schema.decodeUnknownEffect(RunningContainers)(response.body).pipe(
            Effect.map((containers): ReadonlyArray<number> | undefined =>
              containers.flatMap((container) =>
                container.State === "running" && container.Pid !== undefined && container.Pid > 0
                  ? [container.Pid]
                  : [],
              ),
            ),
          )
        : Effect.succeed(undefined),
    ),
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed(undefined)),
  );
};

export interface ManagedRuntimeCgroupCheckSeams {
  readonly host?: DelegatedScopeHost;
  readonly runningContainerPids?: RunningContainerPids;
}

const report = (
  input: Pick<PluginDoctorReport, "status" | "runtimeStatus" | "context" | "solutions"> & {
    readonly running: boolean;
  },
): PluginDoctorReport => ({
  name: CHECK,
  status: input.status,
  severity: input.status === "pass" ? "info" : "warn",
  ...(input.runtimeStatus === undefined ? {} : { runtimeStatus: input.runtimeStatus }),
  runtime: { running: input.running },
  context: input.context,
  solutions: input.solutions,
});

/**
 * Whether the managed Linux runtime gives containers their own cgroup, which `deploy.resources`
 * needs. A running service is judged by where it runs now, and its running containers by whether
 * they sit in their own cgroup: containers created before the service moved into a delegated
 * scope keep none until they are recreated. An idle runtime reports what the next launch will do.
 */
export const makeManagedRuntimeCgroupCheck = (
  seams: ManagedRuntimeCgroupCheckSeams = {},
): PluginDoctorCheckContribution => ({
  id: CHECK,
  run: Effect.fn("ManagedRuntimeCgroupCheck.run")(function* (input) {
    if (input.providerId !== "lando" || hostPlatformFamily(input.platform) !== "linux") return [];
    if (input.userDataRoot === undefined) return [];
    const host = seams.host ?? systemDelegatedScopeHost;
    const layout = runtimeLayoutPaths(input.userDataRoot, "linux");
    const eligibility = delegatedLaunchEligibility(input.platform, host);
    const pid = yield* readRuntimePid(layout.providerPidPath);
    const record = pid === undefined ? undefined : yield* readLaunchState(layout.providerPidPath);
    const servicePath = pid === undefined || record?.pid !== pid ? undefined : processCgroupPath(pid, host);

    if (pid === undefined || servicePath === undefined) {
      return [
        eligibility.eligible
          ? report({
              status: "pass",
              running: false,
              runtimeStatus: "The next runtime launch uses a delegated systemd user scope.",
              context: { nextLaunch: "delegated", systemdRun: eligibility.systemdRun },
              solutions: [],
            })
          : report({
              status: "warn",
              running: false,
              runtimeStatus:
                "The next runtime launch cannot use a delegated systemd user scope, so containers will not get their own cgroups and deploy.resources is unavailable.",
              context: { nextLaunch: "shared", reason: eligibility.reason },
              solutions: [{ kind: "manual", description: delegatedScopeRemediation(eligibility.reason) }],
            }),
      ];
    }

    if (observeServicePlacement(pid, host) === "shared") {
      return [
        report({
          status: "warn",
          running: true,
          runtimeStatus: `The runtime service runs in ${servicePath}, which is not delegated to your user, so containers get no cgroup of their own and resource limits do not apply.`,
          context: { servicePlacement: "shared", serviceCgroup: servicePath },
          solutions: [
            {
              kind: "manual",
              description: eligibility.eligible
                ? "Run `lando poweroff`, then start your apps again: the next launch uses a delegated systemd user scope."
                : delegatedScopeRemediation(eligibility.reason),
            },
          ],
        }),
      ];
    }

    const containerPids = yield* (seams.runningContainerPids ?? runningContainerPidsOverSocket)(
      layout.providerSocketPath,
      input.env,
    );
    const withoutOwnCgroup = (containerPids ?? []).filter(
      (containerPid) => processCgroupPath(containerPid, host) === servicePath,
    ).length;
    return [
      withoutOwnCgroup === 0
        ? report({
            status: "pass",
            running: true,
            runtimeStatus:
              "The runtime service runs in a delegated systemd user scope; containers get their own cgroups.",
            context: {
              servicePlacement: "delegated",
              serviceCgroup: servicePath,
              ...(containerPids === undefined ? { containers: "unreadable" } : {}),
            },
            solutions: [],
          })
        : report({
            status: "warn",
            running: true,
            runtimeStatus: `The runtime service runs in a delegated systemd user scope, but ${withoutOwnCgroup} running containers were created before it moved there and have no cgroup of their own, so their resource limits do not apply.`,
            context: {
              servicePlacement: "delegated",
              serviceCgroup: servicePath,
              containersWithoutCgroup: String(withoutOwnCgroup),
            },
            solutions: [
              {
                kind: "manual",
                description:
                  "Recreate the affected apps' containers with `lando rebuild` so they get their own cgroups.",
              },
            ],
          }),
    ];
  }),
});
