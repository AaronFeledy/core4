import { DateTime, Effect, Schema } from "effect";

import type { InfoAppError } from "@lando/sdk/app";
import type { EventError, ShellExecError } from "@lando/sdk/errors";
import { HostProxyOpenUrlSchemeError, OpenTargetUnresolvedError } from "@lando/sdk/errors";
import { PostOpenUrlEvent, PreOpenUrlEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef, EndpointPlan, RoutePlan, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  LandofileService,
  RuntimeProviderRegistry,
  type ShellRunner,
} from "@lando/sdk/services";

import { RedactionService } from "../../redaction/service.ts";
import { canOpenHost, openUrl } from "../../services/host-opener.ts";
import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution.ts";
import type { RenderContext } from "../renderer-boundary.ts";

export const OpenTargetSchema = Schema.Struct({
  service: Schema.String,
  hostname: Schema.String,
  scheme: Schema.Literal("http", "https"),
  url: Schema.String,
});
export type OpenTarget = typeof OpenTargetSchema.Type;

export const OpenLaunchOutcome = Schema.Literal("opened", "printed", "headless-degraded");
export type OpenLaunchOutcome = typeof OpenLaunchOutcome.Type;

export const OpenAppResultSchema = Schema.Struct({
  app: Schema.String,
  targets: Schema.Array(OpenTargetSchema),
  launch: OpenLaunchOutcome,
  note: Schema.optional(Schema.String),
});
export type OpenAppResult = typeof OpenAppResultSchema.Type;

export interface OpenTargetSelection {
  readonly service?: string;
  readonly route?: string;
  readonly all?: boolean;
}

type ResolvablePlan = Pick<AppPlan, "services" | "routes">;

const OPENABLE_SCHEMES = new Set(["http:", "https:"]);

