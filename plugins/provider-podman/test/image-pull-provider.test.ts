import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { libpodPullDialect } from "@lando/container-runtime/dialect";
import type {
  EngineHttpRequest,
  EngineHttpResponse,
  PodmanApiClient,
} from "@lando/container-runtime/engine-api";
import { buildImagePullRequest } from "@lando/container-runtime/image-pull";
import { makeRuntimeProvider } from "@lando/provider-podman";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("podman");
const appId = AppId.make("mailpit-app");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-10-01T00:00:00Z"),
  source: "provider-podman/image-pull-provider.test.ts",
  runtime: 4 as const,
};
const mailpitRef = "axllent/mailpit:v1.30.1";

const makeService = (
  name: string,
  ref: string,
  compose?: Record<string, unknown>,
  artifact: ServicePlan["artifact"] = { kind: "ref", ref },
): ServicePlan => ({
  name: ServiceName.make(name),
  type: "test",
  provider: providerId,
  primary: true,
  artifact,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: compose === undefined ? {} : { compose },
});

const makePlan = (services: ReadonlyArray<ServicePlan>): AppPlan => ({
  id: appId,
  name: "Mailpit App",
  slug: "mailpit-app",
  root: AbsolutePath.make("/tmp/mailpit-app"),
  provider: providerId,
  services: Object.fromEntries(services.map((entry) => [entry.name, entry])),
  routes: [],
  networks: [],
  networking: { perAppBridge: { name: "lando-mailpit-app", driver: "bridge" } },
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

interface FakeApiOptions {
  readonly inspectStatus?: number;
  readonly inspectBody?: unknown;
  readonly createStatuses?: ReadonlyArray<number>;
}

const makeFakeApi = (options: FakeApiOptions = {}) => {
  const requests: string[] = [];
  const existing = new Set<string>();
  const running = new Set<string>();
  let createIndex = 0;
  const api: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.void,
    request: (request: EngineHttpRequest) => {
      requests.push(`${request.method} ${request.path}`);
      const responseFor = (): EngineHttpResponse => {
        if (request.method === "GET" && request.path.startsWith("/networks/"))
          return { status: 404, body: "" };
        if (request.path === "/networks/create") return { status: 201, body: "" };
        if (request.method === "GET" && request.path.includes("/images/") && request.path.endsWith("/json")) {
          return {
            status: options.inspectStatus ?? 404,
            body: JSON.stringify(
              options.inspectBody ?? { Os: "linux", Architecture: "arm64", RepoDigests: [] },
            ),
          };
        }
        if (request.method === "POST" && request.path.startsWith("/libpod/images/pull")) {
          return { status: 200, body: '{"status":"Pull complete"}\n' };
        }
        if (
          request.method === "GET" &&
          request.path.startsWith("/containers/") &&
          request.path.endsWith("/json")
        ) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/json".length));
          return existing.has(name)
            ? { status: 200, body: JSON.stringify({ State: { Running: running.has(name) } }) }
            : { status: 404, body: "" };
        }
        if (request.path.startsWith("/containers/create?")) {
          const status = options.createStatuses?.[createIndex] ?? 201;
          createIndex += 1;
          if (status === 201 || status === 409) {
            const name = new URL(`http://localhost${request.path}`).searchParams.get("name");
            if (name !== null) existing.add(name);
          }
          return { status, body: "" };
        }
        if (request.path.endsWith("/start")) {
          running.add(request.path.slice("/containers/".length, -"/start".length));
          return { status: 204, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      };
      return Effect.succeed(responseFor());
    },
  };
  return { api, requests };
};

const apply = async (plan: AppPlan, api: PodmanApiClient) => {
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      platform: "linux",
      env: {},
      podmanApi: api,
      conflictDetector: () => Effect.void,
    }),
  );
  return Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: false })));
};

const applyFailure = async (plan: AppPlan, api: PodmanApiClient) => {
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      platform: "linux",
      env: {},
      podmanApi: api,
      conflictDetector: () => Effect.void,
    }),
  );
  return Effect.runPromise(Effect.flip(Effect.scoped(provider.apply(plan, { reconcile: false }))));
};

describe("provider-podman apply image pull", () => {
  test("pre-pulls a missing image through the same ensure path", async () => {
    const fake = makeFakeApi();
    const plan = makePlan([makeService("mailpit", mailpitRef)]);

    await apply(plan, fake.api);

    const inspect = fake.requests.findIndex(
      (entry) => entry === `GET /libpod/images/${encodeURIComponent(mailpitRef)}/json`,
    );
    const pull = fake.requests.findIndex((entry) =>
      entry.startsWith(`POST ${buildImagePullRequest(mailpitRef, libpodPullDialect).path}`),
    );
    const create = fake.requests.findIndex((entry) => entry.startsWith("POST /containers/create?"));
    expect(inspect).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(inspect);
    expect(create).toBeGreaterThan(pull);
  });

  test("forwards an explicit service platform on the libpod pull", async () => {
    const fake = makeFakeApi();
    const plan = makePlan([makeService("mailpit", mailpitRef, { platform: "linux/amd64" })]);

    await apply(plan, fake.api);

    expect(fake.requests).toContain(
      `POST ${buildImagePullRequest(mailpitRef, libpodPullDialect, { platform: "linux/amd64" }).path}`,
    );
    expect(
      fake.requests.some(
        (entry) => entry.startsWith("POST /libpod/images/pull") && entry.includes("platform="),
      ),
    ).toBe(false);
  });

  test("pulls a wrong-arch registry image with the service platform", async () => {
    const fake = makeFakeApi({
      inspectStatus: 200,
      inspectBody: { Os: "linux", Architecture: "arm64", RepoDigests: [`${mailpitRef}@sha256:test`] },
    });
    const plan = makePlan([makeService("mailpit", mailpitRef, { platform: "linux/amd64" })]);

    await apply(plan, fake.api);

    expect(fake.requests).toContain(
      `POST ${buildImagePullRequest(mailpitRef, libpodPullDialect, { platform: "linux/amd64" }).path}`,
    );
  });

  test("fails a wrong-arch local build without pulling", async () => {
    const fake = makeFakeApi({
      inspectStatus: 200,
      inspectBody: { Os: "linux", Architecture: "arm64", RepoDigests: [] },
    });
    const plan = makePlan([makeService("mailpit", mailpitRef, { platform: "linux/amd64" })]);

    const failure = await applyFailure(plan, fake.api);

    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect((failure as ProviderUnavailableError).message).toContain("linux/arm64");
    expect(fake.requests.some((entry) => entry.startsWith("POST /libpod/images/pull"))).toBe(false);
    expect(fake.requests.some((entry) => entry.startsWith("POST /containers/create"))).toBe(false);
  });

  test("does not pull-pin a build-only service from build.platforms", async () => {
    const fake = makeFakeApi();
    const plan = makePlan([
      makeService(
        "mailpit",
        mailpitRef,
        { build: { platforms: ["linux/amd64"] } },
        { kind: "build", context: AbsolutePath.make("/tmp/mailpit-build"), specInline: "FROM scratch" },
      ),
    ]);

    const failure = await applyFailure(plan, fake.api);

    expect(failure).toMatchObject({ _tag: "ServiceStartError" });
    expect(fake.requests.some((entry) => entry.startsWith("POST /libpod/images/pull"))).toBe(false);
  });
});
