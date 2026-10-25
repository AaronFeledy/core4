import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { Effect } from "effect";

import {
  type RouterBindKind,
  UNSPECIFIED_BIND_REMEDIATION,
  classifyRouterBindAddress,
  resolveEffectiveRouterBindAddress,
} from "./router-bind-address.ts";

const reportFor = (bindAddress: string, kind: RouterBindKind): PluginDoctorReport => {
  if (kind === "unspecified") {
    return {
      name: "router-bind-address",
      status: "warn",
      severity: "warn",
      runtimeStatus: UNSPECIFIED_BIND_REMEDIATION,
      runtime: { running: false },
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
      runtime: { running: false },
      context: { bindAddress, kind, note: "intentional LAN sharing" },
      solutions: [],
    };
  }
  return {
    name: "router-bind-address",
    status: "pass",
    severity: "info",
    runtimeStatus: "loopback",
    runtime: { running: false },
    context: { bindAddress, kind },
    solutions: [],
  };
};

export const makeRouterBindAddressCheck = (
  resolveBind: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<string> = resolveEffectiveRouterBindAddress,
): PluginDoctorCheckContribution => ({
  id: "router-bind-address",
  run: Effect.fnUntraced(function* (input) {
    const bindAddress = yield* resolveBind(input.env);
    return [reportFor(bindAddress, classifyRouterBindAddress(bindAddress))];
  }),
});

export const routerBindAddressCheck = makeRouterBindAddressCheck();
