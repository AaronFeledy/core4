import { Effect, Schema } from "effect";

import { PortNumber } from "@lando/sdk/schema";

import {
  classifyInputFrom,
  classifyOrFail,
  fingerprintsEqual,
  pinDiffers,
  pinMismatch,
  preferredEacces,
  probeCurrent,
  resolveTryLists,
  stillOwnPersisted,
} from "./port-acquisition-helpers.ts";
import { ACQUISITION_MODES, type AcquisitionDecision } from "./port-acquisition.ts";
import { acquisitionStateFile, routingStateFile } from "./proxy-paths.ts";
import type { ProxyFileSystem, ProxyPaths, TraefikProxyDependencies } from "./proxy-types.ts";
import { isSocketProxyInstalled } from "./socket-proxy-install.ts";
import { resolveNeedsHelper } from "./socket-proxy-setup.ts";

const AcquisitionFingerprintSchema = Schema.Struct({
  http: Schema.Array(PortNumber),
  https: Schema.Array(PortNumber),
  bindAddress: Schema.String,
});

export const AcquisitionState = Schema.Struct({
  mode: Schema.Literal(...ACQUISITION_MODES),
  httpPort: PortNumber,
  httpsPort: PortNumber,
  notices: Schema.Array(Schema.String),
  fingerprint: AcquisitionFingerprintSchema,
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

const isLinuxFamily = (platform: ProxyPaths["platform"]): boolean =>
  platform === "linux" || platform === "wsl";

const decisionFromPersisted = (state: AcquisitionState): AcquisitionDecision => ({
  mode: state.mode,
  httpPort: state.httpPort,
  httpsPort: state.httpsPort,
  notices: state.notices,
  fingerprint: state.fingerprint,
});

export const persistPortAcquisition = (
  dependencies: TraefikProxyDependencies,
): Effect.Effect<AcquisitionDecision, unknown> =>
  Effect.gen(function* () {
    const lists = resolveTryLists(dependencies);
    const previous = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
    const routingExists = yield* dependencies.fileSystem.exists(routingStateFile(dependencies.paths));
    const pin = dependencies.routerPin;
    const previousPair =
      previous === undefined
        ? undefined
        : {
            httpPort: previous.httpPort,
            httpsPort: previous.httpsPort,
            helperInstalled: previous.helperInstalled === true,
            socketsActive: previous.socketsActive === true,
          };
    if (routingExists && pin !== undefined && previousPair !== undefined && pinDiffers(previousPair, pin)) {
      return yield* Effect.fail(pinMismatch(previousPair, pin));
    }
    const unitsInstalled =
      dependencies.socketProxy === undefined
        ? (previous?.helperInstalled ?? false)
        : yield* isSocketProxyInstalled(dependencies.socketProxy);
    const helperInstalled = unitsInstalled || (previous?.helperInstalled ?? false);
    const probed = yield* probeCurrent(dependencies, lists);
    if (
      previous !== undefined &&
      previousPair !== undefined &&
      fingerprintsEqual(previous.fingerprint, lists.fingerprint) &&
      (yield* stillOwnPersisted(dependencies, previousPair, probed, lists.bindAddress))
    ) {
      return decisionFromPersisted(previous);
    }
    if (
      isLinuxFamily(dependencies.paths.platform) &&
      preferredEacces(probed) &&
      dependencies.socketProxy !== undefined
    ) {
      const resolved = yield* resolveNeedsHelper(dependencies.socketProxy);
      if (resolved.decision.mode === "socket-helper" && resolved.socketsActive) {
        const decision = { ...resolved.decision, fingerprint: lists.fingerprint };
        yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
          ...decision,
          helperInstalled: resolved.helperInstalled,
          socketsActive: resolved.socketsActive,
        });
        return decision;
      }
    }
    const decision = yield* classifyOrFail(
      classifyInputFrom(dependencies, lists, helperInstalled, false, probed),
    );
    yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
      ...decision,
      helperInstalled,
      socketsActive: false,
    });
    return decision;
  });
