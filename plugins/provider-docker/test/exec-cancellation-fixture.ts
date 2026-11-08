import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { containerHelperDelivery } from "@lando/container-runtime/container-helper";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { rememberExecUmask } from "@lando/container-runtime/podman/exec-umask";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeDockerApiClient } from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ContainerHelperDigest,
  ProviderId,
  ServiceName,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import { DateTime, Effect, Schema } from "effect";
import { makeRuntimeProvider } from "./provider-fixture.ts";

export const liveExecHost =
  resolveLiveProviderSocket()?.socketPath ?? process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
const docker = async (args: readonly string[]) => {
  if (liveExecHost === undefined) throw new Error("Explicit live engine socket required");
  const child = Bun.spawn(
    ["docker", "--host", liveExecHost.startsWith("/") ? `unix://${liveExecHost}` : liveExecHost, ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Disposable exec fixture failed (${code}): ${err}`);
  return out.trim();
};
const ExecCreate = Schema.Struct({ Cmd: Schema.Array(Schema.String) });

export const execCancellationFixture = async (user?: string) => {
  const name = `cancel-${crypto.randomUUID()}`;
  const id = AppId.make(name);
  const service = ServiceName.make("web");
  const providerId = ProviderId.make("docker");
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-11-07T00:00:00Z"),
    source: "exec-cancellation-live",
    runtime: 4 as const,
  };
  const plan: AppPlan = {
    id,
    name,
    slug: name,
    valueModel: 1,
    root: AbsolutePath.make(`/tmp/${name}`),
    provider: providerId,
    networking: landoNetworkingPlan({ slug: name, serviceNames: [service], sharedCrossAppNetwork: false }),
    services: {
      [service]: {
        name: service,
        type: "node",
        provider: providerId,
        primary: true,
        artifact: { kind: "ref", ref: "alpine:3.20" },
        environment: {},
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const helperTarget = { os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64" } as const;
  const path = AbsolutePath.make(
    resolve(
      import.meta.dir,
      `../../../core/container-helper/dist/linux-${helperTarget.arch}/lando-container-helper`,
    ),
  );
  const helper = {
    target: helperTarget,
    path,
    digest: ContainerHelperDigest.make(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ),
  };
  const mount = containerHelperDelivery(helper);
  const container = serviceContainerName(plan, service);
  await docker([
    "create",
    "--name",
    container,
    "--mount",
    `type=bind,source=${dirname(path)},target=${mount.target},readonly`,
    "alpine:3.20",
    "sleep",
    "300",
  ]);
  try {
    await docker(["start", container]);
    const base = makeDockerApiClient(liveExecHost ?? "");
    const request = base.request;
    const stream = base.stream;
    if (request === undefined || stream === undefined) throw new Error("Missing engine transport");
    const commands: (readonly string[])[] = [];
    const disconnected = new AbortController();
    const api = {
      ...base,
      request: (input: EngineHttpRequest) => {
        if (input.method === "POST" && input.path.endsWith("/exec") && Schema.is(ExecCreate)(input.body))
          commands.push(input.body.Cmd);
        return request(input);
      },
      stream: (input: EngineHttpRequest) =>
        stream({
          ...input,
          signal: AbortSignal.any([
            disconnected.signal,
            ...(input.signal === undefined ? [] : [input.signal]),
          ]),
        }),
    };
    const containerId = await docker(["inspect", "--format", "{{.Id}}", container]);
    rememberExecUmask(api, containerId, { status: "ok", umask: "0000" }, user);
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        dockerApi: api,
        resolveContainerHelper: () => Effect.succeed(helper),
      }),
    );
    return {
      provider,
      target: { app: id, service, plan, ...(user === undefined ? {} : { user }) },
      commands,
      disconnect: () => disconnected.abort(),
      inside: (args: readonly string[]) => docker(["exec", container, ...args]),
      close: () => docker(["rm", "--force", container]),
    };
  } catch (error) {
    await docker(["rm", "--force", container]);
    throw error;
  }
};
