import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Stream } from "effect";

import { makeRuntimeProvider } from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("testapp");
const appRoot = AbsolutePath.make("/tmp/lando-no-plan-test");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "no-plan.test",
  runtime: 4 as const,
};

const node: ServicePlan = {
  name: ServiceName.make("node"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "setInterval(() => {}, 1000)"],
  environment: {},
  appMount: {
    source: appRoot,
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
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
  name: "Test App",
  slug: "testapp",
  root: appRoot,
  provider: providerId,
  services: { [node.name]: node },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
};

const makeMinimalFakeApi = (): PodmanApiClient => {
  const textEncoder = new TextEncoder();

  const frame = (text: string): Uint8Array => {
    const payload = textEncoder.encode(text);
    const output = new Uint8Array(8 + payload.length);
    output[0] = 1;
    output[4] = (payload.length >>> 24) & 0xff;
    output[5] = (payload.length >>> 16) & 0xff;
    output[6] = (payload.length >>> 8) & 0xff;
    output[7] = payload.length & 0xff;
    output.set(payload, 8);
    return output;
  };

  return {
    info: Effect.succeed({}),
    request: (request: PodmanHttpRequest) =>
      Effect.sync((): PodmanHttpResponse => {
        if (request.method === "POST" && request.path.includes("/exec")) {
          return { status: 201, body: JSON.stringify({ Id: "exec-fake-1" }) };
        }
        if (request.method === "GET" && request.path.includes("/exec/")) {
          return { status: 200, body: JSON.stringify({ ExitCode: 0 }) };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
    stream: (_request: PodmanHttpRequest) => Stream.make(frame("ok\n")),
  };
};

describe("provider-lando no-plan error messages", () => {
  test("exec without an applied plan fails with precise ProviderUnavailableError", async () => {
    const provider = await Effect.runPromise(makeRuntimeProvider());
    const exit = await Effect.runPromiseExit(
      provider.exec({ app: appId, service: node.name }, { command: ["echo", "hi"] }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        const pue = failure.value as ProviderUnavailableError;
        expect(pue.operation).toBe("exec");
        expect(pue.message).toContain("No applied plan found for app");
        expect(pue.message).toContain(appId);
        expect(pue.message).not.toContain("does not implement");
        expect(pue.remediation).toContain("lando start");
      }
    }
  });

  test("execStream without an applied plan fails with precise ProviderUnavailableError", async () => {
    const provider = await Effect.runPromise(makeRuntimeProvider());
    const exit = await Effect.runPromiseExit(
      provider
        .execStream({ app: appId, service: node.name }, { command: ["echo", "hi"] })
        .pipe(Stream.runCollect),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        const pue = failure.value as ProviderUnavailableError;
        expect(pue.operation).toBe("execStream");
        expect(pue.message).toContain("No applied plan found for app");
        expect(pue.message).not.toContain("does not implement");
        expect(pue.remediation).toContain("lando start");
      }
    }
  });

  test("logs without an applied plan fails with precise ProviderUnavailableError", async () => {
    const provider = await Effect.runPromise(makeRuntimeProvider());
    const exit = await Effect.runPromiseExit(
      provider.logs({ app: appId, service: node.name }, {}).pipe(Stream.runCollect),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        const pue = failure.value as ProviderUnavailableError;
        expect(pue.operation).toBe("logs");
        expect(pue.message).toContain("No applied plan found for app");
        expect(pue.message).not.toContain("does not implement");
        expect(pue.remediation).toContain("lando start");
      }
    }
  });

  test("inspect without an applied plan fails with precise ProviderUnavailableError", async () => {
    const provider = await Effect.runPromise(makeRuntimeProvider());
    const exit = await Effect.runPromiseExit(provider.inspect({ app: appId, service: node.name }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        const pue = failure.value as ProviderUnavailableError;
        expect(pue.operation).toBe("inspect");
        expect(pue.message).toContain("No applied plan found for app");
        expect(pue.message).not.toContain("does not implement");
        expect(pue.remediation).toContain("lando start");
      }
    }
  });

  test("exec with target.plan bypasses no-plan guard and reaches the provider", async () => {
    const fakeApi = makeMinimalFakeApi();
    const provider = await Effect.runPromise(makeRuntimeProvider({ podmanApi: fakeApi }));
    const result = await Effect.runPromise(
      provider.exec({ app: appId, service: node.name, plan }, { command: ["echo", "hi"] }),
    );

    expect(result).toHaveProperty("exitCode", 0);
  });
});
