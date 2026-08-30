import { join } from "node:path";

import { Effect, Either } from "effect";

import { FileSystem, PathsService, type ProxyService } from "@lando/sdk/services";

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

const OCCUPIED_HOP_REMEDIATION =
  "port in use by another program; Lando is serving on high ports instead of 80/443.";
const DEGRADED_HIGH_PORTS_REMEDIATION =
  "URLs carry :38080/:38443; run lando doctor --fix to enable 80/443 (admin access may be requested)";

const isAcquisitionMode = (value: unknown): value is AcquisitionMode => {
  for (const mode of ACQUISITION_MODES) {
    if (mode === value) return true;
  }
  return false;
};

const readAcquisitionMode = (): Effect.Effect<AcquisitionMode | undefined> =>
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
    return isAcquisitionMode(parsed.mode) ? parsed.mode : undefined;
  });

const liveProxyStateContext = (
  proxy: typeof ProxyService.Service,
  acquisitionMode: AcquisitionMode | undefined,
): Effect.Effect<Record<string, string>, never> =>
  Effect.map(Effect.either(proxy.status), (status) => ({
    ...(Either.isRight(status) ? { state: status.right.state } : {}),
    ...(acquisitionMode === undefined ? {} : { acquisitionMode }),
  }));

const specForMode = (mode: AcquisitionMode | undefined): SubsystemSpec => {
  switch (mode) {
    case "needs-helper":
      return { ...PROXY_SPEC, automaticRemediation: DEGRADED_HIGH_PORTS_REMEDIATION };
    case "occupied-hop":
      return {
        ...PROXY_SPEC,
        recovery: "manual",
        manualRemediation: OCCUPIED_HOP_REMEDIATION,
        manualCommand: "lando doctor",
      };
    case "direct":
    case "socket-helper":
    case undefined:
      return PROXY_SPEC;
    default: {
      const exhaustive: never = mode;
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
  proxy: typeof ProxyService.Service,
  fix: boolean,
): Effect.Effect<DoctorSubsystemCheck, never> =>
  Effect.gen(function* () {
    const status = yield* Effect.either(proxy.status);
    const state = Either.isRight(status) ? status.right.state : undefined;
    const acquisitionMode = yield* readAcquisitionMode();
    const running = isReadySubsystemId(proxy.id) && state === "running";
    const context: Record<string, string> = {
      subsystem: "proxy",
      subsystemId: proxy.id,
      ready: String(running),
      ...(state === undefined ? {} : { state }),
      ...(acquisitionMode === undefined ? {} : { acquisitionMode }),
    };
    if (running && acquisitionMode === "occupied-hop") return occupiedHopCheck(context);
    const needsHelper = acquisitionMode === "needs-helper";
    if (running && !needsHelper) return passCheck(PROXY_SPEC, context);
    return yield* buildDegradedCheck(
      specForMode(acquisitionMode),
      context,
      fix,
      () =>
        Effect.gen(function* () {
          const defaultDomain = yield* resolveProxyDefaultDomain;
          const { router, routerPin } = yield* resolveRouterConfigForApp();
          yield* Effect.scoped(proxy.setup({ defaultDomain, router, routerPin }));
          const after = yield* readAcquisitionMode();
          if (after === "needs-helper" || after === "occupied-hop") {
            return yield* Effect.fail(new Error("Proxy is still serving on high ports after setup."));
          }
        }),
      Either.isLeft(status) ? status.left : undefined,
      () =>
        Effect.gen(function* () {
          const after = yield* readAcquisitionMode();
          return yield* liveProxyStateContext(proxy, after);
        }),
    );
  });
