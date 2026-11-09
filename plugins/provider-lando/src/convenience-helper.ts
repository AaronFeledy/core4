import { engineInfoArchitecture, hostProxyContainerTargets } from "@lando/container-runtime/capabilities";
import { resolveContainerHelper } from "@lando/container-runtime/container-helper/assets";
import { isSuccessStatus } from "@lando/container-runtime/engine-api";
import { parseJsonOrUndefined } from "@lando/container-runtime/engine-json";
import type { ExecOptions } from "@lando/container-runtime/podman/exec";
import { Effect } from "effect";

export const withContainerHelper = Effect.fn("ProviderLando.withContainerHelper")(function* <
  Options extends Pick<ExecOptions, "api" | "resolveContainerHelper" | "helperTarget">,
>(options: Options) {
  const helperTarget =
    options.helperTarget ??
    (yield* Effect.gen(function* () {
      if (options.api?.request === undefined) return undefined;
      const response = yield* options.api.request({ method: "GET", path: "/info" });
      if (!isSuccessStatus(response.status)) return undefined;
      return hostProxyContainerTargets(engineInfoArchitecture(parseJsonOrUndefined(response.body)))[0];
    }));
  return {
    ...options,
    helperTarget,
    resolveContainerHelper: options.resolveContainerHelper ?? resolveContainerHelper,
  };
});
