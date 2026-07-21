import { type Context, Effect, Layer } from "effect";

import { GlobalAppError, LandofileValidationError } from "@lando/sdk/errors";
import type {
  AppPlan,
  PortNumber,
  ProviderCapabilities,
  RouteAuthorityPorts,
  ServiceName,
} from "@lando/sdk/schema";
import { AppPlanResolver, AppPlanner, FileSystem, GlobalAppService } from "@lando/sdk/services";

import { loadLandofileLayers } from "../landofile/service.ts";
import { withProcessCwd } from "../runtime/process-cwd.ts";

type AuthorityProtocol = keyof RouteAuthorityPorts;
type AuthorityCandidate = {
  readonly service: ServiceName;
  readonly port: PortNumber;
};

const authorityValidationError = (plan: AppPlan, issue: string): LandofileValidationError =>
  new LandofileValidationError({
    message: `Global route authority endpoints are ambiguous: ${issue}.`,
    file: `${plan.root}/.lando.yml`,
    issues: [issue],
  });

const isAuthorityValidationError = (cause: unknown): cause is LandofileValidationError =>
  cause instanceof LandofileValidationError &&
  cause.message.startsWith("Global route authority endpoints are ambiguous:");

export const deriveRouteAuthorityPorts = (
  plan: AppPlan,
): Effect.Effect<RouteAuthorityPorts | undefined, LandofileValidationError> => {
  const candidates = new Map<AuthorityProtocol, Map<string, AuthorityCandidate>>([
    ["http", new Map()],
    ["https", new Map()],
  ]);

  for (const service of Object.values(plan.services)) {
    for (const endpoint of service.endpoints) {
      if (endpoint.protocol !== "http" && endpoint.protocol !== "https") continue;
      const port = endpoint.publishedPort ?? endpoint.port;
      if (port === undefined) continue;
      candidates.get(endpoint.protocol)?.set(`${service.name}:${port}`, { service: service.name, port });
    }
  }

  const resolved = new Map<AuthorityProtocol, AuthorityCandidate>();
  for (const protocol of ["http", "https"] as const) {
    const protocolCandidates = [...(candidates.get(protocol)?.values() ?? [])];
    if (protocolCandidates.length > 1) {
      return Effect.fail(
        authorityValidationError(
          plan,
          `${protocol} resolves to ${protocolCandidates.map(({ service, port }) => `${service}:${port}`).join(", ")}`,
        ),
      );
    }
    const candidate = protocolCandidates[0];
    if (candidate !== undefined) resolved.set(protocol, candidate);
  }

  const http = resolved.get("http");
  const https = resolved.get("https");
  if (http !== undefined && https !== undefined && http.service !== https.service) {
    return Effect.fail(
      authorityValidationError(
        plan,
        `http belongs to ${http.service} while https belongs to ${https.service}`,
      ),
    );
  }
  if (http === undefined && https === undefined) return Effect.succeed(undefined);
  return Effect.succeed({
    ...(http === undefined ? {} : { http: http.port }),
    ...(https === undefined ? {} : { https: https.port }),
  });
};

export const AppPlanResolverLive = Layer.effect(
  AppPlanResolver,
  Effect.gen(function* () {
    const planner = yield* AppPlanner;
    const fileSystem = yield* FileSystem;
    const globalApp = yield* GlobalAppService;

    const global = (providerCapabilities: ProviderCapabilities) =>
      Effect.gen(function* () {
        const paths = yield* globalApp.paths;
        const exists = yield* fileSystem.exists(paths.distLandofile);
        if (!exists) return { materialized: false as const, paths };

        const landofile = yield* loadLandofileLayers(paths.root, paths.distLandofile);
        const plan = yield* withProcessCwd(
          paths.root,
          Effect.suspend(() => planner.plan(landofile, providerCapabilities, { kind: "global" })),
          (cause) =>
            new GlobalAppError({
              message: `Unable to enter the global app directory at ${paths.root}.`,
              operation: "loadPlan",
              cause,
            }),
        );
        const routeAuthorityPorts = yield* deriveRouteAuthorityPorts(plan);
        return {
          materialized: true as const,
          paths,
          landofile,
          plan,
          ...(routeAuthorityPorts === undefined ? {} : { routeAuthorityPorts }),
        };
      });

    return {
      global,
      plan: (landofile, providerCapabilities, options) =>
        global(providerCapabilities).pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              isAuthorityValidationError(cause) ? Effect.fail(cause) : Effect.succeed(undefined),
            onSuccess: Effect.succeed,
          }),
          Effect.flatMap((resolved) =>
            planner.plan(landofile, providerCapabilities, {
              kind: options.kind,
              ...(resolved?.materialized === true && resolved.routeAuthorityPorts !== undefined
                ? { routeAuthorityPorts: resolved.routeAuthorityPorts }
                : {}),
            }),
          ),
        ),
    } satisfies Context.Tag.Service<typeof AppPlanResolver>;
  }),
);
