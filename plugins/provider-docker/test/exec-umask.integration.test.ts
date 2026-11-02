import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import { serviceContainerName } from "@lando/container-runtime/plan";
import { exec as runtimeExec } from "@lando/container-runtime/podman/exec";
import { parseProcSelfStatusUmask } from "@lando/container-runtime/podman/exec-umask";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeDockerApiClient, layer as providerLayer } from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";

import { ownerOnlyFileAccess } from "./private-file-access.ts";

const dockerHost = process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
const cliHost = dockerHost?.startsWith("/") ? `unix://${dockerHost}` : dockerHost;
const supportsContainerUmask =
  cliHost !== undefined &&
  (await (async () => {
    try {
      const child = Bun.spawn(
        ["docker", "--host", cliHost, "version", "--format", "{{.Client.Version}} {{.Server.Version}}"],
        { stdout: "pipe", stderr: "pipe", timeout: 5000 },
      );
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return (
        exitCode === 0 &&
        stdout
          .trim()
          .split(/\s+/u)
          .every((version) => {
            const [major = 0, minor = 0] = version.split(".").map(Number);
            return major > 29 || (major === 29 && minor >= 8);
          })
      );
    } catch {
      return false;
    }
  })());
const fixtureId = `exec-umask-mode-${crypto.randomUUID()}`;
const appId = AppId.make(fixtureId);
const serviceName = ServiceName.make("web");
const providerId = ProviderId.make("docker");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
  source: "provider-docker/exec-umask.integration.test.ts",
  runtime: 4 as const,
};

const makeProviderLayer = () =>
  providerLayer({
    platform: "linux",
    dockerApi: makeDockerApiClient(dockerHost ?? ""),
    appliedPlanState: makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make(join(tmpdir(), `docker-exec-umask-${crypto.randomUUID()}`)),
      ownerOnlyFileAccess,
    ),
  });

const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "alpine:3.20" },
  command: ["sleep", "3600"],
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  valueModel: 1,
  id: appId,
  name: "Exec Umask Mode",
  slug: fixtureId,
  root: AbsolutePath.make(join(tmpdir(), fixtureId)),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

