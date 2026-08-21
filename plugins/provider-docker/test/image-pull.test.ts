import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  type DockerApiClient,
  type DockerHttpRequest,
  type DockerHttpResponse,
  buildImagePullRequest,
  makeRuntimeProvider,
  parseImagePullFrame,
  parseImageReference,
} from "@lando/provider-docker";
import { ProviderUnavailableError, type ServiceStartError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("docker");
const appId = AppId.make("mailpit-app");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-21T00:00:00Z"),
  source: "provider-docker/image-pull.test.ts",
  runtime: 4 as const,
};

const mailpitRef = "axllent/mailpit:v1.30.1";
const traefikRef = "traefik:v3.3";

const makeService = (name: string, ref: string): ServicePlan => ({
  name: ServiceName.make(name),
  type: "test",
  provider: providerId,
  primary: name === "mailpit",
  artifact: { kind: "ref", ref },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
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

const recordImagePull = (images: Set<string>, path: string): void => {
  const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const fromImage = params.get("fromImage") ?? "";
  const tag = params.get("tag") ?? "";
  if (fromImage.length === 0) return;
  images.add(fromImage);
  if (tag.length > 0) {
    images.add(`${fromImage}:${tag}`);
    images.add(`${fromImage}@${tag}`);
  }
};

interface FakeApiOptions {
  readonly images?: Set<string>;
  readonly pullBody?: string;
  readonly pullStatus?: number;
  readonly inspectStatus?: number;
  readonly createStatus?: number;
  readonly createStatuses?: ReadonlyArray<number>;
  readonly createBody?: string;
}

const makeFakeApi = (options: FakeApiOptions = {}) => {
  const requests: string[] = [];
  const images = options.images ?? new Set<string>();
  const createStatus = options.createStatus ?? 201;
  const createStatuses = options.createStatuses;
  const createBody = options.createBody ?? "";
  let createIndex = 0;
  const responseFor = (method: string, path: string): DockerHttpResponse => {
    if (path === "/networks/create") return { status: 201, body: "" };
    if (method === "GET" && path.startsWith("/images/") && path.endsWith("/json")) {
      const ref = decodeURIComponent(path.slice("/images/".length, -"/json".length));
      if (options.inspectStatus !== undefined) {
        return {
          status: options.inspectStatus,
          body: JSON.stringify({ message: `inspect HTTP ${options.inspectStatus}` }),
        };
      }
      if (!images.has(ref)) {
        return { status: 404, body: JSON.stringify({ message: `No such image: ${ref}` }) };
      }
      return {
        status: 200,
        body: JSON.stringify({ Id: "sha256:test", RepoDigests: [`${ref}@sha256:test`] }),
      };
    }
    if (method === "POST" && path.startsWith("/images/create?")) {
      if ((options.pullStatus ?? 200) >= 200 && (options.pullStatus ?? 200) < 300) {
        recordImagePull(images, path);
      }
      return {
        status: options.pullStatus ?? 200,
        body: options.pullBody ?? '{"status":"Pull complete"}\n',
      };
    }
    if (method === "GET" && path.startsWith("/containers/") && path.endsWith("/json")) {
      return { status: 404, body: "" };
    }
    if (path.startsWith("/containers/create?")) {
      const status = createStatuses?.[createIndex] ?? createStatus;
      createIndex += 1;
      return { status, body: createBody };
    }
    if (path.endsWith("/start")) return { status: 204, body: "" };
    if (path.endsWith("/stop")) return { status: 204, body: "" };
    if (method === "DELETE") return { status: 204, body: "" };
    return { status: 500, body: '{"message":"unexpected request"}' };
  };
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: ({ method, path }: DockerHttpRequest) => {
      requests.push(`${method} ${path}`);
      return Effect.succeed(responseFor(method, path));
    },
  };
  return { api, requests };
};

const apply = async (plan: AppPlan, api: DockerApiClient) => {
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  return Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: false })));
};

const applyFailure = async (plan: AppPlan, api: DockerApiClient) => {
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: api }));
  return Effect.runPromise(Effect.flip(Effect.scoped(provider.apply(plan, { reconcile: false }))));
};

