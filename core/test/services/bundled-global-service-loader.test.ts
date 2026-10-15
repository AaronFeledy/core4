import { describe, expect, test } from "bun:test";
import "../../src/runtime/engine-composition.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Exit, Schema } from "effect";

import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { GlobalAppError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { LandofileShape, type PluginManifest, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import {
  bundledFirstGlobalServiceLoader,
  makeBundledFirstGlobalServiceLoader,
} from "@lando/engine/services/bundled-global-service-loader";
import type {
  GlobalServiceModuleLoader,
  PendingGlobalServiceContribution,
} from "@lando/engine/services/global-services";

const entry = (plugin: string, id: string, module?: string): PendingGlobalServiceContribution => ({
  plugin,
  contribution: module === undefined ? { id } : { id, module },
});

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

const stubManifest = (name: string): PluginManifest =>
  ({
    name,
    version: "0.0.0",
  }) as PluginManifest;

const fakeModule = (
  name: string,
  globalServices?: ReadonlyMap<string, Effect.Effect<ServiceConfig, unknown, never>>,
): LandoPluginModule => ({
  name,
  manifest: stubManifest(name),
  ...(globalServices === undefined ? {} : { globalServices }),
});

const serviceConfig = (type: "compose" | "lando", image?: string): ServiceConfig =>
  ({
    api: 4,
    type,
    ...(image === undefined ? {} : { image }),
  }) as ServiceConfig;

describe("bundled-first global service loader", () => {
  test("plans the bundled SSH sidecar as a ref image with root artifact build steps", async () => {
    // Given
    const config = await Effect.runPromise(
      bundledFirstGlobalServiceLoader.load(entry("@lando/ssh-agent", "ssh-agent", "./src/global-service.ts")),
    );
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "global",
      runtime: 4,
      services: { "ssh-agent": config },
    });
    // When
    const plan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, TestRuntimeProvider.capabilities)).pipe(
        Effect.provide(AppPlannerLayer.layer),
        Effect.provide(PluginRegistryLayer.layer),
      ),
    );
    const sidecar = plan.services[ServiceName.make("ssh-agent")];
    // Then
    expect(sidecar?.artifact).toEqual({ kind: "ref", ref: "alpine:3.20" });
    expect(sidecar?.extensions["@lando/core/service-features"]).toMatchObject({
      buildSteps: [
        {
          id: "authored-artifact:1",
          phase: "build",
          command: ["sh", "-lc", "apk add --no-cache openssh-client socat"],
          user: "root",
        },
      ],
    });
    expect(JSON.stringify(sidecar?.command)).not.toContain("apk");
  });

  test("resolves a bundled plugin's global service from the static map (no dynamic import)", async () => {
    const config = await Effect.runPromise(
      bundledFirstGlobalServiceLoader.load(
        entry("@lando/proxy-traefik", "traefik", "./src/global-services/traefik.ts"),
      ),
    );
    expect(config.type).toBe("compose");
    expect(config.image).toBe("traefik:v3.3");
  });

  test("fails with GlobalAppError when a bundled plugin lacks the requested static entry", async () => {
    const exit = await Effect.runPromiseExit(
      // @lando/service-lando contributes mailpit, but not traefik, in its static globalServices map.
      bundledFirstGlobalServiceLoader.load(entry("@lando/service-lando", "traefik", "./x.ts")),
    );
    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(GlobalAppError);
    if (!(failure instanceof GlobalAppError)) throw new Error("expected GlobalAppError");
    expect(failure.message).toContain("@lando/service-lando");
    expect(failure.message).toContain("traefik");
    expect(failure.remediation).toContain("globalServices");
    expect(failure.remediation).toMatch(/BUNDLED_PLUGIN_MODULES|descriptor/);
    expect(failure.remediation).not.toContain("core/src/plugins/generated/bundled.ts");
  });

  test("falls back to dynamic import for a non-bundled plugin", async () => {
    const moduleRoot = await mkdtemp(join(process.cwd(), ".lando-bundled-loader-"));
    try {
      const modulePath = join(moduleRoot, "external-global-service.mjs");
      await writeFile(
        modulePath,
        'import { Effect } from "effect";\nexport default Effect.succeed({ api: 4, type: "lando" });\n',
      );
      const config = await Effect.runPromise(
        bundledFirstGlobalServiceLoader.load(entry("@lando/external-plugin", "ext", modulePath)),
      );
      expect(config.type).toBe("lando");
    } finally {
      await rm(moduleRoot, { recursive: true, force: true });
    }
  });

  test("resolves a hit from injected descriptor modules", async () => {
    const loader = makeBundledFirstGlobalServiceLoader({
      modules: [
        fakeModule(
          "@lando/fake-proxy",
          new Map([["edge", Effect.succeed(serviceConfig("compose", "edge:1"))]]),
        ),
      ],
    });
    const config = await Effect.runPromise(loader.load(entry("@lando/fake-proxy", "edge", "./unused.ts")));
    expect(config.type).toBe("compose");
    expect(config.image).toBe("edge:1");
  });

  test("preserves GlobalAppError shape on miss against injected descriptor modules", async () => {
    const loader = makeBundledFirstGlobalServiceLoader({
      modules: [fakeModule("@lando/fake-proxy", new Map())],
    });
    const exit = await Effect.runPromiseExit(
      loader.load(entry("@lando/fake-proxy", "missing-svc", "./x.ts")),
    );
    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(GlobalAppError);
    if (!(failure instanceof GlobalAppError)) throw new Error("expected GlobalAppError");
    expect(failure._tag).toBe("GlobalAppError");
    expect(failure.operation).toBe("regenerateDist");
    expect(failure.message).toContain("@lando/fake-proxy");
    expect(failure.message).toContain("missing-svc");
    expect(failure.remediation).toContain("globalServices");
    expect(failure.remediation).toMatch(/BUNDLED_PLUGIN_MODULES|descriptor/);
    expect(failure.remediation).not.toContain("core/src/plugins/generated/bundled.ts");
  });

  test("uses injected fallback when plugin is absent from descriptor modules", async () => {
    let fallbackCalls = 0;
    const fallback: GlobalServiceModuleLoader = {
      load: (_pending) => {
        fallbackCalls += 1;
        return Effect.succeed(serviceConfig("lando"));
      },
    };
    const loader = makeBundledFirstGlobalServiceLoader({
      modules: [fakeModule("@lando/other")],
      fallback,
    });
    const config = await Effect.runPromise(loader.load(entry("@lando/absent", "svc", "./x.ts")));
    expect(fallbackCalls).toBe(1);
    expect(config.type).toBe("lando");
  });
});
