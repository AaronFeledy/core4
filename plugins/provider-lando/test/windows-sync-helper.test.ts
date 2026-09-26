import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

import type { EngineHttpRequest, EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { ProviderUnavailableError } from "@lando/sdk/errors";

import {
  type WindowsSyncHelperSpec,
  ensureWindowsSyncHelper,
  removeWindowsSyncHelper,
} from "../src/windows-sync-helper.ts";

const spec: WindowsSyncHelperSpec = {
  appId: "demo-id",
  appName: "demo",
  service: "web",
  mountKey: "app-mount",
  image: `example.invalid/lando-sync@sha256:${"a".repeat(64)}`,
};

type JsonRecord = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);

const makeFakeApi = () => {
  let volume: JsonRecord | undefined;
  let container: JsonRecord | undefined;
  const calls: EngineHttpRequest[] = [];
  const controls = {
    failVolumeInspectAfterCreate: false,
    failContainerInspectAfterCreate: false,
    helperCreateResponse: "valid" as "valid" | "malformed" | "lost",
    failContainerInspectAfterDelete: false,
    failDelete: false,
  };
  const stateStore = makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make(join(tmpdir(), `lando-sync-helper-${randomUUID()}`)),
    ownerOnlyFileAccess,
  );
  const response = (status: number, body: unknown = {}): EngineHttpResponse => ({
    status,
    body: JSON.stringify(body),
  });
  const api = {
    request: (request: EngineHttpRequest) =>
      Effect.sync(() => {
        calls.push(request);
        const { method, path } = request;
        if (method === "GET" && path.startsWith("/volumes/")) {
          if (volume !== undefined && controls.failVolumeInspectAfterCreate) return response(500);
          return volume === undefined ? response(404) : response(200, volume);
        }
        if (method === "POST" && path === "/volumes/create") {
          if (volume !== undefined) return response(409);
          const body = request.body as JsonRecord;
          volume = {
            Name: body.Name,
            Driver: body.Driver,
            Labels: clone(body.Labels),
            CreatedAt: "2026-09-23T00:00:00Z",
          };
          return response(201, volume);
        }
        if (method === "GET" && path.startsWith("/containers/") && path.endsWith("/json")) {
          if (container !== undefined && controls.failContainerInspectAfterCreate) return response(500);
          if (container === undefined && controls.failContainerInspectAfterDelete) return response(500);
          return container === undefined ? response(404) : response(200, container);
        }
        if (method === "POST" && path.startsWith("/containers/create?name=")) {
          if (container !== undefined) return response(409);
          const body = request.body as JsonRecord;
          const host = body.HostConfig as JsonRecord;
          const name = new URL(`http://podman.test${path}`).searchParams.get("name");
          container = {
            Id: "helper-container-id",
            Name: `/${name}`,
            Config: {
              Image: body.Image,
              Entrypoint: clone(body.Entrypoint),
              Cmd: clone(body.Cmd),
              User: body.User,
              Labels: clone(body.Labels),
            },
            HostConfig: {
              NetworkMode: host.NetworkMode,
              RestartPolicy: clone(host.RestartPolicy),
            },
            Mounts: [
              {
                Type: "volume",
                Name: String((host.Binds as string[])[0]).split(":")[0],
                Destination: "/sync",
                RW: true,
              },
            ],
            State: { Running: false },
          };
          if (controls.helperCreateResponse === "malformed") return response(201, {});
          if (controls.helperCreateResponse === "lost") return response(500);
          return response(201, { Id: "helper-container-id" });
        }
        if (method === "POST" && path === "/containers/helper-container-id/start") {
          if (container === undefined) return response(404);
          container.State = { Running: true };
          return response(204);
        }
        if (method === "DELETE" && path === "/containers/helper-container-id?force=true") {
          if (container === undefined) return response(404);
          if (controls.failDelete) return response(500);
          container = undefined;
          return response(204);
        }
        if (method === "DELETE" && path.startsWith("/volumes/")) {
          if (volume === undefined) return response(404);
          volume = undefined;
          return response(204);
        }
        throw new Error(`Unexpected Podman request: ${method} ${path}`);
      }),
  };
  return {
    api,
    stateStore,
    calls,
    controls,
    get volume() {
      return volume;
    },
    set volume(value: JsonRecord | undefined) {
      volume = value;
    },
    get container() {
      return container;
    },
    set container(value: JsonRecord | undefined) {
      container = value;
    },
  };
};

