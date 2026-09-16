import { expect } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";

import { bringDown, bringUp, makePodmanApiClient, pullImage } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import { landoErrorPage } from "../../src/services/http-errors.ts";
import { nginxServiceType } from "../../src/services/nginx.ts";
import { php83ServiceType } from "../../src/services/php.ts";
import { staticNginxServiceType } from "../../src/services/static.ts";
import { composeServicePlan } from "./compose-harness.ts";
import type { ErrorPageCase } from "./http-error-pages-cases.ts";

const providerId = ProviderId.make("lando");
const metadata = {
  resolvedAt: "2026-09-13T00:00:00Z",
  source: "http-error-pages-live.integration.test",
  runtime: 4 as const,
};

export type ErrorPageServer = "static" | "nginx-fpm" | "apache";

const HOST_PORTS: Readonly<Record<ErrorPageServer, number>> = {
  static: 31088,
  "nginx-fpm": 31089,
  apache: 31090,
};

interface ServiceSpec {
  readonly name: string;
  readonly serviceType: ServiceType;
  readonly config: Record<string, unknown>;
}

// The Landofile shapes a user would author. PHP services omit `image:` so the
// planner emits the Lando-owned Apache/FPM start commands; the stock base image
// still runs them because the skipped build steps only add Composer and Xdebug.
const serviceSpecs = (server: ErrorPageServer, hostPort: number): ReadonlyArray<ServiceSpec> => {
  const ports = [`127.0.0.1:${hostPort}:80`];
  switch (server) {
    case "static":
      return [
        { name: "web", serviceType: staticNginxServiceType, config: { type: "static", root: "dist", ports } },
      ];
    case "nginx-fpm":
      return [
        {
          name: "appserver",
          serviceType: php83ServiceType,
          config: { type: "php:8.3", via: "fpm", xdebug: false },
        },
        {
          name: "edge",
          serviceType: nginxServiceType,
          config: { type: "nginx", backend: "appserver", ports },
        },
      ];
    case "apache":
      return [
        {
          name: "appserver",
          serviceType: php83ServiceType,
          config: { type: "php:8.3", via: "apache", xdebug: false, ports },
        },
      ];
    default: {
      const exhaustive: never = server;
      throw new Error(`unhandled server ${String(exhaustive)}`);
    }
  }
};

const decodeService = (appName: string, spec: ServiceSpec): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: appName,
    services: { [spec.name]: spec.config },
  });
  const service = landofile.services?.[ServiceName.make(spec.name)];
  if (service === undefined) throw new Error(`${spec.name} service missing`);
  return service;
};

const writeFixtures = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  // Server workers run as an unprivileged container user, so the app root must
  // stay traversable beyond the owner that `mkdtemp` restricts it to.
  await chmod(root, 0o755);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o644 });
  }
};

/** The HTTP client the owning test lends to the harness; support code never reaches for global fetch. */
export type HttpClient = typeof fetch;

export interface ErrorPageStackOptions {
  readonly socketPath: string;
  readonly server: ErrorPageServer;
  readonly files: Readonly<Record<string, string>>;
  readonly request: HttpClient;
}

export interface ErrorPageStack {
  readonly server: ErrorPageServer;
  readonly baseUrl: string;
  readonly request: HttpClient;
  readonly stop: () => Promise<void>;
}

export const startErrorPageStack = async ({
  socketPath,
  server,
  files,
  request,
}: ErrorPageStackOptions): Promise<ErrorPageStack> => {
  const slug = `errpages-${server}-${crypto.randomUUID().slice(0, 8)}`;
  const root = await mkdtemp(join(tmpdir(), `lando-${slug}-`));
  await writeFixtures(root, files);

  const services: Array<ServicePlan> = [];
  for (const spec of serviceSpecs(server, HOST_PORTS[server])) {
    services.push(
      await composeServicePlan({
        serviceType: spec.serviceType,
        service: decodeService(slug, spec),
        appRoot: root,
        appName: slug,
        serviceName: spec.name,
        metadata,
      }),
    );
  }
  const [first] = services;
  if (first === undefined) throw new Error(`${server} stack has no services`);
  const plan: AppPlan = {
    id: AppId.make(slug),
    name: slug,
    slug,
    root: AbsolutePath.make(root),
    provider: providerId,
    services: Object.fromEntries(services.map((service) => [service.name, service])),
    routes: [],
    networks: [],
    networking: landoNetworkingPlan({
      slug,
      serviceNames: services.map((service) => service.name),
      sharedCrossAppNetwork: false,
    }),
    stores: [],
    fileSync: [],
    metadata: first.metadata,
    extensions: {},
  };
  const api = makePodmanApiClient(socketPath);
  const baseUrl = `http://127.0.0.1:${HOST_PORTS[server]}`;
  const stop = async () => {
    await Effect.runPromise(Effect.either(bringDown(plan, { api })));
    await rm(root, { recursive: true, force: true });
  };

  try {
    for (const service of services) {
      if (service.artifact?.kind === "ref") await Effect.runPromise(pullImage(api, service.artifact.ref));
    }
    const applied = await Effect.runPromise(bringUp(plan, { api }));
    expect(applied.changed).toBe(true);
    await waitForIndex(request, baseUrl, 120_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return { server, baseUrl, request, stop };
};

const waitForIndex = async (request: HttpClient, baseUrl: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await request(`${baseUrl}/`, { signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel();
      if (response.status === 200) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`web server did not serve its index within ${timeoutMs}ms: ${String(lastError)}`);
};

export const runErrorPageCase = async (stack: ErrorPageStack, testCase: ErrorPageCase): Promise<void> => {
  const response = await stack.request(`${stack.baseUrl}${testCase.path}`, {
    method: testCase.method,
    headers: testCase.accept === undefined ? {} : { Accept: testCase.accept },
    ...(testCase.method === "POST" ? { body: "x=1" } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  // The start command writes each page through a heredoc, so the served file is
  // newline-terminated.
  const expectedBody =
    "page" in testCase.body ? `${landoErrorPage(testCase.body.page)}\n` : testCase.body.exact;

  expect(response.status).toBe(testCase.status);
  expect(body).toBe(testCase.method === "HEAD" ? "" : expectedBody);
  if ("page" in testCase.body) expect(response.headers.get("content-type")).toMatch(/^text\/html/u);
  if (testCase.headers !== undefined) {
    expect(response.headers.get("x-app-marker")).toBe(testCase.headers.marker);
    if (testCase.headers.cookie !== undefined)
      expect(response.headers.get("set-cookie")).toBe(testCase.headers.cookie);
    if (testCase.headers.cacheControl !== undefined) {
      expect(response.headers.get("cache-control")).toBe(testCase.headers.cacheControl);
    }
  }
};
