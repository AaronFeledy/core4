import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  EnvironmentValueResolver,
  RuntimeProviderRegistry,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { executeToolingInvocations } from "../../src/operations/tooling-compile.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-16T00:00:00Z"),
  source: "tooling-applied-identity.test",
  runtime: 4 as const,
};

const service = (projectUser?: ServicePlan["projectUser"]): ServicePlan => ({
  name: ServiceName.make("web"),
  type: "php:8.3",
  provider: ProviderId.make("lando"),
  primary: true,
  environment: {},
  ...(projectUser === undefined ? {} : { projectUser }),
  home: { state: "persisted", target: "/var/www", store: "lando-home", user: "www-data" },
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const planAt = (root: string, web: ServicePlan): AppPlan => ({
  valueModel: 1,
  id: AppId.make("tooling-exact"),
  name: "Tooling Exact",
  slug: "tooling-exact",
  root: AbsolutePath.make(root),
  provider: web.provider,
  services: { [web.name]: web },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const nestedRoot = "/tmp/tooling-exact/nested";
const nested = planAt(nestedRoot, service());
const enclosing = planAt("/tmp/tooling-exact", service({ name: "www-data", uid: 33, gid: 33 }));

test("tooling identity never borrows an enclosing app's project user", async () => {
  const seen: ToolingInvocation[] = [];
  const lookups: Array<string | undefined> = [];
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed([]),
    capabilities: Effect.die("unused"),
    list: Effect.succeed([nested.provider]),
    resolveAppliedPlan: (_root, _app, lookup) => {
      lookups.push(lookup);
      return lookup === "exact" ? Effect.succeed(undefined) : Effect.succeed(enclosing);
    },
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    select: () => Effect.succeed(TestRuntimeProvider),
  });
  const engine = ToolingEngine.of({
    id: "test",
    run: (invocation) =>
      Effect.sync(() => {
        seen.push(invocation);
        return {
          tool: invocation.tool,
          service: String(invocation.service),
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      }),
  });

  await Effect.runPromise(
    Effect.scoped(
      executeToolingInvocations({
        provider: TestRuntimeProvider,
        plan: nested,
        tool: "check",
        invocations: [{ tool: "check", service: ServiceName.make("web"), commands: [["true"]] }],
        requiresProvider: true,
      }).pipe(
        Effect.provideService(RuntimeProviderRegistry, registry),
        Effect.provideService(ToolingEngine, engine),
        Effect.provideService(
          EnvironmentValueResolver,
          EnvironmentValueResolver.of({
            openSession: () => Effect.succeed({ resolveEnvironment: () => Effect.succeed({}) }),
          }),
        ),
      ),
    ),
  );

  expect(lookups).toEqual(["exact"]);
  expect(seen.map(({ user }) => user)).toEqual([undefined]);
});
