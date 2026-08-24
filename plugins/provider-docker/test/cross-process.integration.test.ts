import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect, Stream } from "effect";

import { makePluginStateStore } from "@lando/core/testing";
import {
  type DockerApiClient,
  type DockerHttpRequest,
  type DockerHttpResponse,
  makeRuntimeProvider,
} from "@lando/provider-docker";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { makeStateStore } from "@lando/state-store/service";

import { appliedPlanPath } from "../src/applied-state.ts";

const providerId = ProviderId.make("docker");
const appId = AppId.make("crossprocessapp");
const appRoot = AbsolutePath.make("/tmp/docker-crossprocess-app");
const webName = ServiceName.make("web");
const containerName = "lando-crossprocessapp-web";

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "cross-process.integration.test",
  runtime: 4 as const,
};

const web: ServicePlan = {
  name: webName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "setInterval(() => {}, 1000)"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [{ _tag: "internal", port: 31082, protocol: "http", name: "http" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "Cross Process App",
  slug: "crossprocessapp",
  root: appRoot,
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const makeFakeApi = () => {
  const existing = new Set<string>();
  const running = new Set<string>();
  const images = new Set<string>();
  const calls: DockerHttpRequest[] = [];

  const responseFor = (method: string, path: string): DockerHttpResponse => {
    if (path === "/networks/create") return { status: 201, body: "" };
    if (method === "POST" && path.startsWith("/networks/") && path.endsWith("/connect")) {
      return { status: 200, body: "" };
    }
    if (path === "/volumes/create") return { status: 201, body: "" };
    if (method === "GET" && path.startsWith("/images/") && path.endsWith("/json")) {
      const ref = decodeURIComponent(path.slice("/images/".length, -"/json".length));
      return images.has(ref)
        ? { status: 200, body: '{"Id":"sha256:test"}' }
        : { status: 404, body: '{"message":"No such image"}' };
    }
    if (method === "POST" && path.startsWith("/images/create?")) {
      const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const fromImage = params.get("fromImage") ?? "";
      const tag = params.get("tag") ?? "";
      if (fromImage.length > 0) {
        images.add(fromImage);
        if (tag.length > 0) {
          images.add(`${fromImage}:${tag}`);
          images.add(`${fromImage}@${tag}`);
        }
      }
      return { status: 200, body: '{"status":"Pull complete"}\n' };
    }
    if (method === "GET" && path.startsWith("/containers/") && path.endsWith("/json")) {
      const name = decodeURIComponent(path.slice("/containers/".length, -"/json".length));
      if (!existing.has(name)) return { status: 404, body: "" };
      return {
        status: 200,
        body: JSON.stringify({
          Id: `id-${name}`,
          State: { Running: running.has(name), Status: running.has(name) ? "running" : "created" },
        }),
      };
    }
    if (method === "POST" && path.startsWith("/containers/create?")) {
      const created = new URL(`http://localhost${path}`).searchParams.get("name") ?? "";
      existing.add(created);
      return { status: 201, body: "" };
    }
    if (method === "POST" && path.endsWith("/start") && path.startsWith("/containers/")) {
      const name = decodeURIComponent(path.slice("/containers/".length, -"/start".length));
      running.add(name);
      return { status: 204, body: "" };
    }
    if (method === "POST" && path.endsWith("/exec") && path.startsWith("/containers/")) {
      return { status: 201, body: JSON.stringify({ Id: "exec-1" }) };
    }
    if (method === "GET" && path === "/exec/exec-1/json") {
      return { status: 200, body: JSON.stringify({ ExitCode: 0 }) };
    }
    if (method === "POST" && path.endsWith("/stop") && path.startsWith("/containers/")) {
      const name = decodeURIComponent(path.slice("/containers/".length, -"/stop".length));
      running.delete(name);
      return existing.has(name) ? { status: 204, body: "" } : { status: 404, body: "" };
    }
    if (method === "DELETE" && path.startsWith("/containers/")) {
      const name = decodeURIComponent(path.slice("/containers/".length).split("?")[0] ?? "");
      const deleted = existing.delete(name);
      running.delete(name);
      return { status: deleted ? 204 : 404, body: "" };
    }
    if (method === "DELETE" && path.startsWith("/networks/")) return { status: 204, body: "" };
    return { status: 500, body: `unexpected ${method} ${path}` };
  };

  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: (input) => {
      calls.push(input);
      return Effect.succeed(responseFor(input.method, input.path));
    },
    stream: (input) => {
      calls.push(input);
      return Stream.empty;
    },
  };
  return { api, calls };
};

const withStateDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "docker-crossprocess-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const makeProvider = (stateDir: string, dockerApi: DockerApiClient) =>
  Effect.runPromise(
    makeRuntimeProvider({
      platform: "linux",
      dockerApi,
      appliedPlanState: makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir)),
      appliedPlanStateDir: stateDir,
      sanitizeAppliedPlan: (applied) => applied,
    }),
  );

