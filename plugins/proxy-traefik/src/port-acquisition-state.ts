import { Effect, Schema } from "effect";

import { PortNumber } from "@lando/sdk/schema";

import { occupiedHopNotices } from "./occupied-port-warning.ts";
import {
  type ProbedAcquisition,
  classifyOrFail,
  fingerprintsEqual,
  pinDiffers,
  pinMismatch,
  preferredEacces,
  probeCurrent,
  resolveTryLists,
  stillOwnPersisted,
} from "./port-acquisition-helpers.ts";
import {
  ACQUISITION_MODES,
  type AcquisitionDecision,
  DESIRED_HTTPS_PORT,
  DESIRED_HTTP_PORT,
  chooseHelperBindPorts,
  isOurSocketHelperHolder,
} from "./port-acquisition.ts";
import { acquisitionStateFile, routingStateFile } from "./proxy-paths.ts";
import type { ProxyFileSystem, ProxyPaths, TraefikProxyDependencies } from "./proxy-types.ts";
import { isSocketProxyInstalled, readHelperHopTargets } from "./socket-proxy-install.ts";
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
  bindHttpPort: Schema.optional(PortNumber),
  bindHttpsPort: Schema.optional(PortNumber),
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

const isOurPreferredHolder = (probe: {
  readonly holder?: string;
  readonly holderSystemdUnit?: string;
}): boolean => {
  if (probe.holder !== undefined && isOurSocketHelperHolder(probe.holder)) return true;
  const unit = probe.holderSystemdUnit;
  return unit?.startsWith("lando-proxy-") === true;
};

const helperOwnsPreferred = (probed: ProbedAcquisition): boolean =>
  isOurPreferredHolder(probed.http) && isOurPreferredHolder(probed.https);

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
            ...(previous.bindHttpPort === undefined ? {} : { bindHttpPort: previous.bindHttpPort }),
            ...(previous.bindHttpsPort === undefined ? {} : { bindHttpsPort: previous.bindHttpsPort }),
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
    const linuxLike = dependencies.paths.platform === "linux" || dependencies.paths.platform === "wsl";
    if (linuxLike && helperInstalled && helperOwnsPreferred(probed)) {
      const fromUnits =
        dependencies.socketProxy === undefined
          ? undefined
          : yield* readHelperHopTargets(dependencies.socketProxy);
      const bindHttpPort = fromUnits?.httpTarget ?? previous?.bindHttpPort;
      const bindHttpsPort = fromUnits?.httpsTarget ?? previous?.bindHttpsPort;
      if (bindHttpPort !== undefined && bindHttpsPort !== undefined) {
        const decision: AcquisitionDecision = {
          mode: "socket-helper",
          httpPort: DESIRED_HTTP_PORT,
          httpsPort: DESIRED_HTTPS_PORT,
          notices: [],
          fingerprint: lists.fingerprint,
        };
        yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
          ...decision,
          helperInstalled: true,
          socketsActive: true,
          bindHttpPort,
          bindHttpsPort,
        });
        return decision;
      }
    }
    if (linuxLike && preferredEacces(probed) && dependencies.socketProxy !== undefined) {
      const hops = yield* Effect.try({
        try: () =>
          chooseHelperBindPorts({
            httpBinds: probed.httpBinds,
            httpsBinds: probed.httpsBinds,
            ...(probed.httpHolders === undefined ? {} : { httpHolders: probed.httpHolders }),
            ...(probed.httpsHolders === undefined ? {} : { httpsHolders: probed.httpsHolders }),
          }),
        catch: (error) => error,
      }).pipe(Effect.either);
      if (hops._tag === "Right") {
        const resolved = yield* resolveNeedsHelper(dependencies.socketProxy, {
          httpTarget: hops.right.bindHttpPort,
          httpsTarget: hops.right.bindHttpsPort,
        });
        if (resolved.decision.mode === "socket-helper" && resolved.socketsActive) {
          const decision = { ...resolved.decision, fingerprint: lists.fingerprint };
          yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
            ...decision,
            helperInstalled: resolved.helperInstalled,
            socketsActive: resolved.socketsActive,
            bindHttpPort: hops.right.bindHttpPort,
            bindHttpsPort: hops.right.bindHttpsPort,
          });
          return decision;
        }
      }
    }
    if (
      previous !== undefined &&
      previousPair !== undefined &&
      fingerprintsEqual(previous.fingerprint, lists.fingerprint) &&
      (yield* stillOwnPersisted(dependencies, previousPair, probed, lists.bindAddress))
    ) {
      const notices =
        previous.mode === "occupied-hop"
          ? occupiedHopNotices({
              preferredHttp: lists.httpTryList[0] ?? previous.httpPort,
              preferredHttps: lists.httpsTryList[0] ?? previous.httpsPort,
              httpPort: previous.httpPort,
              httpsPort: previous.httpsPort,
              http: probed.http,
              https: probed.https,
            })
          : [];
      return {
        mode: previous.mode,
        httpPort: previous.httpPort,
        httpsPort: previous.httpsPort,
        notices,
        fingerprint: previous.fingerprint,
      };
    }
    const decision = yield* classifyOrFail({
      platform: dependencies.paths.platform,
      helperInstalled,
      socketsActive: false,
      http: probed.http,
      https: probed.https,
      httpBinds: probed.httpBinds,
      httpsBinds: probed.httpsBinds,
      httpTryList: lists.httpTryList,
      httpsTryList: lists.httpsTryList,
      bindAddress: lists.bindAddress,
    });
    yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
      ...decision,
      helperInstalled,
      socketsActive: false,
    });
    return decision;
  });
