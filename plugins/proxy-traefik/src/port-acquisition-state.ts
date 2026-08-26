import { Effect, Schema } from "effect";

import { identifyLoopbackHolderComm } from "./leftover-proxy-ports-linux.ts";
import {
  ACQUISITION_MODES,
  type AcquisitionDecision,
  type BindOutcome,
  DESIRED_HTTPS_PORT,
  DESIRED_HTTP_PORT,
  classifyAcquisition,
  probeBind,
  probeForward,
} from "./port-acquisition.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";
import { acquisitionStateFile } from "./proxy-paths.ts";
import type { ProxyFileSystem, ProxyPaths, TraefikProxyDependencies } from "./proxy-types.ts";

export const AcquisitionState = Schema.Struct({
  mode: Schema.Literal(...ACQUISITION_MODES),
  httpPort: Schema.Literal(DESIRED_HTTP_PORT, TRAEFIK_HTTP_PORT),
  httpsPort: Schema.Literal(DESIRED_HTTPS_PORT, TRAEFIK_HTTPS_PORT),
  notices: Schema.Array(Schema.String),
  helperInstalled: Schema.optional(Schema.Boolean),
  socketsActive: Schema.optional(Schema.Boolean),
});
export type AcquisitionState = typeof AcquisitionState.Type;

export const writeAcquisitionState = (
  fileSystem: ProxyFileSystem,
  paths: ProxyPaths,
  state: AcquisitionState,
): Effect.Effect<void, unknown> =>
  fileSystem.writeAtomic(acquisitionStateFile(paths), `${JSON.stringify(state)}\n`);

export const readAcquisitionState = (
  fileSystem: ProxyFileSystem,
  paths: ProxyPaths,
): Effect.Effect<AcquisitionState | undefined> =>
  fileSystem.readText(acquisitionStateFile(paths)).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(AcquisitionState)(JSON.parse(text)),
        catch: (error) => error,
      }),
    ),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

const holderFor = (port: number, bind: BindOutcome): Effect.Effect<string | undefined> =>
  bind.kind === "EADDRINUSE"
    ? Effect.promise(() => identifyLoopbackHolderComm(port))
    : Effect.succeed(undefined);

const degradedDecision: AcquisitionDecision = {
  mode: "degraded-high-ports",
  httpPort: TRAEFIK_HTTP_PORT,
  httpsPort: TRAEFIK_HTTPS_PORT,
  notices: [],
};

export const acquirePorts = (input: {
  readonly platform: ProxyPaths["platform"];
  readonly helperInstalled: boolean;
  readonly socketsActive: boolean;
  readonly host?: string;
}): Effect.Effect<AcquisitionDecision> =>
  Effect.gen(function* () {
    const host = input.host ?? "127.0.0.1";
    const httpForward = yield* probeForward(host, DESIRED_HTTP_PORT);
    const httpsForward = yield* probeForward(host, DESIRED_HTTPS_PORT);
    const httpBind =
      httpForward.kind === "success"
        ? { kind: "success" as const }
        : yield* probeBind(host, DESIRED_HTTP_PORT);
    const httpsBind =
      httpsForward.kind === "success"
        ? { kind: "success" as const }
        : yield* probeBind(host, DESIRED_HTTPS_PORT);
    const httpHolder = yield* holderFor(DESIRED_HTTP_PORT, httpBind);
    const httpsHolder = yield* holderFor(DESIRED_HTTPS_PORT, httpsBind);
    return classifyAcquisition({
      platform: input.platform,
      helperInstalled: input.helperInstalled,
      socketsActive: input.socketsActive,
      http: {
        bind: httpBind,
        forward: httpForward,
        ...(httpHolder === undefined ? {} : { holder: httpHolder }),
      },
      https: {
        bind: httpsBind,
        forward: httpsForward,
        ...(httpsHolder === undefined ? {} : { holder: httpsHolder }),
      },
    });
  });

export const persistPortAcquisition = (
  dependencies: TraefikProxyDependencies,
): Effect.Effect<AcquisitionDecision, unknown> =>
  Effect.gen(function* () {
    const previous = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
    const helperInstalled = previous?.helperInstalled ?? false;
    const socketsActive = previous?.socketsActive ?? false;
    const decision = yield* acquirePorts({
      platform: dependencies.paths.platform,
      helperInstalled,
      socketsActive,
    }).pipe(Effect.catchAll(() => Effect.succeed(degradedDecision)));
    yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
      ...decision,
      helperInstalled,
      socketsActive,
    });
    return decision;
  });