describe("buildImagePullRequest", () => {
  test("targets Docker Engine /images/create with encoded fromImage and tag", () => {
    const mailpit = buildImagePullRequest(mailpitRef);
    expect(mailpit.method).toBe("POST");
    expect(mailpit.path.startsWith("/images/create?")).toBe(true);
    expect(mailpit.path).not.toContain("/libpod/images/pull");
    expect(mailpit.path).toContain(`fromImage=${encodeURIComponent("axllent/mailpit")}`);
    expect(mailpit.path).toContain(`tag=${encodeURIComponent("v1.30.1")}`);

    const traefik = buildImagePullRequest(traefikRef);
    expect(traefik.path).toContain("fromImage=traefik");
    expect(traefik.path).toContain("tag=v3.3");

    const registryHost = buildImagePullRequest("docker.io/axllent/mailpit:v1.30.1");
    expect(registryHost.path).toContain(`fromImage=${encodeURIComponent("docker.io/axllent/mailpit")}`);
    expect(registryHost.path).toContain(`tag=${encodeURIComponent("v1.30.1")}`);
  });

  test("splits digest references onto the tag query parameter", () => {
    const request = buildImagePullRequest(
      "traefik@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(request.path).toContain("fromImage=traefik");
    expect(request.path).toContain(
      `tag=${encodeURIComponent("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")}`,
    );
  });

  test("strips the tag from name:tag@digest so fromImage is the name", () => {
    const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(parseImageReference(`nginx:latest@${digest}`)).toEqual({ fromImage: "nginx", tag: digest });
    expect(parseImageReference(`docker.io/library/nginx:stable@${digest}`)).toEqual({
      fromImage: "docker.io/library/nginx",
      tag: digest,
    });
    const request = buildImagePullRequest(`nginx:stable@${digest}`);
    expect(request.path).toContain("fromImage=nginx");
    expect(request.path).toContain(`tag=${encodeURIComponent(digest)}`);
    expect(request.path).not.toContain(encodeURIComponent("nginx:stable"));
  });

  test("defaults an untagged name to latest so the daemon does not pull every tag", () => {
    expect(parseImageReference("nginx")).toEqual({ fromImage: "nginx", tag: "latest" });
    expect(parseImageReference("localhost:5000/team/app")).toEqual({
      fromImage: "localhost:5000/team/app",
      tag: "latest",
    });
  });
});

describe("parseImagePullFrame", () => {
  test("maps Docker {status,progressDetail} frames to progress", () => {
    expect(
      parseImagePullFrame(
        '{"status":"Downloading","id":"abc","progressDetail":{"current":1048576,"total":1234567}}',
      ),
    ).toEqual({
      kind: "progress",
      stream: "Downloading",
      current: 1048576,
      total: 1234567,
    });
  });

  test("maps {error} and {errorDetail} frames to pull failures", () => {
    expect(parseImagePullFrame('{"error":"manifest unknown"}')).toEqual({
      kind: "error",
      message: "manifest unknown",
    });
    expect(parseImagePullFrame('{"errorDetail":{"message":"denied"},"error":"denied"}')).toEqual({
      kind: "error",
      message: "denied",
    });
  });

  test("ignores blank lines and unparseable JSON without throwing", () => {
    expect(parseImagePullFrame("")).toEqual({ kind: "ignore" });
    expect(parseImagePullFrame("   ")).toEqual({ kind: "ignore" });
    expect(parseImagePullFrame("not-json")).toEqual({ kind: "ignore" });
    expect(parseImagePullFrame('{"id":"onlyid"}')).toEqual({ kind: "ignore" });
  });
});

describe("provider-docker pullArtifact", () => {
  test("POSTs /images/create and returns providerId docker with the ref", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: fake.api }));

    const result = await Effect.runPromise(provider.pullArtifact({ ref: mailpitRef }));

    expect(result).toMatchObject({ providerId: "docker", ref: mailpitRef, digest: "sha256:test" });
    expect(fake.requests).toContain(`POST ${buildImagePullRequest(mailpitRef).path}`);
    expect(fake.requests.some((entry) => entry.startsWith("POST /images/create?"))).toBe(true);
    expect(fake.requests.some((entry) => entry.includes("/libpod/images/pull"))).toBe(false);
  });

  test("treats HTTP 200 NDJSON with error/errorDetail as a pull failure", async () => {
    const fake = makeFakeApi({
      pullBody:
        '{"status":"Pulling"}\n{"error":"manifest unknown","errorDetail":{"message":"manifest unknown"}}\n',
    });
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: fake.api }));

    const failure = await Effect.runPromise(Effect.flip(provider.pullArtifact({ ref: mailpitRef })));

    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure._tag).toBe("ProviderUnavailableError");
    expect(failure.message).toContain("manifest unknown");
    expect(failure.remediation ?? "").not.toMatch(/lando destroy/u);
    expect(failure.remediation).toContain("lando doctor --provider=docker");
  });

  test("fails the pull when post-pull inspect is not 200", async () => {
    const fake = makeFakeApi({ inspectStatus: 404 });
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: fake.api }));

    const failure = await Effect.runPromise(Effect.flip(provider.pullArtifact({ ref: mailpitRef })));

    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure._tag).toBe("ProviderUnavailableError");
    expect(failure.message).toContain("post-pull inspect HTTP 404");
    expect(failure.remediation ?? "").not.toMatch(/lando destroy/u);
    expect(failure.remediation).toContain("lando doctor --provider=docker");
    expect(fake.requests.some((entry) => entry.startsWith("POST /images/create?"))).toBe(true);
    expect(fake.requests.some((entry) => entry.startsWith("GET /images/") && entry.endsWith("/json"))).toBe(
      true,
    );
  });
});

