import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Schema } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import type { EngineHttpRequest, EngineHttpResponse, PodmanApiClient } from "../src/engine-api.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringUp } from "../src/podman/bring-up.ts";

const providerId = ProviderId.make("lando");
const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry." } as const;
const appId = AppId.make("recreate-ports");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
  source: "container-runtime/bring-up-recreate.test.ts",
  runtime: 4 as const,
};
const containerName = "lando-recreate-ports-web";

const planWithHostPort = (hostPort: number): AppPlan => {
  const service: ServicePlan = {
    name: serviceName,
    type: "web",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [
      {
        _tag: "published",
        port: 8080,
        protocol: "http",
        name: "http",
        publication: { bindAddress: "127.0.0.1", hostPort },
      },
    ],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  return {
    id: appId,
    name: "Recreate Ports",
    slug: "recreate-ports",
    root: AbsolutePath.make("/tmp/lando-recreate-ports"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    networking: { perAppBridge: { name: "recreate-ports-network", driver: "bridge" } },
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const inspectBody = (
  hostPort: string,
  running: boolean,
  bindSource?: string,
  networks?: ReadonlyArray<string>,
): string =>
  JSON.stringify({
    State: { Running: running },
    ...(networks === undefined
      ? {}
      : { NetworkSettings: { Networks: Object.fromEntries(networks.map((name) => [name, {}])) } }),
    ...(bindSource === undefined
      ? {}
      : {
          Mounts:
            bindSource === ""
              ? []
              : [{ Type: "bind", Source: bindSource, Destination: "/run/lando/host-proxy.sock" }],
        }),
    HostConfig: {
      PortBindings: {
        "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }],
      },
    },
  });

const inspectWithoutPortBindings = (running: boolean): string =>
  JSON.stringify({ State: { Running: running } });

const createConfigSchema = Schema.Struct({
  Labels: Schema.Record(Schema.String, Schema.String),
  Env: Schema.Array(Schema.String),
  Cmd: Schema.optional(Schema.Array(Schema.String)),
});

const makeFakeApi = (input: {
  readonly deleteStatus: number;
  readonly omitPortBindings?: boolean;
  readonly existingBindSource?: string;
  readonly existingContainerName?: string;
  readonly existingNativeId?: string;
  readonly existingNetworks?: ReadonlyArray<string>;
  readonly networkExists?: boolean;
  readonly containerExists?: boolean;
  readonly running?: boolean;
  readonly existingLabels?: Readonly<Record<string, string>>;
  readonly existingPlan?: AppPlan;
  readonly additionalMounts?: ReadonlyArray<{
    readonly Type: string;
    readonly Source: string;
    readonly Destination: string;
  }>;
  readonly agentMount?: {
    readonly Type: string;
    readonly Source: string;
    readonly Name?: string;
    readonly Destination: string;
  };
}) => {
  const calls: EngineHttpRequest[] = [];
  let exists = input.containerExists ?? true;
  let running = input.running ?? true;
  let hostPort = "18080";
  let bindSource = input.existingBindSource;
  const original = input.existingPlan ?? planWithHostPort(18080);
  const originalService = original.services[serviceName];
  if (originalService === undefined) throw new Error("Test service is missing.");
  let config: typeof createConfigSchema.Type = {
    Labels: input.existingLabels ?? commonContainerLabels(original, originalService),
    Env: [],
  };
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(request);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)(?:\/([^?]+))?/u);
        const name = containerMatch === null ? "" : decodeURIComponent(containerMatch[1] ?? "");
        const action = containerMatch?.[2];
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          return { status: input.networkExists === true ? 200 : 404, body: "{}" };
        }
        if (request.method === "POST" && request.path === "/networks/create") {
          return { status: 201, body: "{}" };
        }
        if (request.method === "GET" && action === "json") {
          if (!exists) return { status: 404, body: "{}" };
          const body =
            input.omitPortBindings === true
              ? inspectWithoutPortBindings(running)
              : inspectBody(hostPort, running, bindSource, input.existingNetworks);
          const inspected: unknown = JSON.parse(body);
          if (typeof inspected !== "object" || inspected === null) {
            throw new TypeError("Fake container inspect must be an object.");
          }
          return {
            status: 200,
            body: JSON.stringify({
              ...inspected,
              Id: input.existingNativeId ?? input.existingContainerName ?? containerName,
              Config: config,
              ...(input.agentMount === undefined
                ? {}
                : { Mounts: [input.agentMount, ...(input.additionalMounts ?? [])] }),
            }),
          };
        }
        if (request.method === "POST" && action === "stop") {
          running = false;
          return { status: 204, body: "" };
        }
        if (
          request.method === "DELETE" &&
          name === (input.existingNativeId ?? input.existingContainerName ?? containerName)
        ) {
          if (input.deleteStatus === 204) {
            exists = false;
            running = false;
          }
          return { status: input.deleteStatus, body: input.deleteStatus === 204 ? "" : "busy" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          if (exists) return { status: 409, body: "already exists" };
          config = Schema.decodeUnknownSync(createConfigSchema)(request.body);
          exists = true;
          hostPort = "38080";
          bindSource = "/home/user/new/host-proxy.sock";
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && action === "start") {
          running = true;
          return { status: 204, body: "" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          return { status: 204, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };
  return { api, calls };
};

const createCalls = (calls: ReadonlyArray<EngineHttpRequest>): ReadonlyArray<EngineHttpRequest> =>
  calls.filter((call) => call.method === "POST" && call.path.startsWith("/containers/create"));

test.each([false, true])(
  "host-proxy session rotation recreates containers without deleting volumes (changed=%s)",
  async (changed) => {
    const base = planWithHostPort(18080);
    const original = base.services[serviceName];
    if (original === undefined) throw new Error("Missing service");
    const previous = {
      ...original,
      environment: {
        LANDO_HOST_PROXY_SESSION: "previous-session",
        LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
      },
      mounts: [
        {
          type: "bind" as const,
          source: "/home/user/session/host-proxy.sock",
          target: PortablePath.make("/run/lando/host-proxy.sock"),
          readOnly: true,
          realization: "passthrough" as const,
        },
      ],
    };
    const desired = {
      ...previous,
      environment: {
        ...previous.environment,
        LANDO_HOST_PROXY_SESSION: changed ? "next-session" : "previous-session",
      },
    };
    const planned = { ...base, services: { [serviceName]: desired } };
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingPlan: { ...base, services: { [serviceName]: previous } },
      existingBindSource: "/home/user/session/host-proxy.sock",
      existingNetworks: ["recreate-ports-network"],
      networkExists: true,
    });
    const result = await Effect.runPromise(bringUp(planned, { api: fake.api, ctx, reconcile: false }));
    expect(result.changed).toBe(changed);
    expect(createCalls(fake.calls)).toHaveLength(changed ? 1 : 0);
    const deletes = fake.calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(changed ? 1 : 0);
    for (const call of deletes) {
      expect(call.path).toStartWith("/containers/");
      expect(call.path).not.toMatch(/[?&]v=(true|1)/);
    }
  },
);

describe("Podman publish-port recreate", () => {
  test("recreate stops and deletes the observed owned native ID", async () => {
    // Given
    const fake = makeFakeApi({ deleteStatus: 204, existingNativeId: "observed-owned-id" });
    // When
    await Effect.runPromise(bringUp(planWithHostPort(38080), { api: fake.api, ctx }));
    // Then
    expect(
      fake.calls
        .filter((call) => call.path.endsWith("/stop") || call.method === "DELETE")
        .map((call) => call.path),
    ).toEqual(["/containers/observed-owned-id/stop", "/containers/observed-owned-id?force=true"]);
  });
  test("migrates a missing create-config label once without deleting volumes", async () => {
    // Given an existing container from before create-config labels.
    const plan = planWithHostPort(38080);
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingLabels: {
        "dev.lando.app": plan.id,
        "dev.lando.app-root": plan.root,
        "dev.lando.service": serviceName,
      },
    });
    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, reconcile: false }));
    // When the same plan is applied again after migration.
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, reconcile: false }));
    // Then the replacement is reused and no volume was deleted.
    expect(result.changed).toBe(false);
    expect(createCalls(fake.calls)).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `/containers/${containerName}?force=true`,
    ]);
  });

  test("keeps the desired digest when resolved environment overrides change", async () => {
    // Given desired secret references and a first resolved value.
    const base = planWithHostPort(38080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: { [serviceName]: { ...service, environment: { PASSWORD: "${secret:db/password}" } } },
    };
    const fake = makeFakeApi({ deleteStatus: 204, containerExists: false });
    await Effect.runPromise(
      bringUp(plan, {
        api: fake.api,
        ctx,
        serviceEnvironment: { [serviceName]: { PASSWORD: "resolved-before" } },
      }),
    );
    // When the resolved bytes change without a desired reference change.
    const result = await Effect.runPromise(
      bringUp(plan, {
        api: fake.api,
        ctx,
        serviceEnvironment: { [serviceName]: { PASSWORD: "resolved-after" } },
      }),
    );
    // Then actual create received the secret, but its label contains only the desired opaque digest.
    expect(result.changed).toBe(false);
    expect(createCalls(fake.calls)).toHaveLength(1);
    expect(createCalls(fake.calls)[0]?.body).toMatchObject({
      Env: ["PASSWORD=resolved-before"],
      Labels: {
        [CREATE_CONFIG_LABEL]: expect.stringMatching(/^v1:[a-f0-9]{64}$/u),
      },
    });
    expect(createCalls(fake.calls)[0]?.body).toHaveProperty(
      ["Labels", CREATE_CONFIG_LABEL],
      commonContainerLabels(plan, plan.services[serviceName] ?? service)[CREATE_CONFIG_LABEL],
    );
  });

  test("forbidRecreate rejects config drift before any mutation", async () => {
    // Given an owned running container with a previous config.
    const plan = planWithHostPort(18080);
    const service = plan.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const fake = makeFakeApi({ deleteStatus: 204, networkExists: true });
    const updated: AppPlan = {
      ...plan,
      services: { [serviceName]: { ...service, environment: { MODE: "after" } } },
    };
    // When an in-place restart encounters config drift.
    const error = await Effect.runPromise(
      Effect.flip(
        bringUp(updated, {
          api: fake.api,
          ctx,
          reconcile: false,
          forbidRecreate: true,
        }),
      ),
    );
    // Then it refuses and leaves the existing container untouched.
    expect(error).toMatchObject({ _tag: "ServiceRestartWouldRecreateError", reason: "config" });
    expect(error.remediation).toContain("lando rebuild -s web");
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
  });

  test.each(["environment", "command"] as const)(
    "recreates with the new create config when %s changes with reconcile=false",
    async (field) => {
      // Given an original container created through the same fake API.
      const fake = makeFakeApi({ deleteStatus: 204, containerExists: false });
      const base = planWithHostPort(38080);
      const service = base.services[serviceName];
      if (service === undefined) throw new Error("Test service is missing.");
      const original: AppPlan = {
        ...base,
        services: {
          [serviceName]: { ...service, environment: { MODE: "before" }, command: ["sleep", "60"] },
        },
      };
      await Effect.runPromise(bringUp(original, { api: fake.api, ctx, reconcile: false }));
      const environment = { MODE: field === "environment" ? "after" : "before" };
      const command = field === "command" ? ["sleep", "120"] : ["sleep", "60"];
      const updated: AppPlan = {
        ...base,
        services: { [serviceName]: { ...service, environment, command } },
      };

      // When ordinary start applies a change to only the environment or command.
      await Effect.runPromise(bringUp(updated, { api: fake.api, ctx, reconcile: false }));

      // Then the old container is removed between creates and the replacement uses the new config.
      const creates = createCalls(fake.calls);
      expect({
        createCount: creates.length,
        lifecycle: fake.calls
          .filter((call) => creates.includes(call) || call.method === "DELETE")
          .map((call) => call.method),
        lastConfig: creates.at(-1)?.body,
      }).toMatchObject({
        createCount: 2,
        lifecycle: ["POST", "DELETE", "POST"],
        lastConfig: { Env: [`MODE=${environment.MODE}`], Cmd: command },
      });
    },
  );

  test("forbidRecreate refuses a missing container without creating one", async () => {
    // Given a container removed after the operation's preflight.
    const fake = makeFakeApi({ deleteStatus: 204, networkExists: true, containerExists: false });
    // When the provider applies an in-place restart.
    const exit = await Effect.runPromiseExit(
      bringUp(planWithHostPort(18080), { api: fake.api, ctx, forbidRecreate: true }),
    );
    // Then it fails without creating a replacement or deleting the existing network.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(createCalls(fake.calls)).toHaveLength(0);
    expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test.each([
    ["bind", "/old/agent", "bind", "/new/agent", true],
    ["bind", "/same/agent", "bind", "/same/agent", false],
    ["bind", "agent-volume", "volume", "agent-volume", true],
    ["volume", "old-volume", "volume", "new-volume", true],
    ["volume", "same-volume", "volume", "same-volume", false],
    ["bind", "/old/agent", undefined, undefined, true],
  ] as const)("SSH overlay recreation: %s %s to %s %s", async (oldType, oldSource, type, source, changed) => {
    // Given
    const target = PortablePath.make("/run/lando/ssh-agent");
    const fakeInput = {
      deleteStatus: 204,
      agentMount: {
        Type: oldType,
        Source: oldType === "volume" ? `/var/lib/volumes/${oldSource}/_data` : oldSource,
        ...(oldType === "volume" ? { Name: oldSource } : {}),
        Destination: target,
      },
    };
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          mounts:
            type === undefined
              ? []
              : [
                  {
                    type,
                    ...(source === undefined ? {} : { source }),
                    target,
                    readOnly: true,
                    realization: "passthrough" as const,
                  },
                ],
        },
      },
    };
    // When
    const fake = makeFakeApi({ ...fakeInput, existingPlan: plan });
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    // Then
    expect(result.changed).toBe(changed);
    expect(createCalls(fake.calls)).toHaveLength(changed ? 1 : 0);
  });
  test.each([
    ["absent", undefined, undefined, true],
    ["matching", "volume", "lando-ssh-agent", false],
    ["changed", "volume", "previous-ssh-agent", true],
    ["bind", "bind", "/previous/ssh-agent", true],
  ] as const)("SSH sidecar storage volume: %s", async (_scenario, oldType, oldSource, changed) => {
    const target = PortablePath.make("/run/lando/ssh-agent");
    const fakeInput = {
      deleteStatus: 204,
      ...(oldType === undefined || oldSource === undefined
        ? {}
        : {
            agentMount: {
              Type: oldType,
              Source: oldType === "volume" ? `/var/lib/volumes/${oldSource}/_data` : oldSource,
              ...(oldType === "volume" ? { Name: oldSource } : {}),
              Destination: target,
            },
          }),
    };
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          storage: [{ store: "lando-ssh-agent", target, readOnly: false }],
        },
      },
    };
    const fake = makeFakeApi({ ...fakeInput, existingPlan: plan });
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    expect(result.changed).toBe(changed);
    expect(createCalls(fake.calls)).toHaveLength(changed ? 1 : 0);
    expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(changed ? 1 : 0);
  });

  test.each([
    ["remove unsupported Windows bind", "/windows/ssh", undefined, true, false],
    ["keep matching POSIX bind", "/posix/ssh", "/posix/ssh", false, true],
    ["replace changed POSIX bind", "/previous/ssh", "/current/ssh", true, true],
  ] as const)("SSH sidecar host endpoint: %s", async (_scenario, oldSource, source, changed, running) => {
    const target = PortablePath.make("/run/lando/ssh-agent");
    const fakeInput = {
      deleteStatus: 204,
      running,
      agentMount: {
        Type: "volume",
        Source: "/var/lib/volumes/lando-ssh-agent/_data",
        Name: "lando-ssh-agent",
        Destination: target,
      },
      additionalMounts: [{ Type: "bind", Source: oldSource, Destination: "/ssh-auth" }],
    };
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          storage: [{ store: "lando-ssh-agent", target, readOnly: false }],
          mounts:
            source === undefined
              ? []
              : [
                  {
                    type: "bind" as const,
                    source,
                    target: PortablePath.make("/ssh-auth"),
                    readOnly: false,
                    realization: "passthrough" as const,
                  },
                ],
        },
      },
    };
    const fake = makeFakeApi({ ...fakeInput, existingPlan: plan });
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    expect(result.changed).toBe(changed);
    expect(createCalls(fake.calls)).toHaveLength(changed ? 1 : 0);
    expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(changed ? 1 : 0);
  });

  test("recreates an existing container that is missing the planned physical network", async () => {
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingNetworks: ["lando-shared"],
    });
    const base = planWithHostPort(18080);
    const plan: AppPlan = {
      ...base,
      networking: {
        perAppBridge: {
          name: "lando-vm-0123456789ab-fedcba987654",
          driver: "bridge",
        },
      },
    };

    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    expect(result.changed).toBe(true);
    expect(createCalls(fake.calls)).toHaveLength(1);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/containers/"))).toBe(
      true,
    );
  });

  test("keeps an existing container already attached to its planned network", async () => {
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingNetworks: ["recreate-ports-network"],
    });

    const result = await Effect.runPromise(bringUp(planWithHostPort(18080), { api: fake.api, ctx }));

    expect(result.changed).toBe(false);
    expect(createCalls(fake.calls)).toHaveLength(0);
  });

  test.each([true, false])(
    "recreates an existing running container without PortBindings only when reconcile=%s",
    async (reconcile) => {
      // Given
      const plan = planWithHostPort(38080);
      const fake = makeFakeApi({ deleteStatus: 204, omitPortBindings: true, existingPlan: plan });

      // When
      const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, reconcile }));

      // Then
      expect(result.changed).toBe(reconcile);
      expect(createCalls(fake.calls)).toHaveLength(reconcile ? 1 : 0);
    },
  );

  test("Given a fingerprint mismatch and a failed remove, When bringing up, Then start fails instead of keeping old PortBindings", async () => {
    // Given: existing container still publishes 18080; planned host port is 38080; DELETE is rejected.
    const fake = makeFakeApi({ deleteStatus: 409 });
    const plan = planWithHostPort(38080);

    // When
    const exit = await Effect.runPromiseExit(bringUp(plan, { api: fake.api, ctx }));

    // Then: recreate must not treat 409-create as success on the leftover container.
    const failures = Exit.isFailure(exit)
      ? Array.from(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
      : [];
    expect(failures).toContainEqual(
      expect.objectContaining({ _tag: "ServiceStartError", operation: "bringUp.remove", service: "web" }),
    );
    expect(createCalls(fake.calls)).toEqual([]);
  });

  test("Given a fingerprint mismatch and a successful remove, When bringing up, Then the container is recreated", async () => {
    // Given
    const fake = makeFakeApi({ deleteStatus: 204 });
    const plan = planWithHostPort(38080);

    // When
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    // Then
    expect(result.changed).toBe(true);
    expect(createCalls(fake.calls)).toHaveLength(1);
  });

  test("recreates an existing stopped container when a bind source changes", async () => {
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingBindSource: "/home/user/old/host-proxy.sock",
    });
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          environment: { LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock" },
          mounts: [
            {
              type: "bind",
              source: "/home/user/new/host-proxy.sock",
              target: PortablePath.make("/run/lando/host-proxy.sock"),
              readOnly: true,
              realization: "passthrough",
            },
          ],
        },
      },
    };

    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    expect(result.changed).toBe(true);
    expect(createCalls(fake.calls)).toHaveLength(1);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/containers/"))).toBe(
      true,
    );
    expect(
      fake.calls.find((call) => call.method === "POST" && call.path.startsWith("/containers/create"))?.body,
    ).toMatchObject({
      HostConfig: { Binds: ["/home/user/new/host-proxy.sock:/run/lando/host-proxy.sock:ro"] },
    });
  });

  for (const [label, existingBindSource] of [
    ["missing metadata", undefined],
    ["empty mount list", ""],
  ] as const) {
    test(`recreates a container when its socket mount has ${label}`, async () => {
      const fake = makeFakeApi({
        deleteStatus: 204,
        ...(existingBindSource === undefined ? {} : { existingBindSource }),
      });
      const base = planWithHostPort(18080);
      const service = base.services[serviceName];
      if (service === undefined) throw new Error("Test service is missing.");
      const plan: AppPlan = {
        ...base,
        services: {
          [serviceName]: {
            ...service,
            environment: { LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock" },
            mounts: [
              {
                type: "bind",
                source: "/home/user/new/host-proxy.sock",
                target: PortablePath.make("/run/lando/host-proxy.sock"),
                readOnly: true,
                realization: "passthrough",
              },
            ],
          },
        },
      };
      const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
      expect(result.changed).toBe(true);
      expect(createCalls(fake.calls)).toHaveLength(1);
    });
  }

  test("recreates when a gpg relay directory source changes", async () => {
    // Given
    const fake = makeFakeApi({
      deleteStatus: 204,
      agentMount: { Type: "bind", Source: "/old", Destination: "/run/lando/gpg-agent" },
    });
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          mounts: [
            {
              type: "bind",
              source: "/new",
              target: PortablePath.make("/run/lando/gpg-agent"),
              readOnly: true,
              realization: "passthrough",
            },
          ],
        },
      },
    };
    // When
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    // Then
    expect(result.changed).toBe(true);
    expect(createCalls(fake.calls)).toHaveLength(1);
  });

  test("does not compare unrelated bind sources without a host-proxy session", async () => {
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          mounts: [
            {
              type: "bind",
              source: "/home/user/new/host-proxy.sock",
              target: PortablePath.make("/run/lando/host-proxy.sock"),
              readOnly: true,
              realization: "passthrough",
            },
          ],
        },
      },
    };
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingBindSource: "/home/user/old/host-proxy.sock",
      existingPlan: plan,
    });
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    expect(result.changed).toBe(false);
    expect(createCalls(fake.calls)).toHaveLength(0);
  });
  test("reuses an existing container when its bind source is unchanged", async () => {
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          environment: { LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock" },
          mounts: [
            {
              type: "bind",
              source: "/home/user/new/host-proxy.sock",
              target: PortablePath.make("/run/lando/host-proxy.sock"),
              readOnly: true,
              realization: "passthrough",
            },
          ],
        },
      },
    };

    const fake = makeFakeApi({
      deleteStatus: 204,
      existingBindSource: "/home/user/new/host-proxy.sock",
      existingPlan: plan,
    });
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    expect(result.changed).toBe(false);
    expect(createCalls(fake.calls)).toHaveLength(0);
  });
  test("recreates a global published service on only the shared network", async () => {
    const plan: AppPlan = {
      ...planWithHostPort(38080),
      id: AppId.make("global"),
      name: "Global",
      slug: "global",
      networking: {
        perAppBridge: { name: "lando-global", driver: "bridge" },
        sharedNetworkMembership: {
          name: "lando_bridge_network",
          aliases: { [ServiceName.make("web")]: ["web.global.internal"] },
        },
      },
    };

    const fake = makeFakeApi({
      deleteStatus: 204,
      existingContainerName: "lando-global-web",
      existingPlan: plan,
    });
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    expect(result.changed).toBe(true);
    const createdNetworks = fake.calls
      .filter((call) => call.method === "POST" && call.path === "/networks/create")
      .map((call) => Reflect.get(call.body as object, "Name"));
    expect(createdNetworks).toEqual(["lando_bridge_network"]);
    const created = createCalls(fake.calls);
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toMatchObject({
      NetworkingConfig: {
        EndpointsConfig: {
          lando_bridge_network: { Aliases: ["web.global.internal"] },
        },
      },
    });
  });
  test("Given inspect without PortBindings, When bringing up a pinned hostPort plan, Then the running container is not recreated", async () => {
    // Given: fake inspect returns State.Running only; planned hostPort is pinned.
    const plan = planWithHostPort(38080);
    const fake = makeFakeApi({ deleteStatus: 204, omitPortBindings: true, existingPlan: plan });

    // When
    const first = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    const second = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    // Then: unknown inspect fingerprint is not a proven mismatch.
    expect(first.changed).toBe(false);
    expect(second.changed).toBe(false);
    expect(createCalls(fake.calls)).toEqual([]);
  });

  test("forbidRecreate refuses a publish-port mismatch instead of recreating", async () => {
    const fake = makeFakeApi({ deleteStatus: 204, networkExists: true });
    const plan = planWithHostPort(38080);
    const exit = await Effect.runPromiseExit(bringUp(plan, { api: fake.api, ctx, forbidRecreate: true }));
    const failures = Exit.isFailure(exit)
      ? Array.from(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
      : [];
    expect(failures).toContainEqual(
      expect.objectContaining({
        _tag: "ServiceRestartWouldRecreateError",
        reason: "publish-port",
        service: "web",
      }),
    );
    expect(createCalls(fake.calls)).toEqual([]);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/containers/"))).toBe(
      false,
    );
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/networks/"))).toBe(
      false,
    );
  });

  test("forbidRecreate refuses a bind-source change instead of recreating", async () => {
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingBindSource: "/home/user/old/host-proxy.sock",
    });
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          environment: { LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock" },
          mounts: [
            {
              type: "bind",
              source: "/home/user/new/host-proxy.sock",
              target: PortablePath.make("/run/lando/host-proxy.sock"),
              readOnly: true,
              realization: "passthrough",
            },
          ],
        },
      },
    };
    const exit = await Effect.runPromiseExit(bringUp(plan, { api: fake.api, ctx, forbidRecreate: true }));
    const failures = Exit.isFailure(exit)
      ? Array.from(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
      : [];
    expect(failures).toContainEqual(
      expect.objectContaining({ _tag: "ServiceRestartWouldRecreateError", reason: "bind-source" }),
    );
    expect(createCalls(fake.calls)).toEqual([]);
  });

  test("forbidRecreate refuses a missing planned network instead of recreating", async () => {
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingNetworks: ["lando-shared"],
    });
    const base = planWithHostPort(18080);
    const plan: AppPlan = {
      ...base,
      networking: {
        perAppBridge: {
          name: "lando-vm-0123456789ab-fedcba987654",
          driver: "bridge",
        },
      },
    };
    const exit = await Effect.runPromiseExit(bringUp(plan, { api: fake.api, ctx, forbidRecreate: true }));
    const failures = Exit.isFailure(exit)
      ? Array.from(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
      : [];
    expect(failures).toContainEqual(
      expect.objectContaining({ _tag: "ServiceRestartWouldRecreateError", reason: "network" }),
    );
    expect(createCalls(fake.calls)).toEqual([]);
  });

  test("forbidRecreate refuses when combined with reconcile", async () => {
    const fake = makeFakeApi({ deleteStatus: 204 });
    const exit = await Effect.runPromiseExit(
      bringUp(planWithHostPort(18080), { api: fake.api, ctx, forbidRecreate: true, reconcile: true }),
    );
    const failures = Exit.isFailure(exit)
      ? Array.from(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
      : [];
    expect(failures).toContainEqual(
      expect.objectContaining({
        _tag: "ProviderInternalError",
        operation: "bringUp",
        message: "forbidRecreate cannot be combined with reconcile.",
      }),
    );
    expect(createCalls(fake.calls)).toEqual([]);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/containers/"))).toBe(
      false,
    );
  });
});
