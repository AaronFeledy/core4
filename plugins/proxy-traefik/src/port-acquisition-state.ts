import { Effect, Schema } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import { PortNumber } from "@lando/sdk/schema";

import { foreignSocketProxyNotice } from "./socket-proxy-helper.ts";

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
  ownedRouterPorts,
  reclaimRouterPorts,
  usableHelperHopTargets,
} from "./port-acquisition-ownership.ts";
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
import {
  classifySocketProxy,
  isSocketProxyInstalled,
  readAnyHelperHopTargets,
  stopSockets,
} from "./socket-proxy-install.ts";
import { resolveNeedsHelper } from "./socket-proxy-setup.ts";

const AcquisitionFingerprintSchema = Schema.Struct({
  http: Schema.Array(PortNumber),
  https: Schema.Array(PortNumber),
  bindAddress: Schema.String,
});

export const AcquisitionState = Schema.Struct({
  mode: Schema.Literals([...ACQUISITION_MODES]),
  httpPort: PortNumber,
  httpsPort: PortNumber,
  notices: Schema.Array(Schema.String),
  fingerprint: AcquisitionFingerprintSchema,
  appliedFingerprint: Schema.optionalKey(AcquisitionFingerprintSchema),
  helperInstalled: Schema.optionalKey(Schema.Boolean),
  socketsActive: Schema.optionalKey(Schema.Boolean),
  bindHttpPort: Schema.optionalKey(PortNumber),
  bindHttpsPort: Schema.optionalKey(PortNumber),
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
    Effect.catch(() => Effect.succeed(undefined)),
  );

/** Strip setup/removal recipes before writing acquisition state (never replay sudo recipes on start). */
const noticesForPersistence = (notices: readonly string[]): readonly string[] =>
  notices.filter((notice) => !notice.includes("sudo systemctl") && !notice.includes("sudo rm"));

/**
 * Start/ensure: append at most one foreign-helper clause to the existing fallback notice.
 * Configure keeps full explanation/commands as separate notices for the setup surface.
 */
const displayAcquisitionNotices = (
  hopNotices: readonly string[],
  helperNotices: readonly string[],
  intent: "configure" | "ensure" | undefined,
): readonly string[] => {
  if (helperNotices.length === 0) return hopNotices;
  if (intent === "configure") {
    return [...helperNotices, ...hopNotices];
  }
  const clause = helperNotices[0]?.trim();
  if (clause === undefined || clause.length === 0) return hopNotices;
  if (hopNotices.length === 0) return [clause];
  const out = [...hopNotices];
  const last = out.length - 1;
  const base = out[last] ?? "";
  // One clause only; do not introduce a second notice or removal recipe.
  out[last] = base.includes(clause) ? base : `${base} ${clause}`;
  return out;
};

const isOurPreferredHolder = (probe: {
  readonly holder?: string;
  readonly holderSystemdUnit?: string;
}): boolean => isOurSocketHelperHolder(probe);

const helperOwnsPreferred = (probed: ProbedAcquisition): boolean =>
  isOurPreferredHolder(probed.http) && isOurPreferredHolder(probed.https);

const compatibleOwnedPair = (
  previous: AcquisitionState,
  current: ReturnType<typeof resolveTryLists>,
): boolean =>
  previous.fingerprint.bindAddress === current.fingerprint.bindAddress &&
  previous.fingerprint.http[0] === current.fingerprint.http[0] &&
  previous.fingerprint.https[0] === current.fingerprint.https[0] &&
  current.httpTryList.includes(previous.httpPort) &&
  current.httpsTryList.includes(previous.httpsPort);

export const persistPortAcquisition = Effect.fn("TraefikRouter.persistPortAcquisition")(function* (
  dependencies: TraefikProxyDependencies,
  options: { readonly rescan?: boolean } = {},
): Effect.fn.Return<AcquisitionDecision, unknown> {
  const lists = resolveTryLists(dependencies);
  const previous = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
  const applied =
    previous?.appliedFingerprint === undefined ? {} : { appliedFingerprint: previous.appliedFingerprint };
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
  let helperInstalled =
    dependencies.socketProxy === undefined ? false : yield* isSocketProxyInstalled(dependencies.socketProxy);
  const probed = yield* probeCurrent(dependencies, lists);
  const linuxLike = dependencies.paths.platform === "linux" || dependencies.paths.platform === "wsl";
  const canUseHelper = linuxLike && lists.bindAddress === "127.0.0.1";
  if (canUseHelper && helperInstalled && helperOwnsPreferred(probed)) {
    const targets = yield* usableHelperHopTargets(dependencies, probed, lists.bindAddress);
    if (targets !== undefined) {
      const decision: AcquisitionDecision = {
        mode: "socket-helper",
        httpPort: DESIRED_HTTP_PORT,
        httpsPort: DESIRED_HTTPS_PORT,
        notices: [],
        fingerprint: lists.fingerprint,
      };
      yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
        ...decision,
        ...applied,
        helperInstalled: true,
        socketsActive: true,
        bindHttpPort: targets.httpTarget,
        bindHttpsPort: targets.httpsTarget,
      });
      return decision;
    }
  }
  const helperOwnership =
    dependencies.socketProxy === undefined
      ? { kind: "absent" as const }
      : yield* classifySocketProxy(dependencies.socketProxy);
  const helperForeign = helperOwnership.kind === "foreign" || helperOwnership.kind === "unmarked";
  const configureForeign = helperForeign && dependencies.socketProxy?.intent === "configure";
  const helperMarked =
    helperOwnership.kind === "owned" ||
    (helperOwnership.kind === "foreign" && helperOwnership.reason !== "mixed");
  let helperFallbackNotices: readonly string[] =
    canUseHelper && helperForeign
      ? [
          foreignSocketProxyNotice(
            helperOwnership,
            dependencies.socketProxy?.intent === "configure" ? "commands" : "brief",
          ),
        ].filter((notice) => notice.length > 0)
      : [];
  const repairOwnedHelper =
    helperOwnership.kind === "owned" && helperInstalled && helperOwnsPreferred(probed);
  if (
    canUseHelper &&
    (!helperForeign || configureForeign) &&
    (preferredEacces(probed) || repairOwnedHelper || configureForeign) &&
    dependencies.socketProxy !== undefined
  ) {
    if (repairOwnedHelper) {
      const stopped = yield* stopSockets(dependencies.socketProxy);
      if (stopped.kind === "failed") {
        return yield* Effect.fail(
          new ProxyError({
            proxyId: "traefik",
            message:
              "The owned socket helper forwards to ports this data root cannot use and could not be stopped.",
            remediation:
              "Allow Lando to stop its helper, or run `sudo systemctl stop lando-proxy-http.socket lando-proxy-https.socket lando-proxy-http.service lando-proxy-https.service`, then retry.",
          }),
        );
      }
    }
    const backendOccupied = [...Object.entries(probed.httpBinds), ...Object.entries(probed.httpsBinds)]
      .filter(([, bind]) => bind.kind === "EADDRINUSE")
      .map(([port]) => Number(port));
    const priorTargets = configureForeign
      ? yield* readAnyHelperHopTargets(dependencies.socketProxy)
      : undefined;
    const ownedBackends = yield* ownedRouterPorts(dependencies, [
      ...backendOccupied,
      ...(priorTargets === undefined ? [] : [priorTargets.httpTarget, priorTargets.httpsTarget]),
    ]);
    const hops = yield* Effect.try({
      try: () =>
        chooseHelperBindPorts({
          httpBinds: probed.httpBinds,
          httpsBinds: probed.httpsBinds,
          ownedPorts: ownedBackends,
        }),
      catch: (error) => error,
    }).pipe(Effect.result);
    if (hops._tag === "Success") {
      const resolved = yield* resolveNeedsHelper(
        {
          ...dependencies.socketProxy,
          ownedRouterPorts: ownedBackends,
        },
        {
          httpTarget: hops.success.bindHttpPort,
          httpsTarget: hops.success.bindHttpsPort,
        },
      );
      helperInstalled = resolved.helperInstalled;
      if (resolved.decision.mode === "socket-helper" && resolved.socketsActive) {
        const decision = { ...resolved.decision, fingerprint: lists.fingerprint };
        yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
          ...decision,
          ...applied,
          notices: [...noticesForPersistence(decision.notices)],
          helperInstalled: resolved.helperInstalled,
          socketsActive: resolved.socketsActive,
          bindHttpPort: hops.success.bindHttpPort,
          bindHttpsPort: hops.success.bindHttpsPort,
        });
        return decision;
      }
      helperFallbackNotices = resolved.decision.notices;
    }
  }
  if (
    options.rescan !== true &&
    previous !== undefined &&
    previousPair !== undefined &&
    (previous.mode !== "socket-helper" || (canUseHelper && helperInstalled)) &&
    compatibleOwnedPair(previous, lists) &&
    (yield* stillOwnPersisted(dependencies, previousPair, probed, lists.bindAddress))
  ) {
    const notices = displayAcquisitionNotices(
      previous.mode === "occupied-hop"
        ? occupiedHopNotices({
            preferredHttp: lists.httpTryList[0] ?? previous.httpPort,
            preferredHttps: lists.httpsTryList[0] ?? previous.httpsPort,
            httpPort: previous.httpPort,
            httpsPort: previous.httpsPort,
            http: { ...probed.http, socketProxyMarked: helperMarked },
            https: { ...probed.https, socketProxyMarked: helperMarked },
          })
        : [],
      helperFallbackNotices,
      dependencies.socketProxy?.intent,
    );
    const persistedNotices = noticesForPersistence(notices);
    if (
      !fingerprintsEqual(previous.fingerprint, lists.fingerprint) ||
      previous.helperInstalled !== helperInstalled ||
      JSON.stringify(previous.notices) !== JSON.stringify(persistedNotices)
    ) {
      yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
        ...previous,
        fingerprint: lists.fingerprint,
        notices: [...persistedNotices],
        helperInstalled,
      });
    }
    return {
      mode: previous.mode,
      httpPort: previous.httpPort,
      httpsPort: previous.httpsPort,
      notices,
      fingerprint: lists.fingerprint,
    };
  }
  const available = yield* reclaimRouterPorts(dependencies, probed, {
    http: lists.httpTryList[0] ?? DESIRED_HTTP_PORT,
    https: lists.httpsTryList[0] ?? DESIRED_HTTPS_PORT,
  });
  const classified = yield* classifyOrFail({
    platform: dependencies.paths.platform,
    helperInstalled,
    socketsActive: false,
    http: { ...available.http, socketProxyMarked: helperMarked },
    https: { ...available.https, socketProxyMarked: helperMarked },
    httpBinds: available.httpBinds,
    httpsBinds: available.httpsBinds,
    httpTryList: lists.httpTryList,
    httpsTryList: lists.httpsTryList,
    bindAddress: lists.bindAddress,
  });
  const notices = displayAcquisitionNotices(
    classified.notices,
    helperFallbackNotices,
    dependencies.socketProxy?.intent,
  );
  const decision = {
    ...classified,
    notices,
  };
  yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
    ...decision,
    ...applied,
    notices: [...noticesForPersistence(notices)],
    helperInstalled,
    socketsActive: false,
  });
  return decision;
});
