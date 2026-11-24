import { describe, expect, test } from "bun:test";
import { authoredInvocationSites, compileInvocationSites } from "@lando/landofile/compiled-sites";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AppliedStateVersionError } from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import { type AppPlan, type RoutePlan, ServiceName, type ToolingTaskShape } from "@lando/sdk/schema";
import {
  ProcessRunner,
  RouterService,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
} from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { prepareToolingInvocation } from "../../src/operations/tooling-prepare.ts";
import { serviceCredsScopeForPlan } from "../../src/planner/landofile-scopes.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import { makeShellRunnerService } from "../../src/services/shell-runner.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
import { publicUrlRouter } from "../lifecycle/route-url-fixture.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const route = (hostname: string, scheme: RoutePlan["scheme"], pathPrefix?: string): RoutePlan => ({
  hostname,
  scheme,
  service: web.name,
  priority: 1,
  backend: { service: web.name, port: 3000, protocol: "http" },
  ...(pathPrefix === undefined ? {} : { pathPrefix }),
});

const desired: AppPlan = { ...plan, routes: [route("desired.test", "both")] };
const appliedPlan: AppPlan = { ...plan, routes: [route("applied.test", "both", "/app")] };

interface Calls {
  applied: number;
  authorities: number;
  routes: ReadonlyArray<RoutePlan>[];
}

const run = async (
  task: ToolingTaskShape,
  options: {
    readonly applied?: AppPlan | undefined;
    readonly appliedFailure?: AppliedStateVersionError;
    readonly desired?: AppPlan;
    readonly router?: typeof RouterService.Service | undefined;
    readonly context?: ExpressionContext;
  } = {},
) => {
  const calls: Calls = { applied: 0, authorities: 0, routes: [] };
  const target = options.desired ?? desired;
  const router = "router" in options ? options.router : publicUrlRouter();
  const counted =
    router === undefined
      ? undefined
      : {
          ...router,
          ...(router.routeAuthorities === undefined
            ? {}
            : {
                routeAuthorities: (routes: readonly RoutePlan[]) =>
                  Effect.suspend(() => {
                    calls.authorities += 1;
                    calls.routes.push(routes);
                    return router.routeAuthorities?.(routes) ?? Effect.die("unreachable");
                  }),
              }),
        };
  const runner = Effect.runSync(ProcessRunner.pipe(Effect.provide(BunProcessRunner.layer)));
  const applied = "applied" in options ? options.applied : appliedPlan;
  const layer = Layer.mergeAll(
    BunProcessRunner.layer,
    testEnvironmentResolverLayer,
    Layer.succeed(RedactionService, makeRedactionService()),
    Layer.succeed(
      ShellRunner,
      makeShellRunnerService(
        () => {
          throw new Error("unused REPL");
        },
        ownerOnlyFileAccess,
        runner,
      ),
    ),
    Layer.succeed(ToolingEngine, ToolingEngine.of({ id: "unused", run: () => Effect.die("host only") })),
    Layer.succeed(
      RuntimeProviderRegistry,
      makeTestRuntimeProviderRegistry({
        list: Effect.succeed([plan.provider]),
        select: () => Effect.die("host only"),
        readAppliedPlanStrict: () =>
          Effect.suspend(() => {
            calls.applied += 1;
            return "appliedFailure" in options
              ? Effect.fail(options.appliedFailure)
              : Effect.succeed(applied);
          }),
      }),
    ),
    counted === undefined ? Layer.empty : Layer.succeed(RouterService, counted),
  );
  // Compile like the planner does, so a URL read survives static capture.
  const sites = await Effect.runPromise(
    compileInvocationSites(
      authoredInvocationSites(task, "/app/.lando.yml"),
      { services: serviceCredsScopeForPlan(target) },
      task,
    ),
  );
  const result = await Effect.runPromise(
    prepareToolingInvocation({
      plan: target,
      options: {
        name: "probe",
        lookupKey: "probe",
        task,
        input: { _tag: "RawArgv", argv: [] },
        source: { path: "/app/.lando.yml", task: "probe" },
      },
      sites,
      ...(options.context === undefined ? {} : { context: options.context }),
    }).pipe(Effect.provide(layer), Effect.result),
  );
  return { result, calls };
};

