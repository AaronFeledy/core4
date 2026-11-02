import { bundledPluginModules } from "@lando/engine/composition";
import * as Subscribers from "@lando/engine/lifecycle/subscribers";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { dispatchHostOpen } from "@lando/engine/subsystems/host-proxy/dispatch";
import { openHostProxyTarget } from "@lando/engine/subsystems/host-proxy/open-target";
import { RedactionService } from "@lando/redaction/service";
import { writeStdioLine } from "@lando/renderer/io";
import { AbsolutePath, type HostProxyResponse } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { makeLandoRuntime } from "../../runtime/layer";
import { BUILT_IN_COMMAND_IDS } from "../generated/command-ids";
import type { HostProxyCall } from "./call-context";

type OpenCall = Exclude<HostProxyCall, { readonly operation: "runLando" }>;

export const hostProxyOpenResponse = Effect.fn("HostProxy.openResponse")(function* (call: OpenCall) {
  const config = yield* (yield* ConfigService).load;
  const request =
    call.operation === "openUrl"
      ? { _tag: "openUrl" as const, url: call.url }
      : { _tag: "openPath" as const, path: AbsolutePath.make(call.path) };
  const result = yield* Effect.result(
    dispatchHostOpen(request, {
      app: call.app,
      mountInfo: call.mount,
      callId: call.callId,
      depth: call.depth,
      callerService: call.callerService,
      executor: (target, mount) => openHostProxyTarget(target, mount, config.hostProxy?.allowedSchemes ?? []),
    }),
  );
  if (result._tag === "Success") return { _tag: "ok" as const };
  const failure = result.failure;
  const redactor = yield* (yield* RedactionService).forProfile("secrets", { sourceEnv: process.env });
  return {
    _tag: "error" as const,
    code:
      failure._tag === "HostProxyOpenUrlSchemeError"
        ? ("scheme-not-allowed" as const)
        : failure._tag === "HostProxyOpenPathError"
          ? ("command-not-allowed" as const)
          : ("internal" as const),
    message: redactor.redactString(failure.message),
    remediation: redactor.redactString(failure.remediation),
  } satisfies HostProxyResponse;
});

/** Host-proxy call children build their own runtime, so they register bundled plugins themselves. */
export const hostProxyOpenLayer = async (call: OpenCall) => {
  await import("../../runtime/bundled-plugins");
  const base = makeLandoRuntime(
    cliRuntimeOptions({
      bootstrap: "plugins",
      cwd: call.app.root,
      plugins: { policy: "discovery" },
      logLevel: "none",
      telemetry: false,
      installSignalHandlers: false,
    }),
  );
  return Subscribers.layerWithPrivateFileAccess(bundledPluginModules(), BUILT_IN_COMMAND_IDS).pipe(
    Layer.provideMerge(base),
  );
};

export const runHostProxyOpenProcess = async (call: OpenCall, signal: AbortSignal): Promise<void> => {
  const layer = await hostProxyOpenLayer(call);
  const response = await Effect.runPromise(
    hostProxyOpenResponse(call).pipe(
      Effect.provide(layer),
      Effect.catchCause(() =>
        Effect.succeed({
          _tag: "error" as const,
          code: "internal" as const,
          message: "Host-proxy open could not initialize or execute.",
          remediation:
            "Validate your global config.yml and installed plugins on the host, then retry the call.",
        }),
      ),
    ),
    { signal },
  );
  writeStdioLine("stdout", JSON.stringify(response));
};