const failureOf = async (effect: ReturnType<typeof ensureWindowsSyncHelper>) => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag !== "Left") throw new Error("Expected owned sync helper operation to fail");
  return result.left;
};

describe("Windows named-volume sync helper", () => {
  test("creates an owned volume before a persistent isolated helper and reuses both", async () => {
    const fake = makeFakeApi();
    const endpoint = await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));

    expect(endpoint).toEqual({
      containerId: "helper-container-id",
      containerName: expect.stringMatching(/^lando-sync-demo-id-[a-f0-9]{16}$/u),
      volumeName: "demo-web-app-mount",
      path: "/sync",
    });
    expect(fake.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /volumes/demo-web-app-mount",
      `GET /containers/${endpoint.containerName}/json`,
      "POST /volumes/create",
      "GET /volumes/demo-web-app-mount",
      `GET /containers/${endpoint.containerName}/json`,
      `POST /containers/create?name=${endpoint.containerName}`,
      `GET /containers/${endpoint.containerName}/json`,
      "POST /containers/helper-container-id/start",
      `GET /containers/${endpoint.containerName}/json`,
    ]);
    const volumeCreate = fake.calls.find((call) => call.path === "/volumes/create");
    expect(volumeCreate?.body).toMatchObject({
      Name: "demo-web-app-mount",
      Driver: "local",
      Labels: {
        "dev.lando.provider": "lando",
        "dev.lando.app": "demo-id",
        "dev.lando.sync.service": "web",
        "dev.lando.sync.mount-key": "app-mount",
        "dev.lando.sync.kind": "volume",
      },
    });
    const helperCreate = fake.calls.find((call) => call.path.startsWith("/containers/create?"));
    expect(helperCreate?.body).toMatchObject({
      Image: spec.image,
      Entrypoint: ["sh", "-c"],
      Cmd: ["while :; do sleep 3600; done"],
      User: "0:0",
      HostConfig: {
        Binds: ["demo-web-app-mount:/sync:rw"],
        NetworkMode: "none",
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    const volume = fake.volume;
    const container = fake.container;
    if (volume === undefined || container === undefined) throw new Error("Expected owned helper resources");
    (volume.Labels as JsonRecord)["io.podman.extra"] = "runtime";
    volume.Options = {};
    ((container.Config as JsonRecord).Labels as JsonRecord)["org.opencontainers.image.title"] = "helper";
    const count = fake.calls.length;
    expect(await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))).toEqual(
      endpoint,
    );
    expect(fake.calls.slice(count).map(({ method }) => method)).toEqual(["GET", "GET"]);
  });

  test("refuses an existing foreign or unlabelled volume before container creation", async () => {
    const fake = makeFakeApi();
    fake.volume = { Name: "demo-web-app-mount", Driver: "local", Labels: {} };
    const error = await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.message).toContain("ownership receipt");
    expect(fake.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("refuses same-labelled local volumes with driver options on reuse and cleanup", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    const volume = fake.volume;
    if (volume === undefined) throw new Error("Expected sync volume");
    volume.Options = { type: "none", device: "/host/path", o: "bind" };
    const count = fake.calls.length;
    const error = await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    expect(error.message).toContain("different specification");
    expect(fake.calls.slice(count).some((call) => call.path.startsWith("/containers/"))).toBe(false);
    const cleanup = await Effect.runPromise(
      Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec, { removeVolume: true })),
    );
    expect(cleanup._tag).toBe("Left");
    expect(fake.volume).toBeDefined();
    expect(fake.container).toBeDefined();
    expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("refuses privileged, device, port, and shared-namespace helper drift", async () => {
    const changes: ReadonlyArray<readonly [string, unknown]> = [
      ["Privileged", true],
      ["Devices", [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/sda" }]],
      ["DeviceRequests", [{ Driver: "nvidia" }]],
      ["PortBindings", { "8080/tcp": [{ HostPort: "8080" }] }],
      ["PublishAllPorts", true],
      ["PidMode", "host"],
      ["IpcMode", "host"],
      ["UTSMode", "host"],
      ["UsernsMode", "host"],
      ["CgroupnsMode", "host"],
      ["CapAdd", ["SYS_ADMIN"]],
      ["SecurityOpt", ["seccomp=unconfined"]],
      ["Sysctls", { "kernel.shmmax": "1" }],
      ["VolumesFrom", ["other-container"]],
    ];
    for (const [field, value] of changes) {
      const fake = makeFakeApi();
      await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
      const container = fake.container;
      if (container === undefined) throw new Error("Expected helper container");
      (container.HostConfig as JsonRecord)[field] = value;
      container.State = { Running: false };
      const count = fake.calls.length;
      const error = await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
      expect(error.message).toContain("different specification");
      expect(fake.calls.slice(count).some((call) => call.path.endsWith("/start"))).toBe(false);
      const cleanup = await Effect.runPromise(
        Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec)),
      );
      expect(cleanup._tag).toBe("Left");
      expect(fake.container).toBeDefined();
      expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
    }
  });

  test("refuses helper entrypoint and user drift on reuse and cleanup", async () => {
    const changes: ReadonlyArray<readonly [string, unknown]> = [
      ["Entrypoint", ["sh", "-c", "exec evil"]],
      ["User", "1000:1000"],
    ];
    for (const [field, value] of changes) {
      const fake = makeFakeApi();
      await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
      const container = fake.container;
      if (container === undefined) throw new Error("Expected helper container");
      (container.Config as JsonRecord)[field] = value;
      container.State = { Running: false };
      const count = fake.calls.length;
      const error = await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
      expect(error.message).toContain("different specification");
      expect(fake.calls.slice(count).some((call) => call.path.endsWith("/start"))).toBe(false);
      const cleanup = await Effect.runPromise(
        Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec)),
      );
      expect(cleanup._tag).toBe("Left");
      expect(fake.container).toBeDefined();
      expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
    }
  });

  test("refuses a changed helper mount and never starts the foreign container", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    const container = fake.container;
    if (container === undefined) throw new Error("Expected helper container");
    container.Mounts = [{ Type: "volume", Name: "other-volume", Destination: "/sync", RW: true }];
    container.State = { Running: false };
    const count = fake.calls.length;
    const error = await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    expect(error.message).toContain("different specification");
    expect(fake.calls.slice(count).some((call) => call.path.endsWith("/start"))).toBe(false);
  });

  test("refuses a helper with foreign ownership labels before starting it", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    const container = fake.container;
    if (container === undefined) throw new Error("Expected helper container");
    ((container.Config as JsonRecord).Labels as JsonRecord)["dev.lando.app"] = "other-app";
    container.State = { Running: false };
    const count = fake.calls.length;
    const error = await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    expect(error.message).toContain("foreign ownership");
    expect(fake.calls.slice(count).some((call) => call.path.endsWith("/start"))).toBe(false);
  });

  test("restarts an owned helper that has stopped", async () => {
    const fake = makeFakeApi();
    const endpoint = await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    const container = fake.container;
    if (container === undefined) throw new Error("Expected helper container");
    container.State = { Running: false };
    const count = fake.calls.length;
    expect(await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))).toEqual(
      endpoint,
    );
    expect(fake.calls.slice(count).map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /volumes/demo-web-app-mount",
      `GET /containers/${endpoint.containerName}/json`,
      "POST /containers/helper-container-id/start",
      `GET /containers/${endpoint.containerName}/json`,
    ]);
  });

  test("cleanup removes only the recorded helper and retains the volume and receipt", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    expect(await Effect.runPromise(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))).toBe(true);
    expect(fake.container).toBeUndefined();
    expect(fake.volume).toBeDefined();
    expect(await Effect.runPromise(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))).toBe(false);
    const removal = await Effect.runPromise(
      Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec, { removeVolume: true })),
    );
    expect(removal._tag).toBe("Left");
    expect(fake.volume).toBeDefined();
  });

  test("recreates a helper with a fresh nonce after recorded cleanup", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    const first = fake.container;
    if (first === undefined) throw new Error("Expected helper container");
    const firstNonce = ((first.Config as JsonRecord).Labels as JsonRecord)["dev.lando.sync.nonce"];
    expect(await Effect.runPromise(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))).toBe(true);
    expect(await Effect.runPromise(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))).toBe(false);
    const volume = fake.volume;
    const count = fake.calls.length;
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    const next = fake.container;
    if (next === undefined) throw new Error("Expected replacement helper");
    expect(((next.Config as JsonRecord).Labels as JsonRecord)["dev.lando.sync.nonce"]).not.toBe(firstNonce);
    expect(fake.volume).toBe(volume);
    expect(fake.calls.slice(count).filter((call) => call.path === "/volumes/create")).toHaveLength(0);
    expect(
      fake.calls.slice(count).filter((call) => call.path.startsWith("/containers/create?")),
    ).toHaveLength(1);
  });

  test("completes a removal after deletion succeeds but receipt finalization is interrupted", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    fake.controls.failContainerInspectAfterDelete = true;
    expect(
      (await Effect.runPromise(Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))))._tag,
    ).toBe("Left");
    expect(fake.container).toBeUndefined();
    const count = fake.calls.length;
    expect((await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))).message).toContain(
      "ownership receipt",
    );
    expect(fake.calls.slice(count).some((call) => call.method === "POST")).toBe(false);
    fake.controls.failContainerInspectAfterDelete = false;
    expect(await Effect.runPromise(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))).toBe(true);
    expect(await Effect.runPromise(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))).toBe(false);
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    expect(fake.container).toBeDefined();
  });

  test("refuses a foreign helper replacing the recorded ID during interrupted removal", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    const original = clone(fake.container);
    fake.controls.failContainerInspectAfterDelete = true;
    expect(
      (await Effect.runPromise(Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))))._tag,
    ).toBe("Left");
    fake.controls.failContainerInspectAfterDelete = false;
    fake.container = { ...(original as JsonRecord), Id: "foreign-replacement-id" };
    const count = fake.calls.length;
    expect(
      (await Effect.runPromise(Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))))._tag,
    ).toBe("Left");
    expect((await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))).message).toContain(
      "ownership receipt",
    );
    expect(fake.calls.slice(count).some((call) => call.method === "DELETE")).toBe(false);
  });

  test("cleanup fails closed when a volume ownership label changes", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    const volume = fake.volume;
    if (volume === undefined) throw new Error("Expected sync volume");
    const labels = volume.Labels as JsonRecord;
    labels["dev.lando.app"] = "other-app";
    const result = await Effect.runPromise(
      Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec)),
    );
    expect(result._tag).toBe("Left");
    expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(fake.container).toBeDefined();
    expect(fake.volume).toBeDefined();
  });

  test("rejects same-labelled resources from another receipt or replaced instances", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    const other = makeFakeApi();
    other.volume = clone(fake.volume);
    other.container = clone(fake.container);
    const noReceipt = await failureOf(ensureWindowsSyncHelper(other.api, other.stateStore, spec));
    expect(noReceipt.message).toContain("ownership receipt");
    expect(other.calls.some((call) => call.method === "POST")).toBe(false);

    const originalVolume = clone(fake.volume);
    const originalContainer = clone(fake.container);
    const volume = fake.volume;
    if (volume === undefined) throw new Error("Expected volume");
    volume.CreatedAt = "2026-09-24T00:00:00Z";
    expect((await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))).message).toContain(
      "different specification",
    );
    expect(
      (await Effect.runPromise(Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))))._tag,
    ).toBe("Left");
    fake.volume = originalVolume;
    const container = fake.container;
    if (container === undefined) throw new Error("Expected container");
    container.Id = "replacement-container-id";
    expect((await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))).message).toContain(
      "different specification",
    );
    expect(
      (await Effect.runPromise(Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))))._tag,
    ).toBe("Left");
    fake.container = originalContainer;
  });

  test("retries an owned helper after inspection fails following a saved create response", async () => {
    const fake = makeFakeApi();
    fake.controls.failContainerInspectAfterCreate = true;
    expect((await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))).message).toContain(
      "inspect failed",
    );
    expect(fake.container).toBeDefined();
    fake.controls.failContainerInspectAfterCreate = false;
    const count = fake.calls.length;
    const endpoint = await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    expect(endpoint.containerId).toBe("helper-container-id");
    expect(fake.calls.slice(count).some((call) => call.path.startsWith("/containers/create?"))).toBe(false);
  });

  test("refuses a foreign replacement after saving the helper response ID", async () => {
    const fake = makeFakeApi();
    fake.controls.failContainerInspectAfterCreate = true;
    expect(
      (await Effect.runPromise(Effect.either(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))))._tag,
    ).toBe("Left");
    fake.controls.failContainerInspectAfterCreate = false;
    fake.container = { ...(fake.container as JsonRecord), Id: "foreign-replacement-id" };
    const count = fake.calls.length;
    expect((await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))).message).toContain(
      "foreign ownership",
    );
    expect(
      (await Effect.runPromise(Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))))._tag,
    ).toBe("Left");
    expect(fake.calls.slice(count).some((call) => call.method === "DELETE")).toBe(false);
    expect(fake.container?.Id).toBe("foreign-replacement-id");
  });

  test("does not adopt resources after a crash before their instance identities are recorded", async () => {
    const volumeCrash = makeFakeApi();
    volumeCrash.controls.failVolumeInspectAfterCreate = true;
    expect(
      (
        await Effect.runPromise(
          Effect.either(ensureWindowsSyncHelper(volumeCrash.api, volumeCrash.stateStore, spec)),
        )
      )._tag,
    ).toBe("Left");
    volumeCrash.controls.failVolumeInspectAfterCreate = false;
    expect(
      (await failureOf(ensureWindowsSyncHelper(volumeCrash.api, volumeCrash.stateStore, spec))).message,
    ).toContain("ownership receipt");

    for (const createResponse of ["malformed", "lost"] as const) {
      const helperCrash = makeFakeApi();
      helperCrash.controls.helperCreateResponse = createResponse;
      expect(
        (
          await Effect.runPromise(
            Effect.either(ensureWindowsSyncHelper(helperCrash.api, helperCrash.stateStore, spec)),
          )
        )._tag,
      ).toBe("Left");
      helperCrash.controls.helperCreateResponse = "valid";
      const count = helperCrash.calls.length;
      expect(
        (await failureOf(ensureWindowsSyncHelper(helperCrash.api, helperCrash.stateStore, spec))).message,
      ).toContain("ownership receipt");
      expect(helperCrash.calls.slice(count).some((call) => call.method === "POST")).toBe(false);
      expect(helperCrash.container).toBeDefined();
    }
  });

  test("keeps the helper identity and volume after a failed removal so cleanup can retry", async () => {
    const fake = makeFakeApi();
    await Effect.runPromise(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    fake.controls.failDelete = true;
    expect(
      (await Effect.runPromise(Effect.either(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))))._tag,
    ).toBe("Left");
    expect(fake.container).toBeDefined();
    expect(fake.volume).toBeDefined();
    const count = fake.calls.length;
    expect((await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec))).message).toContain(
      "ownership receipt",
    );
    expect(fake.calls.slice(count).some((call) => call.method === "POST")).toBe(false);
    fake.controls.failDelete = false;
    expect(await Effect.runPromise(removeWindowsSyncHelper(fake.api, fake.stateStore, spec))).toBe(true);
    expect(fake.volume).toBeDefined();
  });

  test("fails before Podman requests for an unknown receipt version", async () => {
    const fake = makeFakeApi();
    const key = `${createHash("sha256")
      .update(JSON.stringify([spec.appId, spec.service, spec.mountKey]))
      .digest("hex")}.json`;
    const bucket = await Effect.runPromise(
      fake.stateStore.open({
        namespace: "windows-sync-helpers",
        key,
        schema: Schema.Struct({ old: Schema.String }),
        version: 2,
        codec: "json",
        mode: 0o600,
        lock: "advisory",
      }),
    );
    await Effect.runPromise(bucket.set({ old: "receipt" }));
    const error = await failureOf(ensureWindowsSyncHelper(fake.api, fake.stateStore, spec));
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.message).toContain("unknown version");
    expect(fake.calls).toEqual([]);
  });

  test("rejects a mutable helper image before making any API request", async () => {
    const fake = makeFakeApi();
    const error = await failureOf(
      ensureWindowsSyncHelper(fake.api, fake.stateStore, { ...spec, image: "alpine:latest" }),
    );
    expect(error.message).toContain("digest-pinned");
    expect(fake.calls).toEqual([]);
  });
});
