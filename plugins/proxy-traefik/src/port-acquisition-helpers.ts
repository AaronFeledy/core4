import { Effect } from "effect";

import { RouterPortPinMismatch } from "@lando/sdk/errors";

import { identifyLoopbackHolderComm } from "./leftover-proxy-ports-linux.ts";
import {
  type AcquisitionFingerprint,
  type BindOutcome,
  type ClassifyAcquisitionInput,
  DEFAULT_HTTPS_TRY_LIST,
  DEFAULT_HTTP_TRY_LIST,
  DESIRED_HTTPS_PORT,
  DESIRED_HTTP_PORT,
  LOOPBACK_HOST,
  classifyAcquisition,
  isOurLoopbackForwarder,
  probeBind,
  probeTcpOpen,
} from "./port-acquisition.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";

export type ResolvedTryLists = {
  readonly httpTryList: readonly number[];
  readonly httpsTryList: readonly number[];
  readonly bindAddress: string;
  readonly fingerprint: AcquisitionFingerprint;
};

export type ProbedAcquisition = {
  readonly http: ClassifyAcquisitionInput["http"];
  readonly https: ClassifyAcquisitionInput["https"];
  readonly httpBinds: Readonly<Record<number, BindOutcome>>;
  readonly httpsBinds: Readonly<Record<number, BindOutcome>>;
};

export type PersistedPair = {
  readonly httpPort: number;
  readonly httpsPort: number;
  readonly helperInstalled: boolean;
  readonly socketsActive: boolean;
};

const holderFor = (port: number, bind: BindOutcome): Effect.Effect<string | undefined> =>
  bind.kind === "EADDRINUSE"
    ? Effect.promise(() => identifyLoopbackHolderComm(port))
    : Effect.succeed(undefined);

export const fingerprintsEqual = (left: AcquisitionFingerprint, right: AcquisitionFingerprint): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const overlayTryList = (
  preferred: number | undefined,
  fallbacks: readonly number[] | undefined,
  defaults: readonly number[],
): readonly number[] => {
  const nextPreferred = preferred ?? defaults[0];
  if (nextPreferred === undefined) return defaults;
  return [nextPreferred, ...(fallbacks ?? defaults.slice(1))];
};

export const resolveTryLists = (dependencies: TraefikProxyDependencies): ResolvedTryLists => {
  const bindAddress =
    dependencies.fingerprint?.bindAddress ?? dependencies.router?.bindAddress ?? LOOPBACK_HOST;
  const httpTryList =
    dependencies.fingerprint?.http ??
    overlayTryList(dependencies.router?.httpPort, dependencies.router?.httpFallbacks, DEFAULT_HTTP_TRY_LIST);
  const httpsTryList =
    dependencies.fingerprint?.https ??
    overlayTryList(
      dependencies.router?.httpsPort,
      dependencies.router?.httpsFallbacks,
      DEFAULT_HTTPS_TRY_LIST,
    );
  const fingerprint = dependencies.fingerprint ?? {
    http: [...httpTryList],
    https: [...httpsTryList],
    bindAddress,
  };
  return { httpTryList, httpsTryList, bindAddress, fingerprint };
};

export const classifyOrFail = (input: ClassifyAcquisitionInput) =>
  Effect.try({
    try: () => classifyAcquisition(input),
    catch: (error) => error,
  });

const probeTryList = (
  host: string,
  tryList: readonly number[],
  probe: (host: string, port: number) => Effect.Effect<BindOutcome>,
): Effect.Effect<Readonly<Record<number, BindOutcome>>> =>
  Effect.gen(function* () {
    const binds: Record<number, BindOutcome> = {};
    for (const port of tryList) {
      binds[port] = yield* probe(host, port);
    }
    return binds;
  });

export const classifyInputFrom = (
  dependencies: TraefikProxyDependencies,
  lists: ResolvedTryLists,
  helperInstalled: boolean,
  socketsActive: boolean,
  probed: ProbedAcquisition,
): ClassifyAcquisitionInput => ({
  platform: dependencies.paths.platform,
  helperInstalled,
  socketsActive,
  http: probed.http,
  https: probed.https,
  httpBinds: probed.httpBinds,
  httpsBinds: probed.httpsBinds,
  httpTryList: lists.httpTryList,
  httpsTryList: lists.httpsTryList,
  bindAddress: lists.bindAddress,
});

const completeOverrideBinds = (input: {
  readonly tryList: readonly number[];
  readonly preferred: number;
  readonly scheme: ClassifyAcquisitionInput["http"];
  readonly binds: Readonly<Record<number, BindOutcome>> | undefined;
}): Readonly<Record<number, BindOutcome>> => {
  if (input.binds !== undefined) return input.binds;
  const preferredBind: BindOutcome =
    input.scheme.forward.kind === "success" ? { kind: "success" } : input.scheme.bind;
  const completed: Record<number, BindOutcome> = {};
  for (const port of input.tryList) {
    completed[port] = port === input.preferred ? preferredBind : { kind: "success" };
  }
  return completed;
};