export const isOpenableScheme = (url: string): boolean => {
  try {
    return OPENABLE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

export const buildOpenTarget = (route: RoutePlan): OpenTarget => {
  const scheme = route.scheme === "http" ? "http" : "https";
  return {
    service: String(route.service),
    hostname: route.hostname,
    scheme,
    url: `${scheme}://${route.hostname}${route.pathPrefix ?? ""}`,
  };
};

const endpointOpenTarget = (service: ServicePlan, endpoint: EndpointPlan): OpenTarget | undefined => {
  if ((endpoint.protocol !== "http" && endpoint.protocol !== "https") || endpoint.port === undefined)
    return undefined;
  return {
    service: String(service.name),
    hostname: "localhost",
    scheme: endpoint.protocol,
    url: `${endpoint.protocol}://localhost:${endpoint.port}`,
  };
};

const routesForService = (plan: ResolvablePlan, service: string): RoutePlan[] =>
  plan.routes.filter((route) => String(route.service) === service);

const preferHttps = (routes: ReadonlyArray<RoutePlan>): RoutePlan | undefined =>
  routes.find((route) => route.scheme === "https" || route.scheme === "both") ?? routes[0];

const endpointTargetsForService = (plan: ResolvablePlan, serviceName: string): OpenTarget[] => {
  const service = Object.values(plan.services).find((candidate) => String(candidate.name) === serviceName);
  if (service === undefined) return [];
  return service.endpoints.flatMap((endpoint) => {
    const target = endpointOpenTarget(service, endpoint);
    return target === undefined ? [] : [target];
  });
};

const preferHttpsTarget = (targets: ReadonlyArray<OpenTarget>): OpenTarget | undefined =>
  targets.find((target) => target.scheme === "https") ?? targets[0];

export const resolveOpenTargets = (
  plan: ResolvablePlan,
  selection: OpenTargetSelection,
): ReadonlyArray<OpenTarget> => {
  if (selection.route !== undefined) {
    const match = plan.routes.find((route) => route.hostname === selection.route);
    return match === undefined ? [] : [buildOpenTarget(match)];
  }
  if (selection.all === true) {
    if (plan.routes.length > 0) return plan.routes.map(buildOpenTarget);
    return Object.values(plan.services).flatMap((service) =>
      endpointTargetsForService(plan, String(service.name)),
    );
  }
  if (selection.service !== undefined) {
    const chosen = preferHttps(routesForService(plan, selection.service));
    if (chosen !== undefined) return [buildOpenTarget(chosen)];
    const endpoint = preferHttpsTarget(endpointTargetsForService(plan, selection.service));
    return endpoint === undefined ? [] : [endpoint];
  }
  for (const service of Object.values(plan.services)) {
    const routes = routesForService(plan, String(service.name));
    const chosen = preferHttps(routes);
    if (chosen !== undefined) return [buildOpenTarget(chosen)];
  }
  for (const service of Object.values(plan.services)) {
    const endpoint = preferHttpsTarget(endpointTargetsForService(plan, String(service.name)));
    if (endpoint !== undefined) return [endpoint];
  }
  return [];
};

export interface OpenAppOptions {
  readonly service?: string;
  readonly route?: string;
  readonly all?: boolean;
  readonly print?: boolean;
  readonly json?: boolean;
  readonly ttyPresent?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface OpenFlags {
  readonly service?: string;
  readonly route?: string;
  readonly all?: boolean;
  readonly print?: boolean;
  readonly format?: string;
}

const flagsFromInput = (input: unknown): OpenFlags =>
  typeof input === "object" && input !== null ? ((input as { readonly flags?: OpenFlags }).flags ?? {}) : {};

export const openOptionsFromInput = (input: unknown): OpenAppOptions => {
  const flags = flagsFromInput(input);
  return {
    ...(flags.service === undefined ? {} : { service: flags.service }),
    ...(flags.route === undefined ? {} : { route: flags.route }),
    ...(flags.all === undefined ? {} : { all: flags.all }),
    ...(flags.print === undefined ? {} : { print: flags.print }),
    json: flags.format === "json",
    ttyPresent: process.stdout.isTTY === true,
  };
};

export type OpenAppError =
  | OpenTargetUnresolvedError
  | HostProxyOpenUrlSchemeError
  | ShellExecError
  | EventError;

const HEADLESS_NOTE = "No display server detected; printing the URL instead of opening a browser.";

const openAppRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

const openNow = () => DateTime.unsafeMake(new Date().toISOString());

export const openForPlan = (
  plan: AppPlan,
  options: OpenAppOptions = {},
): Effect.Effect<OpenAppResult, OpenAppError, ShellRunner | EventService | RedactionService> =>
  Effect.gen(function* () {
    const targets = resolveOpenTargets(plan, options);
    if (targets.length === 0) {
      const knownServices = Object.values(plan.services).map((service) => String(service.name));
      const knownServicesText = knownServices.length === 0 ? "none" : knownServices.join(", ");
      return yield* Effect.fail(
        new OpenTargetUnresolvedError({
          message: `No openable URL for ${plan.name}: the app declares no matching proxy route. Known services: ${knownServicesText}.`,
          app: plan.name,
          services: knownServices,
          remediation: "Declare a proxy route under `proxy:` in your Landofile, then rerun `lando open`.",
        }),
      );
    }

    for (const target of targets) {
      if (!isOpenableScheme(target.url)) {
        return yield* Effect.fail(
          new HostProxyOpenUrlSchemeError({
            message: `Refusing to open ${target.url}: only http and https URLs can be opened.`,
            scheme: target.scheme,
            url: target.url,
            remediation: "Open only http:// or https:// URLs.",
          }),
        );
      }
    }

    const explicitSelection = options.service !== undefined || options.route !== undefined;
    const shouldPrint =
      options.print === true ||
      (options.json === true && !(explicitSelection && options.ttyPresent === true));
    if (shouldPrint) return { app: plan.name, targets, launch: "printed" as const };

    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    if (!canOpenHost({ platform, env })) {
      return { app: plan.name, targets, launch: "headless-degraded" as const, note: HEADLESS_NOTE };
    }

    const events = yield* EventService;
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
    const ref = openAppRef(plan);
    for (const target of targets) {
      const summary = redactor.redactString(target.url);
      yield* events.publish(PreOpenUrlEvent.make({ app: ref, url: summary, timestamp: openNow() }));
      yield* openUrl(target.url, { platform });
      yield* events.publish(PostOpenUrlEvent.make({ app: ref, url: summary, timestamp: openNow() }));
    }
    return { app: plan.name, targets, launch: "opened" as const };
  });

type OpenAppServices =
  | AppPlanner
  | LandofileService
  | RuntimeProviderRegistry
  | ShellRunner
  | EventService
  | RedactionService;

export const openApp = (
  options: OpenAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<OpenAppResult, OpenAppError | InfoAppError, OpenAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;

    const plan =
      target?.plan ??
      (yield* Effect.gen(function* () {
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        return yield* planner.plan(landofile, capabilities);
      }));

    return yield* openForPlan(plan, options);
  });

export const renderOpenAppResult = (result: OpenAppResult, _ctx?: RenderContext): string => {
  if (result.targets.length === 0) return `${result.app}\n(no openable targets)\n`;
  const heading =
    result.launch === "opened"
      ? "Opened:"
      : result.launch === "headless-degraded"
        ? (result.note ?? "Resolved:")
        : "Resolved:";
  const lines = result.targets.map((target) => `${target.service}\t${target.url}`);
  return `${[heading, ...lines].join("\n")}\n`;
};
