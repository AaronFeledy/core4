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
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
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
  const registry = makeTestRuntimeProviderRegistry({
    capabilities: Effect.die("unused"),
    list: Effect.succeed([nested.provider]),
    readAppliedPlanStrict: () => Effect.succeed(enclosing),
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

  expect(seen.map(({ user }) => user)).toEqual([undefined]);
});

const currentPin = { name: "pnpm", version: "10.10.0", launcher: "launcher-2" };

test.each([
  {
    label: "version change",
    before: { ...currentPin, version: "10.9.0" },
    warn: ["pnpm@10.9.0", "pnpm@10.10.0"],
  },
  {
    label: "manager change",
    before: { ...currentPin, name: "yarn" },
    warn: ["yarn@10.10.0", "pnpm@10.10.0"],
  },
  {
    label: "integrity change",
    before: { ...currentPin, integrity: "sha256.changed" },
    warn: ["pnpm@10.10.0", "pnpm@10.10.0"],
  },
  {
    label: "launcher change",
    before: { ...currentPin, launcher: "launcher-1" },
    warn: ["pnpm@10.10.0", "pnpm@10.10.0"],
  },
  { label: "pin added", before: null, warn: ["no provisioned package manager", "pnpm@10.10.0"] },
  {
    label: "pin removed",
    before: currentPin,
    remove: true,
    warn: ["pnpm@10.10.0", "no provisioned package manager"],
  },
  { label: "same pin", before: currentPin, warn: undefined },
  { label: "no stored evidence", before: undefined, warn: undefined },
  { label: "other provider", before: null, provider: "docker", warn: undefined },
])("tooling warning with $label", async ({ before, remove, provider, warn }) => {
  const node = (packageManager: unknown, providerId: string): ServicePlan => ({
    ...service(),
    type: "node:22",
    provider: ProviderId.make(providerId),
    ...(packageManager === undefined ? {} : { provenance: { node: { packageManager } } }),
  });
  const plan = planAt(nestedRoot, node(remove ? null : currentPin, "lando"));
  const applied = planAt(nestedRoot, node(before, provider ?? "lando"));
  const registry = makeTestRuntimeProviderRegistry({
    list: Effect.succeed([plan.provider]),
    readAppliedPlanStrict: () => Effect.succeed(applied),
  });
  const warnings = makeCommandWarnings(true);
  const invocation: ToolingInvocation = {
    tool: "check",
    service: ServiceName.make("web"),
    commands: [["true"]],
  };
  const result = await Effect.runPromise(
    Effect.scoped(
      executeToolingInvocations({
        provider: TestRuntimeProvider,
        plan,
        tool: "check",
        invocations: [invocation, invocation],
        requiresProvider: true,
      }).pipe(
        Effect.provideService(RuntimeProviderRegistry, registry),
        Effect.provideService(CommandWarnings, warnings),
        Effect.provideService(ToolingEngine, {
          id: "test",
          run: () =>
            Effect.succeed({
              tool: "check",
              service: "web",
              exitCode: 0,
              stdout: "ran\n",
              stderr: "",
            }),
        }),
        Effect.provideService(EnvironmentValueResolver, {
          openSession: () => Effect.succeed({ resolveEnvironment: () => Effect.succeed({}) }),
        }),
      ),
    ),
  );

  expect(result.stdout).toBe("ran\nran\n");
  expect(
    (await Effect.runPromise(warnings.list)).map(({ code, context }) => ({
      code,
      service: context?.service,
      built: context?.built,
      declared: context?.declared,
    })),
  ).toEqual(
    warn === undefined
      ? []
      : [{ code: "LANDO_NODE_PACKAGE_MANAGER_STALE", service: "web", built: warn[0], declared: warn[1] }],
  );
});
