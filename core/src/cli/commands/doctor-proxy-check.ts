import { join } from "node:path";

import { Effect, Either, Schema } from "effect";

import { PortNumber } from "@lando/sdk/schema";
import { FileSystem, PathsService, type RouterService } from "@lando/sdk/services";

import { resolveProxyDefaultDomain } from "@lando/engine/config/proxy-default-domain";
import { resolveRouterConfigForApp } from "@lando/engine/config/router-config";
import type { DoctorSolution } from "./doctor-contract";
import {
  type DoctorSubsystemCheck,
  PROXY_SPEC,
  type SubsystemSpec,
  buildDegradedCheck,
  isReadySubsystemId,
  passCheck,
} from "./doctor-subsystem-checks";

const ACQUISITION_MODES = ["direct", "occupied-hop", "needs-helper", "socket-helper"] as const;
type AcquisitionMode = (typeof ACQUISITION_MODES)[number];

const LAST_FALLBACK_HTTP = 38080;
const LAST_FALLBACK_HTTPS = 38443;

const OCCUPIED_HOP_REMEDIATION =
  "port in use by another program; Lando is serving on high ports instead of 80/443.";

interface AcquisitionSnapshot {
  readonly mode: AcquisitionMode;
  readonly httpPort: number;
  readonly httpsPort: number;
}

const isAcquisitionMode = (value: unknown): value is AcquisitionMode =>
  ACQUISITION_MODES.some((mode) => mode === value);

const decodePort = (value: unknown): number | undefined => {
  const decoded = Schema.decodeUnknownEither(PortNumber)(value);
  return Either.isRight(decoded) ? decoded.right : undefined;
};

const readAcquisitionSnapshot = (): Effect.Effect<AcquisitionSnapshot | undefined> =>
  Effect.gen(function* () {
    const paths = yield* Effect.serviceOption(PathsService);
    const fileSystem = yield* Effect.serviceOption(FileSystem);
    if (paths._tag === "None" || fileSystem._tag === "None") return undefined;
    const stateFile = join(
      paths.value.globalAppRoot,
      "proxy-traefik",
      "dynamic",
      ".lando-port-acquisition.json",
    );
    const text = yield* fileSystem.value
      .readText(stateFile)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (text === undefined) return undefined;
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (typeof parsed !== "object" || parsed === null || !("mode" in parsed)) return undefined;
    if (!isAcquisitionMode(parsed.mode)) return undefined;
    const httpPort = decodePort("httpPort" in parsed ? parsed.httpPort : undefined) ?? LAST_FALLBACK_HTTP;
    const httpsPort = decodePort("httpsPort" in parsed ? parsed.httpsPort : undefined) ?? LAST_FALLBACK_HTTPS;
    return { mode: parsed.mode, httpPort, httpsPort };
  });

const liveProxyStateContext = (
  proxy: typeof RouterService.Service,
  acquisitionMode: AcquisitionMode | undefined,
): Effect.Effect<Record<string, string>, never> =>
  Effect.map(Effect.either(proxy.status), (status) => ({
    ...(Either.isRight(status) ? { state: status.right.state } : {}),
    ...(acquisitionMode === undefined ? {} : { acquisitionMode }),
  }));

const specForMode = (snapshot: AcquisitionSnapshot | undefined): SubsystemSpec => {
  if (snapshot === undefined) return PROXY_SPEC;
  switch (snapshot.mode) {
    case "needs-helper":
      return {
        ...PROXY_SPEC,
        automaticRemediation: `URLs carry :${snapshot.httpPort}/:${snapshot.httpsPort}; run lando doctor --fix to enable 80/443 (admin access may be requested)`,
      };
    case "occupied-hop":
      return {
        ...PROXY_SPEC,
        recovery: "manual",
        manualRemediation: OCCUPIED_HOP_REMEDIATION,
        manualCommand: "lando doctor",
      };
    case "direct":
    case "socket-helper":
      return PROXY_SPEC;
    default: {
      const exhaustive: never = snapshot.mode;
      return exhaustive;
    }
  }
};

const occupiedHopCheck = (context: Record<string, string>): DoctorSubsystemCheck => {
  const solution: DoctorSolution = {
    kind: "manual",
    description: OCCUPIED_HOP_REMEDIATION,
    command: "lando doctor",
  };
  return {
    name: PROXY_SPEC.name,
    status: "warn",
    severity: "warn",
    recovery: "manual",
    context,
    solutions: [solution],
  };
};

export const buildProxyCheck = (
  proxy: typeof RouterService.Service,
  fix: boolean,
): Effect.Effect<DoctorSubsystemCheck, never> =>
  Effect.gen(function* () {
    const status = yield* Effect.either(proxy.status);
    const state = Either.isRight(status) ? status.right.state : undefined;
    const snapshot = yield* readAcquisitionSnapshot();
    const acquisitionMode = snapshot?.mode;
    const running = isReadySubsystemId(proxy.id) && state === "running";
    const context: Record<string, string> = {
      subsystem: "router",
      subsystemId: proxy.id,
      ready: String(running),
      ...(state === undefined ? {} : { state }),
      ...(acquisitionMode === undefined ? {} : { acquisitionMode }),
    };
    if (running && acquisitionMode === "occupied-hop") return occupiedHopCheck(context);
    const needsHelper = acquisitionMode === "needs-helper";
    if (running && !needsHelper) return passCheck(PROXY_SPEC, context);
    return yield* buildDegradedCheck(
      specForMode(snapshot),
      context,
      fix,
      () =>
        Effect.gen(function* () {
          const defaultDomain = yield* resolveProxyDefaultDomain;
          const { router, routerPin } = yield* resolveRouterConfigForApp();
          yield* Effect.scoped(proxy.setup({ defaultDomain, router, routerPin }));
          const after = yield* readAcquisitionSnapshot();
          if (after?.mode === "needs-helper" || after?.mode === "occupied-hop") {
            return yield* Effect.fail(new Error("Router is still serving on high ports after setup."));
          }
        }),
      Either.isLeft(status) ? status.left : undefined,
      () =>
        Effect.gen(function* () {
          const after = yield* readAcquisitionSnapshot();
          return yield* liveProxyStateContext(proxy, after?.mode);
        }),
    );
  });
