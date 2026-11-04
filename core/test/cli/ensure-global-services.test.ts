import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Exit } from "effect";

import { GlobalServiceMissingError } from "@lando/core/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/core/schema";
import {
  ensureGlobalServicesRunning,
  requiredGlobalServicesForPlan,
} from "@lando/engine/operations/ensure-global-services";
import { type Harness, makeHarness } from "../_support/ensure-global-harness.ts";

const providerId = ProviderId.make("docker");

const withTempRoots = async <T>(run: (dataRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-ensure-global-data-")));
  const confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-ensure-global-conf-")));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    await writeFile(join(confRoot, "config.yml"), "defaultProviderId: docker\n");
    return await run(dataRoot);
  } finally {
    if (previousData === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    if (previousConf === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

const withHarness = async <T>(
  run: (harness: Harness) => Promise<T>,
  serviceIds?: ReadonlyArray<string>,
): Promise<T> =>
  withTempRoots(async (dataRoot) => {
    const moduleRoot = await realpath(await mkdtemp(join(process.cwd(), ".lando-ensure-global-module-")));
    try {
      const harness = await makeHarness(dataRoot, moduleRoot, serviceIds);
      return await run(harness);
    } finally {
      await rm(moduleRoot, { recursive: true, force: true });
    }
  });

const appPlan: AppPlan = {
  id: AppId.make("ensure-global-services"),
  name: "ensure-global-services",
  slug: "ensure-global-services",
  root: AbsolutePath.make("/tmp/ensure-global-services"),
  provider: providerId,
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
    source: "ensure-global-services.test",
    runtime: 4,
  },
  extensions: {},
  requires: { globalServices: ["traefik"] },
};

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findErrorOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

describe("ensureGlobalServicesRunning", () => {
  test("reads required global services from AppPlan.requires", () => {
    expect(requiredGlobalServicesForPlan(appPlan)).toEqual(["traefik"]);
    expect(requiredGlobalServicesForPlan({})).toEqual([]);
  });

  test("cold ensure publishes pre/post-global-start and applies the selected global service", async () => {
    await withHarness(async (harness) => {
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        join(harness.dataRoot, "global", ".lando.local.yml"),
        'services:\n  traefik:\n    environment:\n      TOKEN: "${secret:GLOBAL_TOKEN}"\n',
      );
      const result = await Effect.runPromise(
        ensureGlobalServicesRunning({ services: ["traefik"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(result.app).toBe("global");
      expect(result.servicesStarted.map((service) => service.name)).toEqual(["traefik"]);
      expect(harness.applyCalls).toHaveLength(1);
      expect(String(harness.applyCalls[0]?.plan.id)).toBe("global");
      expect(Object.keys(harness.applyCalls[0]?.plan.services ?? {})).toEqual(["traefik"]);
      expect(harness.applyCalls[0]?.options.reconcile).toBe(false);
      expect(harness.applyCalls[0]?.environments[ServiceName.make("traefik")]).toMatchObject({
        TOKEN: "resolved-global-token",
      });
      expect(harness.applyCalls[0]?.plan.services[ServiceName.make("traefik")]?.environment).toEqual({
        LANDO_HOST_IP: "host.lando.internal",
        TOKEN: { _tag: "SecretRef", reference: "GLOBAL_TOKEN" },
      });
      expect(harness.operations).toEqual(["build", "apply"]);
      expect([...new Set(harness.inspectCalls.map((call) => String(call.target.service)))]).toEqual([
        "traefik",
      ]);
      expect(harness.selectedProviders.at(-1)).toBe("docker");

      const lifecycle = harness.events.filter(
        (event) => event._tag === "pre-global-start" || event._tag === "post-global-start",
      );
      expect(lifecycle.map((event) => event._tag)).toEqual(["pre-global-start", "post-global-start"]);
      const pre = lifecycle[0] as {
        readonly triggeredBy?: string;
        readonly ensuringServices?: ReadonlyArray<string>;
        readonly cached?: boolean;
      };
      expect(pre.triggeredBy).toBe("ensure-running");
      expect(pre.ensuringServices).toEqual(["traefik"]);
      expect(pre.cached).toBe(false);
      expect((lifecycle[1] as { readonly cached?: boolean }).cached).toBe(false);
    });
  });

  test("a cold selected ensure excludes never-started siblings from recorded metadata", async () => {
    await withHarness(
      async (harness) => {
        // Given two available contributions, ensure only the router.
        await Effect.runPromise(
          ensureGlobalServicesRunning({ services: ["traefik"] }).pipe(Effect.provide(harness.layer)),
        );
        // Then execution and recorded evidence include only the service actually started.
        const call = harness.applyCalls[0];
        expect(Object.keys(call?.plan.services ?? {})).toEqual(["traefik"]);
        expect(Object.keys(call?.options.recordedPlan?.services ?? {})).toEqual(["traefik"]);
      },
      ["traefik", "ssh-agent"],
    );
  });

  test("selected ensure preserves an observed previously started sibling in recorded metadata", async () => {
    await withHarness(
      async (harness) => {
        await Effect.runPromise(
          ensureGlobalServicesRunning({ services: ["ssh-agent"] }).pipe(Effect.provide(harness.layer)),
        );
        const prior = harness.applyCalls[0]?.options.recordedPlan;
        const sibling = prior?.services[ServiceName.make("ssh-agent")];
        if (prior === undefined || sibling === undefined) throw new Error("fixture must start the sibling");
        await Effect.runPromise(
          ensureGlobalServicesRunning({ services: ["traefik"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(harness.applyCalls).toHaveLength(2);
        const selected = harness.applyCalls[1];
        expect(Object.keys(selected?.plan.services ?? {})).toEqual(["traefik"]);
        expect(Object.keys(selected?.options.recordedPlan?.services ?? {}).sort()).toEqual([
          "ssh-agent",
          "traefik",
        ]);
        const recorded = selected?.options.recordedPlan;
        const retained = recorded?.services[ServiceName.make("ssh-agent")];
        if (recorded === undefined || retained === undefined)
          throw new Error("fixture must retain the sibling");
        expect({ ...retained, routes: [] }).toEqual({ ...sibling, routes: [] });
        expect(retained.routes.map((ref) => recorded.routes[ref.index])).toEqual(
          sibling.routes.map((ref) => prior.routes[ref.index]),
        );
      },
      ["traefik", "ssh-agent"],
    );
  });

  test("missing requested services publish pre-global-start and fail without post-global-start", async () => {
    await withHarness(async (harness) => {
      const exit = await Effect.runPromiseExit(
        ensureGlobalServicesRunning({ services: ["mailpit"] }).pipe(Effect.provide(harness.layer)),
      );

      const error = failureOf(exit);
      expect(error).toBeInstanceOf(GlobalServiceMissingError);
      if (error instanceof GlobalServiceMissingError) {
        expect(error.requested).toEqual(["mailpit"]);
        expect(error.available).toEqual(["traefik"]);
        expect(error.message).toBe("Global service(s) not available in the global app: mailpit.");
        expect("missing" in error).toBe(false);
      }
      expect(harness.applyCalls).toEqual([]);
      expect(harness.inspectCalls).toEqual([]);
      const lifecycle = harness.events.filter(
        (event) => event._tag === "pre-global-start" || event._tag === "post-global-start",
      );
      expect(lifecycle.map((event) => event._tag)).toEqual(["pre-global-start"]);
      expect((lifecycle[0] as { readonly triggeredBy?: string }).triggeredBy).toBe("ensure-running");
    });
  });
});
