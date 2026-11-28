import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AppliedStateVersionError, type ToolingCompileError } from "@lando/sdk/errors";
import type { AppPlan, RoutePlan, ToolingResult } from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { withinEventInvocation } from "../../src/operations/event-invocation.ts";
import { runBunShellTooling } from "../../src/operations/tooling-bun-script.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
import { publicUrlRouter } from "../lifecycle/route-url-fixture.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";
import { scriptHostLayer } from "./tooling-bun-script-support.ts";

const route: RoutePlan = {
  hostname: "applied.test",
  scheme: "both",
  service: web.name,
  priority: 1,
  backend: { service: web.name, port: 3000, protocol: "http" },
  pathPrefix: "/app",
};
const desired: AppPlan = { ...plan, routes: [route] };

const withScript = async <T>(content: string, run: (root: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-script-route-"));
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando/scripts/probe.bun.sh"), content);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const envScript = (value: string) =>
  ["# ---", "# env:", `#   SITE_URL: "${value}"`, "# ---", 'printf "[%s]\\n" "$SITE_URL"', ""].join("\n");

interface Calls {
  applied: number;
  authorities: number;
}

interface RunOptions {
  readonly applied?: AppPlan | undefined;
  readonly appliedFailure?: AppliedStateVersionError;
  readonly withRuntime?: boolean;
  readonly plan?: AppPlan;
}

const scriptRun = (root: string, options: RunOptions = {}) => {
  const calls: Calls = { applied: 0, authorities: 0 };
  const router = publicUrlRouter();
  const runtime =
    options.withRuntime === false
      ? Layer.empty
      : Layer.mergeAll(
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
                    : Effect.succeed("applied" in options ? options.applied : ({ ...desired } as AppPlan));
                }),
            }),
          ),
          Layer.succeed(RouterService, {
            ...router,
            routeAuthorities: (routes) =>
              Effect.suspend(() => {
                calls.authorities += 1;
                return router.routeAuthorities?.(routes) ?? Effect.die("unreachable");
              }),
          }),
        );
  const effect = runBunShellTooling({ name: "probe", plan: options.plan ?? desired }, root).pipe(
    Effect.map((result: ToolingResult | undefined) =>
      result === undefined ? undefined : { exitCode: result.exitCode, stdout: result.stdout },
    ),
    Effect.provide(
      Layer.mergeAll(
        scriptHostLayer,
        testEnvironmentResolverLayer,
        Layer.succeed(RedactionService, makeRedactionService()),
        runtime,
      ),
    ),
  );
  return { calls, effect };
};

const outcome = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

test("binds the applied route's URL into a script's env", async () => {
  await withScript(envScript("{{ services.web.url }}"), async (root) => {
    // When
    const { calls, effect } = scriptRun(root);
    // Then
    expect(await outcome(effect)).toMatchObject({
      success: { exitCode: 0, stdout: "[https://applied.test:8443/app]\n" },
    });
    expect(calls).toEqual({ applied: 1, authorities: 1 });
  });
});

test("resolves every route fact to the same applied route", async () => {
  await withScript(
    [
      "# ---",
      "# env:",
      '#   URL: "{{ services.web.url }}"',
      '#   HOST: "{{ services.web.hostname }}"',
      '#   ORIGIN: "{{ services.web.origin }}"',
      '#   PORT: "{{ services.web.publicPort }}"',
      '#   SCHEME: "{{ services.web.scheme }}"',
      "# ---",
      'printf "%s|%s|%s|%s|%s\\n" "$URL" "$HOST" "$ORIGIN" "$PORT" "$SCHEME"',
      "",
    ].join("\n"),
    async (root) => {
      const { effect } = scriptRun(root);
      expect(await outcome(effect)).toMatchObject({
        _tag: "Success",
        success: {
          stdout: "https://applied.test:8443/app|applied.test|https://applied.test:8443|8443|https\n",
        },
      });
    },
  );
});

test("refuses before the script body when the app has not been started", async () => {
  await withScript(envScript("{{ services.web.url }}"), async (root) => {
    // When
    const { effect } = scriptRun(root, { applied: undefined });
    // Then
    const result = await outcome(effect);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ToolingCompileError",
        tool: "probe",
        issues: [
          {
            rule: "landofile.tooling",
            reason: "app-not-started",
            path: ["env", "SITE_URL"],
            source: {
              layer: "script",
              file: join(root, ".lando/scripts/probe.bun.sh"),
              path: ["env", "SITE_URL"],
            },
          },
        ],
      },
    });
    expect((result as { failure: ToolingCompileError }).failure.message).toContain("env.SITE_URL");
  });
});

test("reports newer applied state with the provider's remediation", async () => {
  const remediation = "Upgrade Lando.";
  await withScript(envScript("{{ services.web.publicPort }}"), async (root) => {
    // When
    const { effect } = scriptRun(root, {
      appliedFailure: new AppliedStateVersionError({
        providerId: "lando",
        operation: "read applied plan",
        path: "/state/applied.json",
        storedVersion: 99,
        supportedVersion: 1,
        scope: "app",
        message: "Applied state was written by a newer Lando.",
        remediation,
      }),
    });
    // Then
    expect(await outcome(effect)).toMatchObject({
      _tag: "Failure",
      failure: {
        issues: [{ reason: "applied-state-newer", path: ["env", "SITE_URL"], suggestion: remediation }],
      },
    });
  });
});

test.each(["{{ 443 }}", "{{ [services.web.url] }}"])(
  "refuses a resolved env value that is not text: %s",
  async (value) => {
    await withScript(envScript(value), async (root) => {
      // When
      const { effect } = scriptRun(root);
      // Then
      const result = await outcome(effect);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ToolingCompileError",
          issues: [
            {
              reason: "non-text-value",
              path: ["env", "SITE_URL"],
              source: { layer: "script", file: join(root, ".lando/scripts/probe.bun.sh") },
            },
          ],
        },
      });
    });
  },
);

test("refuses an event-phase step that reads a route fact", async () => {
  await withScript(envScript("{{ services.web.url }}"), async (root) => {
    // When the script runs as a pre-start event step
    const { effect } = scriptRun(root);
    const result = await outcome(
      withinEventInvocation({ app: plan.id, event: "pre-start", file: ".lando.yml" }, effect),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { issues: [{ reason: "event-phase", path: ["env", "SITE_URL"] }] },
    });
  });
});

test("needs no applied state or router for a script that reads no route fact", async () => {
  await withScript(envScript("literal"), async (root) => {
    // When the runtime has no provider registry and no router
    const { calls, effect } = scriptRun(root, { withRuntime: false });
    // Then
    expect(await outcome(effect)).toMatchObject({ success: { exitCode: 0, stdout: "[literal]\n" } });
    expect(calls).toEqual({ applied: 0, authorities: 0 });
  });
});
