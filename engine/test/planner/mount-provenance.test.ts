import { expect, test } from "bun:test";
import { LandofileValidationError, ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ProviderId, ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Schema } from "effect";
import { compileAuthoredMounts } from "../../src/planner/authored-mounts.ts";
import { servicePlanFromDraft } from "../../src/planner/extensions.ts";
import { worktreeGitMounts } from "../../src/planner/git-host-checks.ts";
import { deriveMountOverlays } from "../../src/planner/mounts.ts";
import { appBuildKeyForStep, buildKeyForService } from "../../src/services/build-key.ts";
import { makeDraft } from "../../src/services/draft.ts";
import { finalizeDraft } from "../../src/services/finalize-service.ts";

const context = { appRoot: "/canonical/app", appSlug: "app", serviceName: "web" };
const base: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("test"),
  primary: true,
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"), source: "test", runtime: 4 },
};

test.each(["feature", "app-feature"] as const)(
  "%s finalization stamps every service-intent class",
  (tier) => {
    const draft = makeDraft({
      name: ServiceName.make("web"),
      type: "node",
      provider: base.provider,
      primary: true,
      defaultFeatures: [],
    });
    draft.appMount = {
      source: context.appRoot,
      target: PortablePath.make("/app"),
      readOnly: false,
      excludes: [],
      includes: [],
    };
    draft.mounts.push(
      { type: "bind", source: "/host/cert", target: PortablePath.make("/cert"), readOnly: true },
      { type: "tmpfs", target: PortablePath.make("/tmpfs"), readOnly: false },
    );
    draft.storage.push({ store: "data", target: PortablePath.make("/data"), readOnly: false });
    const result =
      tier === "feature" ? finalizeDraft(draft) : servicePlanFromDraft(draft, [], base.metadata, {});
    if (result instanceof ServiceFeatureError) throw result;
    expect(result.mounts.map(({ origin }) => origin)).toEqual(["service", "service", "service", "service"]);
    expect(result.mounts[0]).toMatchObject({ role: "app", relativeTo: "app", source: context.appRoot });
  },
);

test.each([
  ["./packages", "app"],
  ["../shared", "app"],
  ["/host/packages", undefined],
  ["~/packages", undefined],
  ["C:\\host\\packages", undefined],
  ["C:/host/packages", undefined],
  ["\\\\server\\share", undefined],
  ["C:packages", undefined],
] as const)("authored bind source %s carries only lexical app relativity", (source, relativeTo) => {
  const config = Schema.decodeUnknownSync(ServiceConfig)({ mounts: [{ source, target: "/packages" }] });
  const mounts = compileAuthoredMounts(context, config, undefined);
  if (mounts instanceof LandofileValidationError) throw mounts;
  expect(mounts[0]).toMatchObject({ type: "bind", origin: "authored" });
  expect(mounts[0]?.type === "bind" ? mounts[0].relativeTo : undefined).toBe(relativeTo);
  if (source === "../shared") expect(mounts[0]).toMatchObject({ source: "/canonical/shared" });
});

test.each(["./packages", "/host/packages"])(
  "nested includes inherit relativity from parent %s",
  async (source) => {
    const config = Schema.decodeUnknownSync(ServiceConfig)({
      mounts: [{ source, target: "/packages", excludes: ["vendor"], includes: ["vendor/sdk"] }],
    });
    const mounts = compileAuthoredMounts(context, config, undefined);
    if (mounts instanceof LandofileValidationError) throw mounts;
    const result = await Effect.runPromise(
      deriveMountOverlays({ context, servicePlan: { ...base, mounts } }),
    );
    expect(result.servicePlan.mounts.find(({ target }) => target === "/packages/vendor")).toMatchObject({
      type: "volume",
      origin: "derived",
    });
    const included = result.servicePlan.mounts.find(({ target }) => target === "/packages/vendor/sdk");
    expect(included).toMatchObject({
      type: "bind",
      origin: "derived",
      source: source.startsWith(".") ? "/canonical/app/packages/vendor/sdk" : "/host/packages/vendor/sdk",
    });
    expect(included?.type === "bind" ? included.relativeTo : undefined).toBe(
      source.startsWith(".") ? "app" : undefined,
    );
  },
);

test("worktree git binds have derived origin without app-relative source metadata", () => {
  const mounts = worktreeGitMounts(
    {
      ...base,
      mounts: [
        {
          type: "bind",
          source: context.appRoot,
          target: PortablePath.make("/app"),
          role: "app",
          readOnly: false,
          realization: "passthrough",
          origin: "service",
          relativeTo: "app",
        },
      ],
    },
    {
      gitDir: "/host/repo/.git/worktrees/app",
      commonDir: "/host/repo/.git",
      containerGitDir: "/host/repo/.git/worktrees/app",
      containerCommonDir: "/host/repo/.git",
    },
  );
  expect(mounts).toHaveLength(1);
  expect(mounts[0]).toMatchObject({ type: "bind", origin: "derived" });
  expect(mounts[0]?.type === "bind" ? mounts[0].relativeTo : undefined).toBeUndefined();
});

test("mount provenance does not change either build-key projection", async () => {
  const mount = {
    type: "bind" as const,
    source: context.appRoot,
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "passthrough" as const,
  };
  const original = { ...base, mounts: [mount] };
  const stamped = { ...base, mounts: [{ ...mount, origin: "service" as const, relativeTo: "app" as const }] };
  const keys = await Effect.runPromise(
    Effect.all([
      buildKeyForService(TestRuntimeProvider, original),
      buildKeyForService(TestRuntimeProvider, stamped),
    ]),
  );
  expect(keys[0]).toBe(keys[1]);
  expect(appBuildKeyForStep({ service: original, stepId: "build", command: "build" })).toBe(
    appBuildKeyForStep({ service: stamped, stepId: "build", command: "build" }),
  );
});
