import { Effect, Layer } from "effect";

import { HostProxyService, type HostProxyServiceShape } from "@lando/sdk/services";

export { HostProxyService };

const HOST_PROXY_DISABLED_ID = "disabled" as const;
const HOST_PROXY_DEFAULT_BASE_DOMAIN = "lndo.site";
const HOST_PROXY_DEFAULT_LOOPBACK = "127.0.0.1";

export const HostProxyServiceDisabled: HostProxyServiceShape = {
  id: HOST_PROXY_DISABLED_ID,
  setup: (_options) => Effect.void,
  status: () =>
    Effect.succeed({
      active: false,
      mode: "none" as const,
      mechanism: "skipped" as const,
      baseDomain: HOST_PROXY_DEFAULT_BASE_DOMAIN,
      loopback: HOST_PROXY_DEFAULT_LOOPBACK,
    }),
  teardown: () => Effect.void,
};

export const HostProxyServiceDisabledLive = Layer.succeed(HostProxyService, HostProxyServiceDisabled);

export {
  type DispatchRunLandoDeps,
  type HostProxyRunLandoExecutor,
  type HostProxyRunLandoExecutorInput,
  type HostProxyRunLandoResult,
  dispatchRunLando,
  openOptionsFromRunLandoArgv,
  runOpenForHostProxy,
} from "./dispatch.ts";
export { HOST_PROXY_RUNLANDO_ALLOWLIST } from "../../cli/oclif/generated/host-proxy-allowlist.ts";
export { type HostProxyMountInfo, remapContainerCwd } from "./cwd-remap.ts";
export { buildRunLandoRequest, filterHostProxyEnv } from "./shim.ts";
