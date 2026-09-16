import { Effect } from "effect";

import { RouterPortPinMismatch } from "@lando/sdk/errors";

import { type OccupiedPortHolderFields, fieldsFromPortHolder } from "./occupied-port-warning.ts";
import {
  type AcquisitionFingerprint,
  type BindOutcome,
  type ClassifyAcquisitionInput,
  DEFAULT_BACKEND_HTTPS_TRY_LIST,
  DEFAULT_BACKEND_HTTP_TRY_LIST,
  DEFAULT_HTTPS_TRY_LIST,
  DEFAULT_HTTP_TRY_LIST,
  DESIRED_HTTPS_PORT,
  DESIRED_HTTP_PORT,
  LOOPBACK_HOST,
  classifyAcquisition,
  isOurLoopbackForwarder,
  probeBind,
  probeTcpOpen,
  uniquePorts,
} from "./port-acquisition.ts";
import { identifyAnyPortHolder, systemdUnitForPid } from "./preferred-host-ports-linux.ts";
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
  readonly httpHolders?: Readonly<Record<number, string>>;
  readonly httpsHolders?: Readonly<Record<number, string>>;
};

export type PersistedPair = {
  readonly httpPort: number;
  readonly httpsPort: number;
  readonly helperInstalled: boolean;
  readonly socketsActive: boolean;
  readonly bindHttpPort?: number;
  readonly bindHttpsPort?: number;
};

const holderFieldsFor = (
  port: number,
  bind: BindOutcome,
): Effect.Effect<OccupiedPortHolderFields | undefined> =>
  bind.kind === "success"
    ? Effect.succeed(undefined)
    : Effect.promise(async () => {
        const found = await identifyAnyPortHolder(port);
        if (found === undefined) return undefined;
        return fieldsFromPortHolder(found, await systemdUnitForPid(found.pid));
      });

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

const completeOverrideBinds = (input: {
  readonly tryList: readonly number[];
  readonly preferred: number;
  readonly scheme: ClassifyAcquisitionInput["http"];
  readonly binds: Readonly<Record<number, BindOutcome>> | undefined;
}): Readonly<Record<number, BindOutcome>> => {
  if (input.binds !== undefined) {
    const completed: Record<number, BindOutcome> = { ...input.binds };
    for (const port of input.tryList) {
      if (completed[port] === undefined) completed[port] = { kind: "success" };
    }
    return completed;
  }
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
        tryList: uniquePorts(lists.httpTryList, DEFAULT_BACKEND_HTTP_TRY_LIST),
        preferred: lists.httpTryList[0] ?? DESIRED_HTTP_PORT,
        scheme: override.http,
        binds: override.httpBinds,
      }),
      httpsBinds: completeOverrideBinds({
        tryList: uniquePorts(lists.httpsTryList, DEFAULT_BACKEND_HTTPS_TRY_LIST),
        preferred: lists.httpsTryList[0] ?? DESIRED_HTTPS_PORT,
        scheme: override.https,
        binds: override.httpsBinds,
      }),
    });
  }
  return Effect.gen(function* () {
    const probe = dependencies.probeBind ?? probeBind;
    const httpBinds = yield* probeTryList(
      lists.bindAddress,
      uniquePorts(lists.httpTryList, DEFAULT_BACKEND_HTTP_TRY_LIST),
      probe,
    );
    const httpsBinds = yield* probeTryList(
      lists.bindAddress,
      uniquePorts(lists.httpsTryList, DEFAULT_BACKEND_HTTPS_TRY_LIST),
      probe,
    );
    const preferredHttp = lists.httpTryList[0] ?? DESIRED_HTTP_PORT;
    const preferredHttps = lists.httpsTryList[0] ?? DESIRED_HTTPS_PORT;
    const httpBind = httpBinds[preferredHttp] ?? { kind: "other-error" as const };
    const httpsBind = httpsBinds[preferredHttps] ?? { kind: "other-error" as const };
    const httpHolder = yield* holderFieldsFor(preferredHttp, httpBind);
    const httpsHolder = yield* holderFieldsFor(preferredHttps, httpsBind);
    const httpHolders: Record<number, string> = {};
    const httpsHolders: Record<number, string> = {};
    for (const port of DEFAULT_BACKEND_HTTP_TRY_LIST) {
      const bind = httpBinds[port];
      if (bind === undefined) continue;
      const fields = yield* holderFieldsFor(port, bind);
      if (fields !== undefined) httpHolders[port] = fields.holder;
    }
    for (const port of DEFAULT_BACKEND_HTTPS_TRY_LIST) {
      const bind = httpsBinds[port];
      if (bind === undefined) continue;
      const fields = yield* holderFieldsFor(port, bind);
      if (fields !== undefined) httpsHolders[port] = fields.holder;
    }
    return {
      http: {
        bind: httpBind,
        forward: { kind: "failure" as const },
        ...(httpHolder === undefined ? {} : httpHolder),
      },
      https: {
        bind: httpsBind,
        forward: { kind: "failure" as const },
        ...(httpsHolder === undefined ? {} : httpsHolder),
      },
      httpBinds,
      httpsBinds,
      ...(Object.keys(httpHolders).length > 0 ? { httpHolders } : {}),
      ...(Object.keys(httpsHolders).length > 0 ? { httpsHolders } : {}),
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
    const httpFields = yield* holderFieldsFor(previous.httpPort, httpBind);
    const httpsFields = yield* holderFieldsFor(previous.httpsPort, httpsBind);
    const httpHolder = httpFields?.holder;
    const httpsHolder = httpsFields?.holder;
    const helperOpen = previous.helperInstalled || previous.socketsActive;
    const publicOwned =
      stillOwnPort({
        bind: httpBind,
        holder: httpHolder,
        helperTcpOpen: helperOpen && (yield* probeTcpOpen(bindAddress, previous.httpPort)),
      }) &&
      stillOwnPort({
        bind: httpsBind,
        holder: httpsHolder,
        helperTcpOpen: helperOpen && (yield* probeTcpOpen(bindAddress, previous.httpsPort)),
      });
    if (!publicOwned) return false;
    for (const hop of [previous.bindHttpPort, previous.bindHttpsPort]) {
      if (hop === undefined) continue;
      const hopBind = yield* probe(bindAddress, hop);
      const hopFields = yield* holderFieldsFor(hop, hopBind);
      const hopHolder = hopFields?.holder;
      if (hopBind.kind === "success") continue;
      if (!stillOwnPort({ bind: hopBind, holder: hopHolder, helperTcpOpen: false })) {
        return false;
      }
    }
    return true;
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
