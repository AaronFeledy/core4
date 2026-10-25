import { readFile } from "node:fs/promises";

import { globalAppRootPath } from "@lando/paths";
import type {
  PluginDoctorCheckContribution,
  PluginDoctorCheckInput,
  PluginDoctorReport,
} from "@lando/sdk/plugins";
import type { HostPlatform } from "@lando/sdk/schema";
import { Effect } from "effect";

import { acquisitionStateFile } from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";
import {
  type RouterBindKind,
  UNSPECIFIED_BIND_REMEDIATION,
  bindAddressFromAcquisition,
  classifyRouterBindAddress,
  resolveEffectiveRouterBindAddress,
  resolvePublishedRouterBindAddress,
} from "./router-bind-address.ts";

const reportFor = (bindAddress: string, kind: RouterBindKind): PluginDoctorReport => {
  if (kind === "unspecified") {
    return {
      name: "router-bind-address",
      status: "warn",
      severity: "warn",
      runtimeStatus: UNSPECIFIED_BIND_REMEDIATION,
      context: { bindAddress, kind },
      solutions: [
        {
          kind: "manual",
          description: UNSPECIFIED_BIND_REMEDIATION,
        },
      ],
    };
  }
  if (kind === "specific") {
    return {
      name: "router-bind-address",
      status: "pass",
      severity: "info",
      runtimeStatus: "intentional LAN sharing",
      context: { bindAddress, kind, note: "intentional LAN sharing" },
      solutions: [],
    };
  }
  return {
    name: "router-bind-address",
    status: "pass",
    severity: "info",
    runtimeStatus: "loopback",
    context: { bindAddress, kind },
    solutions: [],
  };
};

export const persistedRouterBindFromUserData = (input: {
  readonly userDataRoot: string | undefined;
  readonly platform: HostPlatform;
}): Effect.Effect<string | undefined> => {
  if (input.userDataRoot === undefined) return Effect.succeed(undefined);
  const paths: ProxyPaths = {
    platform: input.platform,
    globalAppRoot: globalAppRootPath(input.userDataRoot, input.platform),
  };
  return Effect.tryPromise(async () =>
    bindAddressFromAcquisition(JSON.parse(await readFile(acquisitionStateFile(paths), "utf8"))),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)));
};

export const makeRouterBindAddressCheck = (
  resolveBind: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<string> = resolveEffectiveRouterBindAddress,
  loadPersisted: (
    input: Pick<PluginDoctorCheckInput, "userDataRoot" | "platform">,
  ) => Effect.Effect<string | undefined> = persistedRouterBindFromUserData,
): PluginDoctorCheckContribution => ({
  id: "router-bind-address",
  run: Effect.fnUntraced(function* (input) {
    const persisted = yield* loadPersisted(input);
    const fallback = yield* resolveBind(input.env);
    const bindAddress = resolvePublishedRouterBindAddress(persisted, fallback);
    return [reportFor(bindAddress, classifyRouterBindAddress(bindAddress))];
  }),
});

export const routerBindAddressCheck = makeRouterBindAddressCheck();