export const probeCurrent = (
  dependencies: TraefikProxyDependencies,
  lists: ResolvedTryLists,
): Effect.Effect<ProbedAcquisition, unknown> => {
  const override = dependencies.socketProxy?.classifyOverride;
  if (override !== undefined) {
    return Effect.succeed({
      http: override.http,
      https: override.https,
      httpBinds: completeOverrideBinds({
        tryList: lists.httpTryList,
        preferred: lists.httpTryList[0] ?? DESIRED_HTTP_PORT,
        scheme: override.http,
        binds: override.httpBinds,
      }),
      httpsBinds: completeOverrideBinds({
        tryList: lists.httpsTryList,
        preferred: lists.httpsTryList[0] ?? DESIRED_HTTPS_PORT,
        scheme: override.https,
        binds: override.httpsBinds,
      }),
    });
  }
  return Effect.gen(function* () {
    const probe = dependencies.probeBind ?? probeBind;
    const httpBinds = yield* probeTryList(lists.bindAddress, lists.httpTryList, probe);
    const httpsBinds = yield* probeTryList(lists.bindAddress, lists.httpsTryList, probe);
    const preferredHttp = lists.httpTryList[0] ?? DESIRED_HTTP_PORT;
    const preferredHttps = lists.httpsTryList[0] ?? DESIRED_HTTPS_PORT;
    const httpBind = httpBinds[preferredHttp] ?? { kind: "other-error" as const };
    const httpsBind = httpsBinds[preferredHttps] ?? { kind: "other-error" as const };
    const httpHolder = yield* holderFor(preferredHttp, httpBind);
    const httpsHolder = yield* holderFor(preferredHttps, httpsBind);
    return {
      http: {
        bind: httpBind,
        forward: { kind: "failure" as const },
        ...(httpHolder === undefined ? {} : { holder: httpHolder }),
      },
      https: {
        bind: httpsBind,
        forward: { kind: "failure" as const },
        ...(httpsHolder === undefined ? {} : { holder: httpsHolder }),
      },
      httpBinds,
      httpsBinds,
    };
  });
};

const stillOwnPort = (input: {
  readonly bind: BindOutcome | undefined;
  readonly holder: string | undefined;
  readonly helperTcpOpen: boolean;
}): boolean => {
  if (input.bind?.kind !== "EADDRINUSE") return false;
  if (input.holder !== undefined && isOurLoopbackForwarder(input.holder)) return true;
  return input.helperTcpOpen;
};

const overrideOwned = (scheme: ClassifyAcquisitionInput["http"], bind: BindOutcome | undefined): boolean =>
  stillOwnPort({
    bind,
    holder: scheme.holder,
    helperTcpOpen:
      scheme.forward.kind === "success" && scheme.holder !== undefined
        ? isOurLoopbackForwarder(scheme.holder)
        : false,
  });

export const stillOwnPersisted = (
  dependencies: TraefikProxyDependencies,
  previous: PersistedPair,
  probed: ProbedAcquisition,
  bindAddress: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const override = dependencies.socketProxy?.classifyOverride;
    if (override !== undefined) {
      return (
        overrideOwned(override.http, probed.httpBinds[previous.httpPort]) &&
        overrideOwned(override.https, probed.httpsBinds[previous.httpsPort])
      );
    }
    const probe = dependencies.probeBind ?? probeBind;
    const httpBind = yield* probe(bindAddress, previous.httpPort);
    const httpsBind = yield* probe(bindAddress, previous.httpsPort);
    const httpHolder = yield* holderFor(previous.httpPort, httpBind);
    const httpsHolder = yield* holderFor(previous.httpsPort, httpsBind);
    const helperOpen = previous.helperInstalled || previous.socketsActive;
    return (
      stillOwnPort({
        bind: httpBind,
        holder: httpHolder,
        helperTcpOpen: helperOpen && (yield* probeTcpOpen(bindAddress, previous.httpPort)),
      }) &&
      stillOwnPort({
        bind: httpsBind,
        holder: httpsHolder,
        helperTcpOpen: helperOpen && (yield* probeTcpOpen(bindAddress, previous.httpsPort)),
      })
    );
  });

export const pinMismatch = (
  previous: PersistedPair,
  pin: NonNullable<TraefikProxyDependencies["routerPin"]>,
): RouterPortPinMismatch =>
  new RouterPortPinMismatch({
    message: "Landofile router pin does not match the persisted host-router pair.",
    proxyId: "traefik",
    runningHttp: previous.httpPort,
    runningHttps: previous.httpsPort,
    ...(pin.httpPort === undefined ? {} : { requestedHttp: pin.httpPort }),
    ...(pin.httpsPort === undefined ? {} : { requestedHttps: pin.httpsPort }),
    remediation: "Align router.httpPort/httpsPort with the running pair or run lando global:restart.",
  });

export const pinDiffers = (
  previous: PersistedPair,
  pin: NonNullable<TraefikProxyDependencies["routerPin"]>,
): boolean =>
  (pin.httpPort !== undefined && pin.httpPort !== previous.httpPort) ||
  (pin.httpsPort !== undefined && pin.httpsPort !== previous.httpsPort);

export const preferredEacces = (probed: ProbedAcquisition): boolean => {
  const httpBind = probed.httpBinds[DESIRED_HTTP_PORT] ?? probed.http.bind;
  const httpsBind = probed.httpsBinds[DESIRED_HTTPS_PORT] ?? probed.https.bind;
  return httpBind.kind === "EACCES" || httpsBind.kind === "EACCES";
};
