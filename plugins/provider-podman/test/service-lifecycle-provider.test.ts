import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Exit } from "effect";

import type { EngineHttpRequest, EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { makePluginStateStore } from "@lando/core/testing";
import { type PodmanApiClient, makeRuntimeProvider } from "@lando/provider-podman";
import { ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { makeStateStore } from "@lando/state-store/service";
import { persistAppliedPlan } from "../src/applied-state.ts";

const providerId = ProviderId.make("podman");
const appId = AppId.make("lifecycle-app");
const missingAppId = AppId.make("missing-lifecycle-app");
const serviceName = ServiceName.make("web");
const containerName = "lando-lifecycle-app-web";
const lifecycleActions = ["start", "stop", "restart"] as const;
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-22T00:00:00Z"),
  source: "provider-podman/service-lifecycle.test.ts",
  runtime: 4 as const,
};

const service: ServicePlan = {
  name: serviceName,
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "busybox:1.37" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "Lifecycle App",
  slug: "lifecycle-app",
  root: AbsolutePath.make("/tmp/lifecycle-app"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const target = { app: appId, service: serviceName };
const missingPlanTarget = { app: missingAppId, service: serviceName };
const temporaryDirectories: string[] = [];

const makeFakeApi = (response: EngineHttpResponse) => {
  const calls: EngineHttpRequest[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.void,
    request: (input) => {
      calls.push(input);
      return Effect.succeed(response);
    },
  };
  return { api, calls };
};

const makeProvider = async (api: PodmanApiClient) => {
  const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-podman-lifecycle-"));
  temporaryDirectories.push(stateDir);
  const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
  await Effect.runPromise(persistAppliedPlan(state, plan));
  return Effect.runPromise(
    makeRuntimeProvider({
      podmanApi: api,
      platform: "linux",
      env: {},
      conflictDetector: () => Effect.void,
      appliedPlanState: state,
    }),
  );
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const hasStringTag = (value: object): value is { readonly _tag: string } =>
  typeof Reflect.get(value, "_tag") === "string";

const typedFailure = (exit: Exit.Exit<unknown, unknown>): { readonly _tag: string } => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    throw new Error("expected a typed failure");
  }
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") {
    throw new Error("expected a typed failure");
  }
  const value = failure.value;
  if (typeof value !== "object" || value === null || !hasStringTag(value)) {
    throw new Error("expected a tagged failure");
  }
  return value;
};

describe("provider-podman service lifecycle", () => {
  for (const action of lifecycleActions) {
    test(`issues POST /${action} for the planned container and does not DELETE`, async () => {
      // Given
      const fake = makeFakeApi({ status: 204, body: "" });
      const provider = await makeProvider(fake.api);

      // When
      await Effect.runPromise(provider[action](target));

      // Then
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.method).toBe("POST");
      expect(fake.calls[0]?.path.endsWith(`/${action}`)).toBe(true);
      expect(fake.calls[0]?.path.includes(containerName)).toBe(true);
      expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
    });

    test(`treats HTTP 304 as success for ${action}`, async () => {
      // Given
      const fake = makeFakeApi({ status: 304, body: "" });
      const provider = await makeProvider(fake.api);

      // When
      const exit = await Effect.runPromiseExit(provider[action](target));

      // Then
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.path.endsWith(`/${action}`)).toBe(true);
    });

    test(`fails with ServiceNotFoundError when ${action} returns HTTP 404`, async () => {
      // Given
      const fake = makeFakeApi({ status: 404, body: "" });
      const provider = await makeProvider(fake.api);

      // When
      const exit = await Effect.runPromiseExit(provider[action](target));

      // Then
      expect(typedFailure(exit)).toBeInstanceOf(ServiceNotFoundError);
    });

    test(`fails like waitForExit when ${action} has no applied plan`, async () => {
      // Given
      const fake = makeFakeApi({ status: 204, body: "" });
      const provider = await makeProvider(fake.api);

      // When
      const waitFailure = typedFailure(
        await Effect.runPromiseExit(Effect.scoped(provider.waitForExit(missingPlanTarget))),
      );
      const actionFailure = typedFailure(await Effect.runPromiseExit(provider[action](missingPlanTarget)));

      // Then
      expect(actionFailure._tag).toBe(waitFailure._tag);
      expect(actionFailure).toBeInstanceOf(ProviderUnavailableError);
      if (actionFailure instanceof ProviderUnavailableError) {
        expect(actionFailure.message).toContain("No applied plan found for app");
      }
    });
  }
});
