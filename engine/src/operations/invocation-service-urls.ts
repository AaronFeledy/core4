import {
  type InvocationProgram,
  type InvocationSite,
  serviceUrlReads,
} from "@lando/landofile/compiled-sites";
import { mapFailures } from "@lando/sdk/command-result";
import { ToolingCompileError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type LandofileEventName,
  type ValidationIssue,
  type ValidationIssuePath,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { routerEnabled } from "../config/router-config.ts";
import { authorizedRouteUrl } from "../lifecycle/route-url-bindings.ts";
import { readOwnAppliedPlan } from "../planner/connection-client-task.ts";
import { unavailableRouterReason } from "../subsystems/proxy/api.ts";
import type { ServiceUrlFailureReason } from "../tooling/event-errors.ts";
import { primaryConcreteRoute } from "./connection-url.ts";
import { activeEventNames } from "./event-invocation.ts";

/** Lifecycle points that run before start publishes routes and acquires router ports. */
const UNPUBLISHED = ["pre-init", "post-init", "pre-start"] as const satisfies readonly LandofileEventName[];
const UNPUBLISHED_EVENTS: ReadonlySet<string> = new Set(UNPUBLISHED);

/**
 * Lifecycle points with no route to read: init and `pre-start` run before start publishes routes,
 * and `post-stop` and `post-destroy` run once the app is no longer serving.
 */
export const SERVICE_URL_REFUSED_EVENTS: ReadonlySet<string> = new Set<LandofileEventName>([
  ...UNPUBLISHED,
  "post-stop",
  "post-destroy",
]);

export const serviceUrlFailureText = (
  reason: ServiceUrlFailureReason,
  service: string,
  event?: string,
): { readonly message: string; readonly suggestion: string } => {
  switch (reason) {
    case "event-phase":
      return {
        message: `services.${service}.url is not available during ${event}: ${
          event !== undefined && UNPUBLISHED_EVENTS.has(event)
            ? "the app has not published its routes yet"
            : "the app is no longer serving"
        }.`,
        suggestion:
          "Read the URL in a post-start, post-restart, or post-rebuild step, or in pre-stop, pre-restart, pre-rebuild, or pre-destroy for the address the app is leaving.",
      };
    case "unknown-service":
      return {
        message: `services.${service}.url names no service in this app.`,
        suggestion: "Name a service declared in the Landofile.",
      };
    case "app-not-started":
      return {
        message: `The app has not been started, so ${service} has no applied route yet.`,
        suggestion: "Run `lando start`, then run this command again.",
      };
    case "applied-state-unreadable":
      return {
        message: `Lando could not read the app's applied state, so it cannot tell which route ${service} last had.`,
        suggestion: "Run `lando start` to rewrite the app's applied state, then retry.",
      };
    case "no-applied-route":
      return {
        message: `${service} has no applied route with a concrete hostname.`,
        suggestion:
          "Run `lando start` to apply the app's routes; the service needs a route whose hostname has no wildcard.",
      };
    case "routing-disabled":
      return {
        message: `The router is disabled for this app, so ${service} has no public URL.`,
        suggestion: "Enable the router for this app and run `lando start`.",
      };
    case "router-unsupported":
      return {
        message: `The selected router cannot report the address it serves ${service} on.`,
        suggestion:
          "Run `lando setup` to install a router that reports its route addresses, then `lando start`.",
      };
    case "authority-unavailable":
      return {
        message: `The router has not recorded the port it serves ${service} on.`,
        suggestion: "Run `lando start` so the router records its ports, then retry.",
      };
    default:
      return reason satisfies never;
  }
};

/**
 * Resolve every public service URL these invocation sites read: the address Lando last applied for
 * each service's primary concrete route, at the port the router recorded for it. URL-free sites
 * read neither applied state nor the router. A failure is a `ToolingCompileError` whose issues
 * locate every site the failure affects: every reading site for an app-wide failure, and the sites
 * of each affected service otherwise. The caller drops sites that will not run, and `effectivePath`
 * maps a site to its effective declaration path.
 */
export const resolveInvocationServiceUrls = Effect.fnUntraced(function* (input: {
  readonly plan: AppPlan;
  readonly tool: string;
  readonly sites: InvocationProgram;
  readonly effectivePath: (site: InvocationSite) => ValidationIssuePath;
}) {
  const reads = new Map<string, InvocationSite[]>();
  for (const site of input.sites)
    for (const service of serviceUrlReads(site.template).services)
      reads.set(service, [...(reads.get(service) ?? []), site]);
  const all = [...reads.keys()];
  if (all.length === 0) return undefined;
  const fail = (
    reason: ServiceUrlFailureReason,
    services: readonly string[],
    extra: { readonly event?: string; readonly cause?: unknown } = {},
  ) => {
    const issues: ValidationIssue[] = [];
    const located = new Set<InvocationSite>();
    for (const service of services) {
      const text = serviceUrlFailureText(reason, service, extra.event);
      for (const site of reads.get(service) ?? []) {
        if (located.has(site)) continue;
        located.add(site);
        issues.push({
          rule: "landofile.tooling",
          reason,
          path: input.effectivePath(site),
          source: site.source,
          message: text.message,
          suggestion: text.suggestion,
        });
      }
    }
    const [first] = issues;
    const text = serviceUrlFailureText(reason, services[0] ?? all[0] ?? "", extra.event);
    return new ToolingCompileError({
      tool: input.tool,
      message:
        first === undefined ? text.message : `${formatValidationIssuePath(first.path)}: ${first.message}`,
      remediation: text.suggestion,
      issues,
      ...(extra.cause === undefined ? {} : { cause: extra.cause }),
    });
  };
  const event = (yield* activeEventNames).find((name) => SERVICE_URL_REFUSED_EVENTS.has(name));
  if (event !== undefined) return yield* fail("event-phase", all, { event });
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  if (Option.isNone(registry)) return yield* fail("applied-state-unreadable", all);
  const unreadable = (cause: unknown) => fail("applied-state-unreadable", all, { cause });
  const applied = yield* readOwnAppliedPlan(registry.value, input.plan, unreadable).pipe(
    mapFailures((cause) => (cause instanceof ToolingCompileError ? cause : unreadable(cause))),
  );
  if (applied === undefined) {
    const unknown = all.filter((service) => !Object.hasOwn(input.plan.services, service));
    return yield* unknown.length > 0 ? fail("unknown-service", unknown) : fail("app-not-started", all);
  }
  // The applied plan decides membership: a service removed since the last start keeps its address
  // until the app leaves it, and one added since has no route until the next start.
  const unknown = all.filter(
    (service) => !Object.hasOwn(applied.services, service) && !Object.hasOwn(input.plan.services, service),
  );
  if (unknown.length > 0) return yield* fail("unknown-service", unknown);
  if (!routerEnabled(applied)) return yield* fail("routing-disabled", all);
  const routes = new Map(
    all.map((service) => [
      service,
      Object.hasOwn(applied.services, service) ? primaryConcreteRoute(applied.routes, service) : undefined,
    ]),
  );
  const unrouted = all.filter((service) => routes.get(service) === undefined);
  if (unrouted.length > 0) return yield* fail("no-applied-route", unrouted);
  const router = Option.getOrUndefined(yield* Effect.serviceOption(RouterService));
  if (
    router === undefined ||
    unavailableRouterReason(router) !== undefined ||
    router.routeAuthorities === undefined
  )
    return yield* fail("router-unsupported", all);
  // The router answers for the full applied route table; each service then reads its own route.
  const authorities = yield* router
    .routeAuthorities(applied.routes)
    .pipe(mapFailures((cause) => fail("authority-unavailable", all, { cause })));
  const services: Record<string, { readonly url: string }> = {};
  const unrecorded: string[] = [];
  for (const [service, route] of routes) {
    const authorized = route === undefined ? undefined : authorizedRouteUrl(route, authorities);
    if (authorized === undefined) unrecorded.push(service);
    else services[service] = { url: authorized.url };
  }
  if (unrecorded.length > 0) return yield* fail("authority-unavailable", unrecorded);
  return services;
});