describe("provider-docker apply image pull", () => {
  test("pulls a missing image before container create", async () => {
    const fake = makeFakeApi();
    const plan = makePlan([makeService("mailpit", mailpitRef)]);

    await apply(plan, fake.api);

    const inspect = fake.requests.indexOf(`GET /images/${encodeURIComponent(mailpitRef)}/json`);
    const pull = fake.requests.indexOf(`POST ${buildImagePullRequest(mailpitRef).path}`);
    const create = fake.requests.indexOf("POST /containers/create?name=lando-mailpit-app-mailpit");
    expect(inspect).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(inspect);
    expect(create).toBeGreaterThan(pull);
    expect(fake.requests.filter((entry) => entry.startsWith("POST /containers/create")).length).toBe(1);
  });

  test("inspect-200 plus create-404 pulls once and retries create", async () => {
    const fake = makeFakeApi({
      images: new Set([mailpitRef]),
      createStatuses: [404, 201],
      createBody: JSON.stringify({ message: `No such image: ${mailpitRef}` }),
    });
    const plan = makePlan([makeService("mailpit", mailpitRef)]);

    await apply(plan, fake.api);

    const firstCreate = fake.requests.findIndex((entry) => entry.startsWith("POST /containers/create"));
    const pull = fake.requests.findIndex((entry) => entry.startsWith("POST /images/create?"));
    const secondCreate = fake.requests.findIndex(
      (entry, index) => index > pull && entry.startsWith("POST /containers/create"),
    );
    expect(pull).toBeGreaterThan(firstCreate);
    expect(secondCreate).toBeGreaterThan(pull);
    expect(fake.requests.filter((entry) => entry.startsWith("POST /images/create?"))).toHaveLength(1);
    expect(fake.requests.filter((entry) => entry.startsWith("POST /containers/create"))).toHaveLength(2);
  });

  test("inspect-200 plus create-404 still fails after one pull if retry create is not 201", async () => {
    const fake = makeFakeApi({
      images: new Set([mailpitRef]),
      createStatus: 404,
      createBody: JSON.stringify({ message: `No such image: ${mailpitRef}` }),
    });
    const plan = makePlan([makeService("mailpit", mailpitRef)]);

    const failure = await applyFailure(plan, fake.api);

    expect(failure).toMatchObject({ _tag: "ServiceStartError", service: "mailpit" });
    const startError = failure as ServiceStartError;
    expect(startError.message).toContain("No such image");
    expect(startError.remediation ?? "").not.toMatch(/lando destroy/u);
    expect(startError.remediation).toContain("lando doctor --provider=docker");
    expect(fake.requests.filter((entry) => entry.startsWith("POST /images/create?"))).toHaveLength(1);
    expect(fake.requests.filter((entry) => entry.startsWith("POST /containers/create"))).toHaveLength(2);
  });

  test("does not recommend lando destroy when image pull fails during apply", async () => {
    const fake = makeFakeApi({
      pullBody: '{"errorDetail":{"message":"denied for axllent/mailpit:v1.30.1"},"error":"denied"}\n',
    });
    const plan = makePlan([makeService("mailpit", mailpitRef)]);

    const failure = await applyFailure(plan, fake.api);

    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect((failure as ProviderUnavailableError).remediation ?? "").not.toMatch(/lando destroy/u);
    expect(fake.requests.some((entry) => entry.startsWith("POST /containers/create"))).toBe(false);
  });
});
