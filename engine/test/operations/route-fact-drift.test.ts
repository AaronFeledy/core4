import { describe, expect, test } from "bun:test";
import { authoredInvocationSites, compileInvocationSites } from "@lando/landofile/compiled-sites";
import type { LandoEvent } from "@lando/sdk/events";
import type { AppPlan, EnvironmentValue, RoutePlan, ToolingTaskShape } from "@lando/sdk/schema";
import { EventService, RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { resolveInvocationServiceUrls } from "../../src/operations/invocation-service-urls.ts";
import { serviceCredsScopeForPlan } from "../../src/planner/landofile-scopes.ts";
import { publicUrlRouter } from "../lifecycle/route-url-fixture.ts";
import { plan, web } from "./start-progress-topology-support.ts";
import { recordingScriptEvents } from "./tooling-bun-script-support.ts";

// The test router serves https on 8443, so the current URL is https://applied.test:8443/app.
const route: RoutePlan = {
  hostname: "applied.test",
  scheme: "both",
  pathPrefix: "/app",
  service: web.name,
  priority: 1,
  backend: { service: web.name, port: 3000, protocol: "http" },
};

const part = (member?: "hostname" | "origin") => ({
  service: web.name,
  ...(member === undefined ? {} : { member }),
  encoding: "raw" as const,
});

/** An applied plan whose web service binds the given facts and was started with `recorded`. */
const applied = (environment: Record<string, EnvironmentValue>, recorded?: string): AppPlan => ({
  ...plan,
  routes: [route],
  services: {
    ...plan.services,
    [web.name]: {
      ...web,
      environment,
      extensions:
        recorded === undefined
          ? web.extensions
          : { ...web.extensions, "@lando/engine/realized-route-urls": { [web.name]: recorded } },
    },
  },
});

const task: ToolingTaskShape = { service: ":host", cmd: ["echo", "{{ services.web.url }}"] };

const resolve = async (
  appliedPlan: AppPlan,
  options: { readonly machineOutput: boolean; readonly calls?: number },
) => {
  const warnings = makeCommandWarnings(options.machineOutput);
  const events: LandoEvent[] = [];
  const sites = await Effect.runPromise(
    compileInvocationSites(
      authoredInvocationSites(task, "/app/.lando.yml"),
      { services: serviceCredsScopeForPlan(appliedPlan) },
      task,
    ),
  );
  const once = resolveInvocationServiceUrls({
    plan: appliedPlan,
    tool: "probe",
    sites,
    effectivePath: (site) => ["tooling", "probe", ...site.path],
  });
  const resolved = await Effect.runPromise(
    Effect.all(Array.from({ length: options.calls ?? 1 }, () => once)).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(CommandWarnings, warnings),
          Layer.succeed(EventService, recordingScriptEvents(events)),
          Layer.succeed(RouterService, publicUrlRouter()),
          Layer.succeed(
            RuntimeProviderRegistry,
            makeTestRuntimeProviderRegistry({
              list: Effect.succeed([plan.provider]),
              select: () => Effect.die("host only"),
              readAppliedPlanStrict: () => Effect.succeed(appliedPlan),
            }),
          ),
        ),
      ),
    ),
  );
  return {
    resolved,
    warnings: await Effect.runPromise(warnings.list),
    notices: events.flatMap((event) => (event._tag === "message.warn" ? [event.body] : [])),
  };
};

describe("route fact drift", () => {
  test("warns once per command when a consumer's recorded URL is outdated", async () => {
    // Given web was started while the router served https on 9443
    const stale = applied(
      { APP_URL: { _tag: "RouteText", parts: [part()] } },
      "https://applied.test:9443/app",
    );
    // When an event predicate and its body both resolve the URL in one command
    const { resolved, warnings, notices } = await resolve(stale, { machineOutput: false, calls: 2 });
    // Then the invocation still gets the current URL, with one warning and one notice
    expect(resolved[0]).toMatchObject({ web: { url: "https://applied.test:8443/app" } });
    expect(warnings).toEqual([
      {
        code: "LANDO_ROUTE_URL_DRIFT",
        message:
          "web's recorded environment has https://applied.test:9443/app for services.web.url, but it now resolves to https://applied.test:8443/app.",
        remediation: "Run `lando start` to give web the current services.web.url.",
        context: {
          app: plan.id,
          consumer: "web",
          target: "web",
          recorded: "https://applied.test:9443/app",
          current: "https://applied.test:8443/app",
        },
      },
    ]);
    expect(notices).toEqual([`${warnings[0]?.message} ${warnings[0]?.remediation}`]);
  });

  test("records the warning for machine output without printing it", async () => {
    const stale = applied(
      { ORIGIN: { _tag: "RouteText", parts: [part("origin")] } },
      "https://applied.test:9443/",
    );
    const { warnings, notices } = await resolve(stale, { machineOutput: true });
    expect(warnings.map((warning) => [warning.code, warning.message])).toEqual([
      [
        "LANDO_ROUTE_URL_DRIFT",
        "web's recorded environment has https://applied.test:9443 for services.web.origin, but it now resolves to https://applied.test:8443.",
      ],
    ]);
    expect(notices).toEqual([]);
  });

  test.each([
    {
      name: "a hostname reader after a port move",
      environment: { HOST: { _tag: "RouteText", parts: [part("hostname")] } },
      recorded: "https://applied.test:9443/app",
    },
    {
      name: "an origin reader after a path-only edit",
      environment: { ORIGIN: { _tag: "RouteText", parts: [part("origin")] } },
      recorded: "https://applied.test:8443/old",
    },
    {
      name: "a consumer with no recorded evidence",
      environment: { APP_URL: { _tag: "RouteText", parts: [part()] } },
      recorded: undefined,
    },
    {
      name: "a consumer that holds the current URL",
      environment: { APP_URL: { _tag: "RouteText", parts: [part()] } },
      recorded: "https://applied.test:8443/app",
    },
  ] satisfies readonly {
    readonly name: string;
    readonly environment: Record<string, EnvironmentValue>;
    readonly recorded: string | undefined;
  }[])("does not warn about $name", async ({ environment, recorded }) => {
    const { warnings, notices } = await resolve(applied(environment, recorded), { machineOutput: false });
    expect(warnings).toEqual([]);
    expect(notices).toEqual([]);
  });
});
