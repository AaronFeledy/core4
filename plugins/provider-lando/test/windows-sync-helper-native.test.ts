import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { sha256Hex } from "@lando/sdk/digest";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { inspectWindowsSyncHelper } from "../src/windows-sync-helper.ts";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

// Validation fields observed through the native Windows Podman named-pipe API.
// No environment values or application contents are retained.
const digest = "sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb";
const platformDigest = "sha256:8aac45197595035f697ea6b11cd73ce2401d82503fcb2540b5fac606973b242b";
const imageId = "sha256:1c18531a436bdb4088b1a8bb45909af2809e36894f944259c5e7d6287a7cc166";
const spec = {
  appId: "sync-live-1811-cc73d8",
  appName: "sync-live-1811-cc73d8",
  service: "app",
  mountKey: "app-mount",
  image: `docker.io/oven/bun:1.4.0-alpine@${digest}`,
  owner: "0",
  group: "0",
} as const;
const receipt = {
  specDigest: "5dd068a55dc6067ae5acdab9592afa8eda6657289940b72b5cf91c1b633717b3",
  volumeNonce: "6f65ca3b908396f27aa63607ae292d01cbac3a9789dc41ddadc371e3d90328ae",
  volumeCreatedAt: "2026-10-28T14:26:05-05:00",
  helperNonce: "5bd1b837d067a94396ba7919c500d7052b7a3f75d053c385ac8435cbda6c34f3",
  containerId: "bc93e7d40c7636dc188951ce42840b0d8a022982eaf5442e4ec99b951901efe8",
  removing: false,
} as const;
const containerName = "lando-sync-sync-live-1811-cc73d8-5dd068a55dc6067a";
const volumeName = "sync-live-1811-cc73d8-app-app-mount";
const labels = {
  "dev.lando.app": spec.appId,
  "dev.lando.provider": "lando",
  "dev.lando.sync.mount-key": "app-mount",
  "dev.lando.sync.service": "app",
  "dev.lando.sync.spec-sha256": receipt.specDigest,
} as const;

const inspectNativeHelper = async (image: unknown) => {
  const stateStore = makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make(join(tmpdir(), `lando-sync-native-${randomUUID()}`)),
    ownerOnlyFileAccess,
  );
  const bucket = await Effect.runPromise(
    stateStore.open({
      namespace: "windows-sync-helpers",
      key: `${sha256Hex(JSON.stringify([spec.appId, spec.service, spec.mountKey]))}.json`,
      schema: Schema.Struct({
        specDigest: Schema.String,
        volumeNonce: Schema.String,
        volumeCreatedAt: Schema.String,
        helperNonce: Schema.String,
        containerId: Schema.String,
        removing: Schema.Boolean,
      }),
      version: 1,
      codec: "json",
      mode: 0o600,
      lock: "advisory",
    }),
  );
  await Effect.runPromise(bucket.set(receipt));
  const responses: Readonly<Record<string, unknown>> = {
    [`/images/${encodeURIComponent(spec.image)}/json`]: image,
    [`/volumes/${volumeName}`]: {
      Name: volumeName,
      Driver: "local",
      CreatedAt: receipt.volumeCreatedAt,
      Options: {},
      Labels: { ...labels, "dev.lando.sync.kind": "volume", "dev.lando.sync.nonce": receipt.volumeNonce },
    },
    [`/containers/${containerName}/json`]: {
      Id: receipt.containerId,
      Name: `/${containerName}`,
      Image: imageId,
      Config: {
        Image: `docker.io/oven/bun@${digest}`,
        Entrypoint: ["sh", "-c"],
        Cmd: ["while :; do sleep 3600; done"],
        User: "0:0",
        Labels: { ...labels, "dev.lando.sync.kind": "helper", "dev.lando.sync.nonce": receipt.helperNonce },
      },
      HostConfig: {
        Privileged: false,
        PublishAllPorts: false,
        AutoRemove: false,
        Devices: [],
        DeviceRequests: null,
        PortBindings: {},
        CapAdd: [],
        SecurityOpt: [],
        Sysctls: null,
        VolumesFrom: null,
        PidMode: "private",
        IpcMode: "shareable",
        UTSMode: "private",
        UsernsMode: "",
        CgroupnsMode: "private",
        NetworkMode: "none",
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      },
      Mounts: [{ Type: "volume", Name: volumeName, Destination: "/sync", RW: true }],
      State: { Status: "created", Running: false },
    },
  };
  const api = {
    request: (request: EngineHttpRequest) =>
      Effect.sync(() => {
        expect(request.method).toBe("GET");
        expect(Object.hasOwn(responses, request.path)).toBe(true);
        return { status: 200, body: JSON.stringify(responses[request.path]) };
      }),
  };
  return Effect.runPromise(Effect.result(inspectWindowsSyncHelper(api, stateStore, spec)));
};

test("recognizes the recorded native helper when Podman omits the tag from RepoDigests", async () => {
  // Given the native image response, including its multi-platform and platform digests.
  const image = {
    Id: imageId,
    RepoDigests: [`docker.io/oven/bun@${digest}`, `docker.io/oven/bun@${platformDigest}`],
  };
  // When the existing helper is verified against its original tagged-and-pinned specification.
  const result = await inspectNativeHelper(image);
  // Then it is recognized without changing its receipt or touching the runtime.
  expect(result).toMatchObject({
    _tag: "Success",
    success: { containerId: receipt.containerId, containerName, volumeName, path: "/sync" },
  });
});

test.each([
  { Id: imageId, RepoDigests: [`docker.io/oven/other@${digest}`], Digest: digest },
  { Id: imageId, RepoDigests: [`other.invalid/oven/bun@${digest}`], Digest: digest },
  { Id: imageId, RepoDigests: [`docker.io/oven/bun@${platformDigest}`], Digest: digest },
  { Id: imageId, RepoDigests: [], Digest: digest },
  { Id: imageId, RepoDigests: null, Digest: digest },
  { Id: `sha256:${"f".repeat(64)}`, RepoDigests: [`docker.io/oven/bun@${digest}`] },
])("rejects contradictory native image evidence %#", async (image) => {
  // Given image evidence with a different repository, registry, digest, or local image ID.
  // When the same receipt-backed helper is inspected.
  const result = await inspectNativeHelper(image);
  // Then no digest-only fallback or repository substitution can authorize the helper.
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProviderUnavailableError", operation: "syncHelper.container" },
  });
});
