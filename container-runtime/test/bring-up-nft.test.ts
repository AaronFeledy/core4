import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import type { EngineHttpApi, EngineHttpResponse } from "../src/engine-api.ts";
import { APPLY_REMEDIATION, type BringUpOptions, bringUp } from "../src/podman/bring-up.ts";

const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry." } as const;
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-01T00:00:00Z"),
  source: "container-runtime/bring-up-nft.test.ts",
  runtime: 4 as const,
};

const service: ServicePlan = {
  name: serviceName,
  type: "web",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
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
  id: AppId.make("start-remediation"),
  name: "Start Remediation",
  slug: "start-remediation",
  root: AbsolutePath.make("/tmp/lando-start-remediation"),
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  networking: { perAppBridge: { name: "start-remediation-network", driver: "bridge" } },
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

/** Fake libpod API whose container start always fails with the given body. */
const failingStartApi = (startBody: string): EngineHttpApi => ({
  request: (request) =>
    Effect.sync((): EngineHttpResponse => {
      if (request.method === "GET" && request.path.startsWith("/networks/")) {
        return { status: 200, body: "{}" };
      }
      if (request.method === "GET" && request.path.endsWith("/json")) {
        return { status: 404, body: "{}" };
      }
      if (request.method === "POST" && request.path.startsWith("/containers/create")) {
        return { status: 201, body: "{}" };
      }
      if (request.method === "POST" && request.path.endsWith("/start")) {
        return { status: 500, body: startBody };
      }
      return { status: 204, body: "" };
    }),
});

const startFailure = async (
  overrides: Pick<BringUpOptions, "startFailureRemediation">,
  startBody = '{"message":"synthetic start failure"}',
) =>
  await Effect.runPromise(
    bringUp(plan, { api: failingStartApi(startBody), ctx, ...overrides }).pipe(Effect.flip),
  );

describe("bringUp start-failure remediation hook", () => {
  test("Given no hook, When a service fails to start, Then the neutral APPLY remediation is used", async () => {
    // Given / When
    const error = await startFailure({});

    // Then
    expect(error._tag).toBe("ServiceStartError");
    expect(error.remediation).toBe(APPLY_REMEDIATION);
    expect(APPLY_REMEDIATION).toContain("lando destroy");
    expect(APPLY_REMEDIATION).toContain("lando doctor");
  });

  test("Given a hook, When a service fails to start, Then it receives the service, message, and details", async () => {
    // Given
    const seen: Array<{ service: string; message: string; details?: unknown }> = [];

    // When
    await startFailure({
      startFailureRemediation: (input) => {
        seen.push({ ...input });
        return "hook remediation";
      },
    });

    // Then
    const first = seen[0];
    expect(first?.service).toBe("web");
    expect(first?.message).toContain("Podman container start failed with HTTP 500.");
    expect(first?.message).toContain("synthetic start failure");
    expect(first?.details).toMatchObject({ status: 500 });
  });

  test("Given a hook that returns a string, When a service fails to start, Then the hook return wins", async () => {
    // Given / When
    const error = await startFailure({
      startFailureRemediation: () =>
        "Netavark could not find nft. Run `lando setup` so Lando can provision nft into the managed runtime.",
    });

    // Then
    expect(error.remediation).toMatch(/lando setup/u);
    expect(error.remediation).not.toBe(APPLY_REMEDIATION);
  });

  test("Given a hook that declines with undefined, When a service fails to start, Then the neutral default is used", async () => {
    // Given / When
    const error = await startFailure({ startFailureRemediation: () => undefined });

    // Then
    expect(error.remediation).toBe(APPLY_REMEDIATION);
  });

  test("Given a hook, When it inspects an nft-shaped body, Then it can key off the redacted-free message it was given", async () => {
    // Given
    const nftBody =
      '{"message":"netavark: nftables error: unable to execute \\"nft\\": No such file or directory (os error 2)"}';
    const messages: string[] = [];

    // When
    const error = await startFailure(
      {
        startFailureRemediation: ({ message }) => {
          messages.push(message);
          return /unable to execute ["']nft["']/iu.test(message)
            ? "provision nft via lando setup"
            : undefined;
        },
      },
      nftBody,
    );

    // Then
    expect(messages[0]).toContain('unable to execute "nft"');
    expect(error.remediation).toBe("provision nft via lando setup");
  });
});

describe("bringUp provider identity", () => {
  test("Given a podman ctx and no API client, When bringing up, Then the failure is tagged with that providerId", async () => {
    // Given / When
    const error = await Effect.runPromise(bringUp(plan, { ctx }).pipe(Effect.flip));

    // Then
    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.providerId).toBe("podman");
    expect(error.message).toContain("provider-podman");
    expect(error.remediation).toBe(ctx.remediation);
  });

  test("Given a podman ctx and a failing network create, When bringing up, Then the failure is tagged with that providerId", async () => {
    // Given
    const api: EngineHttpApi = {
      request: (request) =>
        Effect.succeed(
          request.method === "GET" && request.path.startsWith("/networks/")
            ? { status: 404, body: "{}" }
            : { status: 500, body: '{"message":"network create refused"}' },
        ),
    };

    // When
    const error = await Effect.runPromise(bringUp(plan, { api, ctx }).pipe(Effect.flip));

    // Then
    expect(error.providerId).toBe("podman");
    expect(error.operation).toBe("bringUp.network");
    expect(error.message).toContain("network create refused");
  });
});