const { routeAuthorities: _routeAuthorities, ...withoutAuthorities } = publicUrlRouter();

const issueLocations = (result: Awaited<ReturnType<typeof run>>["result"]) =>
  result._tag === "Failure" && result.failure._tag === "ToolingCompileError"
    ? result.failure.issues.map((issue) => [issue.reason, issue.path])
    : result;

const hostTask = (fields: Omit<ToolingTaskShape, "service">): ToolingTaskShape => ({
  service: ":host",
  ...fields,
});

describe("tooling invocation service URLs", () => {
  test("binds the applied route's URL as quoted data in shell text", async () => {
    // When
    const { result, calls } = await run(hostTask({ cmd: "curl {{ services.web.url }}/health" }));
    // Then
    expect(result).toMatchObject({
      _tag: "Success",
      success: { normalized: { steps: [{ cmd: "curl 'https://applied.test:8443/app'/health" }] } },
    });
    expect(calls).toMatchObject({ applied: 1, authorities: 1 });
  });

  test("passes the URL as a plain string to env and argv", async () => {
    // When
    const { result } = await run(
      hostTask({ cmd: ["echo", "{{ services.web.url }}"], env: { SITE: "{{ services.web.url }}" } }),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        invocations: [
          {
            commands: [["echo", "https://applied.test:8443/app"]],
            env: { SITE: "https://applied.test:8443/app" },
          },
        ],
      },
    });
  });

  test("lets ordinary helpers read the resolved URL", async () => {
    // When
    const { result } = await run(hostTask({ cmd: ["echo", "{{ url.parse(services.web.url).hostname }}"] }));
    // Then
    expect(result).toMatchObject({
      _tag: "Success",
      success: { invocations: [{ commands: [["echo", "applied.test"]] }] },
    });
  });

  test("reads neither applied state nor the router when no URL is read", async () => {
    // When
    const { result, calls } = await run(hostTask({ cmd: ["echo", "{{ task.name }}"] }), {
      router: undefined,
    });
    // Then
    expect(result._tag).toBe("Success");
    expect(calls).toMatchObject({ applied: 0, authorities: 0 });
  });

  test("never evaluates, preflights, or resolves the definition of a var the caller overrides", async () => {
    // Given a literal var and a dynamic var whose sh and env both read a URL
    const task = hostTask({
      cmd: ["echo", "{{ vars.site }}", "{{ vars.host }}"],
      vars: {
        site: "{{ services.web.url }}",
        host: { sh: "echo {{ services.web.url }}", env: { SITE: "{{ services.web.url }}" } },
      },
    });
    // When the caller supplies both
    const { result, calls } = await run(task, {
      router: undefined,
      applied: undefined,
      context: { vars: { site: "https://caller.test", host: "caller.test" } },
    });
    // Then
    expect(result).toMatchObject({
      _tag: "Success",
      success: { invocations: [{ commands: [["echo", "https://caller.test", "caller.test"]] }] },
    });
    expect(calls).toMatchObject({ applied: 0, authorities: 0 });
  });

  test("judges a service by the applied plan when the Landofile no longer declares it", async () => {
    // Given web was removed from the Landofile but the app still serves it
    const { [web.name]: _web, ...remaining } = plan.services;
    // When
    const { result } = await run(hostTask({ cmd: ["echo", "{{ services.web.url }}"] }), {
      desired: { ...plan, services: remaining, routes: [] },
    });
    // Then
    expect(result).toMatchObject({
      _tag: "Success",
      success: { invocations: [{ commands: [["echo", "https://applied.test:8443/app"]] }] },
    });
  });

  test("asks the router about the full applied route table", async () => {
    // Given an applied table with a route for another owner and a wildcard route
    const other: RoutePlan = { ...route("other.test", "http"), service: ServiceName.make("api") };
    const routes = [route("*.applied.test", "https"), other, ...appliedPlan.routes];
    // When
    const { result, calls } = await run(hostTask({ cmd: ["echo", "{{ services.web.url }}"] }), {
      applied: { ...appliedPlan, routes },
    });
    // Then
    expect(result._tag).toBe("Success");
    expect(calls.routes).toEqual([routes]);
  });

  test("reports unreadable applied state as such, with its cause", async () => {
    // When
    const { result } = await run(hostTask({ cmd: ["echo", "{{ services.web.url }}"] }), {
      appliedFailure: new AppliedStateVersionError({
        providerId: "lando",
        operation: "read applied plan",
        path: "/state/applied.json",
        storedVersion: 99,
        supportedVersion: 1,
        scope: "app",
        message: "Applied state was written by a newer Lando.",
        remediation: "Upgrade Lando.",
      }),
    });
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ToolingCompileError",
        message: expect.stringContaining("tooling.probe.cmd[1]: "),
        issues: [{ reason: "applied-state-unreadable", path: ["tooling", "probe", "cmd", 1] }],
      },
    });
  });

  test("locates every reading site for an app-wide failure", async () => {
    // Given three sites that read web
    const task = hostTask({
      cmd: ["echo", "{{ services.web.url }}", "{{ services.web.url }}"],
      env: { SITE: "{{ services.web.url }}" },
    });
    // When routing is disabled for the app
    const { result } = await run(task, { applied: { ...appliedPlan, router: { enabled: false } } });
    // Then
    expect(issueLocations(result)).toEqual([
      ["routing-disabled", ["tooling", "probe", "cmd", 1]],
      ["routing-disabled", ["tooling", "probe", "cmd", 2]],
      ["routing-disabled", ["tooling", "probe", "env", "SITE"]],
    ]);
  });

  test("locates only the sites of the service a per-service failure names", async () => {
    // When one site reads web and another reads a service the app does not have
    const { result } = await run(
      hostTask({ cmd: ["echo", "{{ services.web.url }}"], env: { API: "{{ services.api.url }}" } }),
    );
    // Then
    expect(issueLocations(result)).toEqual([["unknown-service", ["tooling", "probe", "env", "API"]]]);
  });

  test.each([
    {
      name: "no applied plan",
      options: { applied: undefined },
      reason: "app-not-started",
    },
    {
      name: "an applied plan without a concrete route",
      options: { applied: { ...plan, routes: [route("*.applied.test", "https")] } },
      reason: "no-applied-route",
    },
    {
      name: "routing disabled",
      options: { applied: { ...appliedPlan, router: { enabled: false } } },
      reason: "routing-disabled",
    },
    {
      name: "no router",
      options: { router: undefined },
      reason: "router-unsupported",
    },
    {
      name: "a router without authorities",
      options: { router: withoutAuthorities },
      reason: "router-unsupported",
    },
    {
      name: "no recorded authority",
      options: { router: { ...publicUrlRouter(), routeAuthorities: () => Effect.succeed([]) } },
      reason: "authority-unavailable",
    },
    {
      name: "an unknown service",
      service: "api",
      options: {},
      reason: "unknown-service",
    },
  ])("fails with a located $reason issue for $name", async ({ service = "web", options, reason }) => {
    // When
    const { result } = await run(hostTask({ cmd: ["echo", `{{ services.${service}.url }}`] }), options);
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ToolingCompileError",
        issues: [
          {
            rule: "landofile.tooling",
            reason,
            path: ["tooling", "probe", "cmd", 1],
            source: { file: "/app/.lando.yml", path: ["cmd", 1] },
          },
        ],
      },
    });
  });
});