describe("docker exec umask mode", () => {
  test.skipIf(!supportsContainerUmask)(
    "lando exec creates 0644 files across container umasks",
    async () => {
      if (cliHost === undefined) throw new Error("Docker socket is required");
      const docker = async (args: readonly string[]) => {
        const child = Bun.spawn(["docker", "--host", cliHost, ...args], { stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, stderr).toBe(0);
        return stdout.trim();
      };
      const loose = ServiceName.make("loose");
      const strict = ServiceName.make("strict");
      const scopedPlan: AppPlan = {
        ...plan,
        slug: `${fixtureId}-scoped`,
        services: {
          [serviceName]: service,
          [loose]: { ...service, name: loose },
          [strict]: { ...service, name: strict },
        },
      };
      const masks = { [serviceName]: "0022", [loose]: "0000", [strict]: "0077" };
      const created: string[] = [];
      const create = async (name: ServiceName, umask: string) => {
        const container = serviceContainerName(scopedPlan, name);
        await docker([
          "create",
          "--name",
          container,
          "--umask",
          umask,
          ...(name === loose ? ["--user", "1000:1000"] : []),
          "alpine:3.20",
          "sleep",
          "300",
        ]);
        if (!created.includes(container)) created.push(container);
        await docker(["start", container]);
      };
      const ctx = { providerId: "docker", remediation: "Run lando doctor.", env: {} };
      const run = (
        api: ReturnType<typeof makeDockerApiClient>,
        name: ServiceName,
        command: readonly string[],
        raw = false,
        user?: string,
      ) =>
        Effect.runPromise(
          Effect.scoped(
            runtimeExec(
              scopedPlan,
              { app: appId, service: name, ...(user === undefined ? {} : { user }) },
              { command, ...(raw ? { raw: true } : {}) },
              { api, ctx },
            ),
          ),
        );
      try {
        for (const name of [serviceName, loose, strict]) await create(name, masks[name] ?? "0022");
        for (const [index, order] of [
          [serviceName, loose, strict],
          [loose, strict, serviceName],
        ].entries()) {
          const api = makeDockerApiClient(cliHost);
          for (const name of order) {
            const raw = await run(api, name, ["cat", "/proc/self/status"], true);
            expect(raw.exitCode).toBe(0);
            expect(parseProcSelfStatusUmask(raw.stdout)).toBe(masks[name]);
            const effective = await run(api, name, ["cat", "/proc/self/status"]);
            expect(parseProcSelfStatusUmask(effective.stdout)).toBe(name === strict ? "0077" : "0022");
            const path = `/tmp/scoped-${index}`;
            expect((await run(api, name, ["touch", path])).exitCode).toBe(0);
            expect((await run(api, name, ["stat", "-c", "%a", path])).stdout.trim()).toBe(
              name === strict ? "600" : "644",
            );
          }
        }
        const recreatedApi = makeDockerApiClient(cliHost);
        expect(
          parseProcSelfStatusUmask(
            (await run(recreatedApi, serviceName, ["cat", "/proc/self/status"])).stdout,
          ),
        ).toBe("0022");
        await docker(["rm", "--force", serviceContainerName(scopedPlan, serviceName)]);
        await create(serviceName, "0000");
        expect(
          parseProcSelfStatusUmask(
            (await run(recreatedApi, serviceName, ["cat", "/proc/self/status"], true)).stdout,
          ),
        ).toBe("0000");
        expect(
          parseProcSelfStatusUmask(
            (await run(recreatedApi, serviceName, ["cat", "/proc/self/status"])).stdout,
          ),
        ).toBe("0022");

        const usersApi = makeDockerApiClient(cliHost);
        await expect(run(usersApi, loose, ["id"], false, "invalid-lando-user")).rejects.toBeDefined();
        expect(
          parseProcSelfStatusUmask((await run(usersApi, loose, ["cat", "/proc/self/status"])).stdout),
        ).toBe("0022");
      } finally {
        for (const container of created) await docker(["rm", "--force", container]);
      }
    },
    120_000,
  );
  test.skipIf(dockerHost === undefined)(
    "lando exec creates 0644 files",
    async () => {
      const provider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(makeProviderLayer())));
      await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
      try {
        const target = { app: appId, service: serviceName };
        const raw = await Effect.runPromise(
          provider.exec(target, {
            command: ["cat", "/proc/self/status"],
            raw: true,
          }),
        );
        expect(raw.exitCode).toBe(0);
        const inherited = parseProcSelfStatusUmask(raw.stdout);
        expect(inherited).toBeDefined();
        const effective = await Effect.runPromise(
          provider.exec(target, {
            command: ["cat", "/proc/self/status"],
          }),
        );
        expect(effective.exitCode).toBe(0);
        expect(parseProcSelfStatusUmask(effective.stdout)).toBe(inherited === "0000" ? "0022" : inherited);
        const authored = await Effect.runPromise(
          provider.exec(target, {
            command: ["/bin/sh", "-c", "umask 0077; exec cat /proc/self/status"],
          }),
        );
        expect(authored.exitCode).toBe(0);
        expect(parseProcSelfStatusUmask(authored.stdout)).toBe("0077");
        const created = await Effect.runPromise(
          provider.exec(
            { app: appId, service: serviceName },
            { command: ["touch", "/tmp/lando-exec-umask"] },
          ),
        );
        expect(created.exitCode).toBe(0);
        const mode = await Effect.runPromise(
          provider.exec(
            { app: appId, service: serviceName },
            { command: ["stat", "-c", "%a", "/tmp/lando-exec-umask"] },
          ),
        );
        expect(mode.exitCode).toBe(0);
        expect(mode.stdout.trim()).toBe("644");
      } finally {
        await Effect.runPromise(provider.destroy({ app: appId }, { volumes: true }));
      }
    },
    60_000,
  );
});