const applyPlan = async (stateDir: string, dockerApi: DockerApiClient) => {
  const provider = await makeProvider(stateDir, dockerApi);
  await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: false })));
};

const isUnavailableExec = (error: unknown): boolean => {
  if (!(error instanceof ProviderUnavailableError)) return false;
  return error.message.includes("does not implement exec yet");
};

describe("provider-docker cross-process state", () => {
  test("apply with appliedPlanState writes a version-1 envelope", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakeApi();
      await applyPlan(stateDir, fake.api);

      const path = appliedPlanPath(stateDir, plan.id);
      expect(await fileExists(path)).toBe(true);
      const raw = JSON.parse(await readFile(path, "utf8"));
      expect(raw.version).toBe(1);
      expect(raw.data).toBeDefined();
    });
  });

  test("a fresh provider can exec without a plan after reload", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakeApi();
      await applyPlan(stateDir, fake.api);
      const execCalls = () =>
        fake.calls.filter(
          (call) => call.method === "POST" && call.path === `/containers/${containerName}/exec`,
        );
      const execCallsBefore = execCalls().length;

      const providerB = await makeProvider(stateDir, fake.api);
      const result = await Effect.runPromiseExit(
        providerB.exec({ app: plan.id, service: web.name }, { command: ["true"] }),
      );

      if (result._tag === "Failure") {
        expect(isUnavailableExec(result.cause)).toBe(false);
      }
      expect(result._tag).toBe("Success");
      expect(execCalls().length).toBeGreaterThan(execCallsBefore);
    });
  });

  test("a fresh provider can inspect without a plan after reload", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakeApi();
      await applyPlan(stateDir, fake.api);

      const providerB = await makeProvider(stateDir, fake.api);
      const snapshot = await Effect.runPromise(providerB.inspect({ app: plan.id, service: web.name }));

      expect(snapshot.app).toBe(plan.id);
      expect(snapshot.service).toBe(web.name);
      expect(snapshot.state).toBe("running");
    });
  });

  test("destroy without a plan removes the persisted applied-plan file", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakeApi();
      await applyPlan(stateDir, fake.api);
      const path = appliedPlanPath(stateDir, plan.id);
      expect(await fileExists(path)).toBe(true);

      const providerB = await makeProvider(stateDir, fake.api);
      await Effect.runPromise(providerB.destroy({ app: plan.id }, { volumes: false }));

      expect(await fileExists(path)).toBe(false);
    });
  });

  test("stop-style destroy keeps the persisted applied-plan file", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakeApi();
      await applyPlan(stateDir, fake.api);
      const path = appliedPlanPath(stateDir, plan.id);
      expect(await fileExists(path)).toBe(true);

      const providerB = await makeProvider(stateDir, fake.api);
      await Effect.runPromise(providerB.destroy({ app: plan.id }, { volumes: false, removeState: false }));

      expect(await fileExists(path)).toBe(true);
    });
  });
});
