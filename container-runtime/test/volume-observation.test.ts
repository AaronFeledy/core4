import { expect, test } from "bun:test";
import { ProviderUnavailableError, VolumeOperationError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { AbsolutePath, AppId, PortablePath } from "@lando/sdk/schema";
import { resolveNativeVolumeIdentity, volumeCoordinationKey } from "../src/native-volume-identity.ts";
import { locateVolume, observeMountedVolume } from "../src/volume-observation.ts";

test("preserves transport failures across volume and daemon observations", async () => {
  // Given an unavailable provider transport.
  const failure = new ProviderUnavailableError({
    providerId: "lando",
    operation: "request",
    message: "Runtime offline",
    remediation: "Run lando setup",
  });
  const provider = {
    providerId: "lando",
    endpointNamespace: "test",
    api: { request: () => Effect.fail(failure) },
  };
  // When locating a volume, inspecting a mount, or discovering the daemon namespace.
  const results = await Effect.runPromise(
    Effect.all([
      locateVolume(provider, { app: AppId.make("app"), store: "data" }).pipe(Effect.result),
      observeMountedVolume(provider, {
        app: AppId.make("app"),
        containerId: "id",
        destination: PortablePath.make("/data"),
      }).pipe(Effect.result),
      volumeCoordinationKey({ providerId: provider.providerId, api: provider.api }, "data").pipe(
        Effect.result,
      ),
      resolveNativeVolumeIdentity(
        { ...provider, runVolumeWitness: () => Effect.fail(failure) },
        { Name: "data", Driver: "local" },
        { _tag: "named" },
      ).pipe(Effect.result),
    ]),
  );
  // Then every layer retains the same provider error.
  for (const result of results) {
    if (result._tag !== "Failure") throw new TypeError("expected transport failure");
    expect(result.failure).toBe(failure);
  }
});

test.each([200, 503])(
  "retains decode cause or HTTP status without response body for status %i",
  async (status) => {
    // Given malformed or unsuccessful provider output containing private bytes.
    const body = "private-response-bytes";
    const provider = {
      providerId: "lando",
      endpointNamespace: "test",
      api: { request: () => Effect.succeed({ status, body }) },
    };
    // When locating the volume.
    const result = await Effect.runPromise(
      locateVolume(provider, { app: AppId.make("app"), store: "data" }).pipe(Effect.result),
    );
    // Then decode failures retain their cause and HTTP failures retain their status, not the body.
    if (result._tag !== "Failure" || !(result.failure instanceof VolumeOperationError))
      throw new TypeError("expected observation failure");
    expect(result.failure.message).not.toContain(body);
    if (status === 200) expect(result.failure.cause).toMatchObject({ _tag: "SchemaError" });
    else expect(result.failure.message).toContain("503");
  },
);

test("retains decode causes at daemon namespace and witness boundaries", async () => {
  // Given malformed daemon and witness responses.
  const provider = {
    providerId: "lando",
    api: { request: () => Effect.succeed({ status: 200, body: "private-invalid-json" }) },
  };
  // When reading the namespace or resolving a witnessed identity.
  const results = await Effect.runPromise(
    Effect.all([
      volumeCoordinationKey(provider, "data").pipe(Effect.result),
      resolveNativeVolumeIdentity(
        {
          ...provider,
          endpointNamespace: "test",
          runVolumeWitness: () => Effect.succeed({ exitCode: 0, stdout: "private-invalid-json", stderr: "" }),
        },
        { Name: "data", Driver: "local" },
        { _tag: "named" },
      ).pipe(Effect.result),
    ]),
  );
  // Then each decode boundary retains its schema cause without echoing the body in the message.
  for (const result of results) {
    if (result._tag !== "Failure") throw new TypeError("expected decode failure");
    expect(result.failure).toMatchObject({ _tag: "VolumeOperationError", cause: { _tag: "SchemaError" } });
    expect(result.failure.message).not.toContain("private-invalid-json");
  }
});

test("reports an unexpected daemon namespace HTTP status without its body", async () => {
  // Given a failed daemon namespace request.
  const provider = {
    providerId: "lando",
    api: { request: () => Effect.succeed({ status: 503, body: "private-daemon-body" }) },
  };
  // When obtaining the coordination namespace.
  const result = await Effect.runPromise(volumeCoordinationKey(provider, "data").pipe(Effect.result));
  // Then the failure is visible with its HTTP status, not its raw body.
  if (result._tag !== "Failure") throw new TypeError("expected HTTP failure");
  expect(result.failure.message).toContain("503");
  expect(result.failure.message).not.toContain("private-daemon-body");
});

test("keeps the configured endpoint and native name stable before and after creation", async () => {
  // Given a configured provider endpoint whose volume appears after the first lookup.
  let created = false;
  const api = {
    request: () =>
      Effect.succeed(
        created
          ? {
              status: 200,
              body: JSON.stringify({
                Name: "native-data",
                Labels: {
                  "dev.lando.volume-instance": "generation-two",
                  "dev.lando.volume-owner": "/canonical/root",
                },
              }),
            }
          : { status: 404, body: "" },
      ),
  };
  const provider = { providerId: "podman", endpointNamespace: "unix:///run/podman.sock", api };
  const ref = { app: AppId.make("app"), store: "native-data", scope: "app" as const };

  // When locating before creation and after the daemon reports the created generation.
  const before = await Effect.runPromise(locateVolume(provider, ref));
  created = true;
  const after = await Effect.runPromise(locateVolume(provider, ref));

  // Then both observations coordinate on the actual native volume, never app/root hashes.
  expect(before.coordinationKey).toBe(after.coordinationKey);
  expect(before.nativeName).toBe("native-data");
  expect(before.identity).toBeUndefined();
  expect(after.identity?.generation).toBe("generation-two");
  expect(after.identity?.coordinationKey).toBe(before.coordinationKey);
});

test("observes the native volume at the destination rather than the planned store name", async () => {
  // Given a container whose actual mount differs from its plan's naming convention.
  const paths: string[] = [];
  const api = {
    request: (input: { readonly path: string }) => {
      paths.push(input.path);
      return Effect.succeed({
        status: 200,
        body: JSON.stringify(
          input.path.startsWith("/containers/")
            ? { Mounts: [{ Type: "volume", Destination: "/var/lib/mysql", Name: "foreign-native" }] }
            : { Name: "foreign-native", Labels: {} },
        ),
      });
    },
  };
  // When observing by the inspected container and mount destination.
  const result = await Effect.runPromise(
    observeMountedVolume(
      { providerId: "docker", api },
      {
        app: AppId.make("same-slug"),
        containerId: "container-id",
        destination: PortablePath.make("/var/lib/mysql"),
      },
    ),
  );
  // Then only the actual native volume is inspected; legacy provenance is not fabricated.
  expect(paths).toEqual(["/containers/container-id/json", "/volumes/foreign-native"]);
  expect(result.ref.store).toBe("foreign-native");
  expect(result.provenance).toBe("legacy");
  expect(result.instanceId).toBeUndefined();
});

test("fails closed when a destination is a bind mount", async () => {
  // Given a bind mount at the requested destination.
  const api = {
    request: () =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify({
          Mounts: [{ Type: "bind", Destination: "/data", Source: "/host/data" }],
        }),
      }),
  };
  // When observing it as a physical named volume.
  const result = await Effect.runPromise(
    Effect.result(
      observeMountedVolume(
        { providerId: "podman", api },
        {
          app: AppId.make("app"),
          containerId: "id",
          destination: PortablePath.make("/data"),
        },
      ),
    ),
  );
  // Then no volume identity is inferred from the plan or bind source.
  expect(result._tag).toBe("Failure");
});

test("returns owner-bound generation only with an observed daemon namespace", async () => {
  const api = {
    request: (input: { readonly path: string }) =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify(
          input.path === "/info"
            ? { ID: "daemon-one" }
            : input.path.startsWith("/containers/")
              ? { Mounts: [{ Type: "volume", Destination: "/data", Name: "native" }] }
              : {
                  Name: "native",
                  Labels: {
                    "dev.lando.volume-instance": "creation-token",
                    "dev.lando.volume-owner": "/canonical/root",
                  },
                },
        ),
      }),
  };
  const result = await Effect.runPromise(
    observeMountedVolume(
      { providerId: "docker", api },
      {
        app: AppId.make("app"),
        containerId: "id",
        destination: PortablePath.make("/data"),
      },
    ),
  );
  expect(result.identity).toEqual({
    coordinationKey: JSON.stringify(["daemon-one", "native"]),
    nativeName: "native",
    generation: "creation-token",
    ownerRoot: AbsolutePath.make("/canonical/root"),
    origin: "created",
  });
});

test.each([
  { label: "missing destination", mounts: [] },
  { label: "anonymous mount without native name", mounts: [{ Type: "volume", Destination: "/data" }] },
  {
    label: "ambiguous destination",
    mounts: [
      { Type: "volume", Destination: "/data", Name: "one" },
      { Type: "volume", Destination: "/data", Name: "two" },
    ],
  },
])("rejects $label without looking up a volume", async ({ mounts }) => {
  const paths: string[] = [];
  const api = {
    request: (input: { readonly path: string }) => {
      paths.push(input.path);
      return Effect.succeed({ status: 200, body: JSON.stringify({ Mounts: mounts }) });
    },
  };
  const result = await Effect.runPromise(
    Effect.result(
      observeMountedVolume(
        { providerId: "lando", api },
        {
          app: AppId.make("app"),
          containerId: "id",
          destination: PortablePath.make("/data"),
        },
      ),
    ),
  );
  expect(result._tag).toBe("Failure");
  expect(paths).toEqual(["/containers/id/json"]);
});

test("leaves owner-bound identity unavailable when the daemon omits its namespace", async () => {
  const api = {
    request: (input: { readonly path: string }) =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify(
          input.path === "/info"
            ? {}
            : input.path.startsWith("/containers/")
              ? { Mounts: [{ Type: "volume", Destination: "/data", Name: "native" }] }
              : {
                  Name: "native",
                  Labels: { "dev.lando.volume-instance": "token", "dev.lando.volume-owner": "/root" },
                },
        ),
      }),
  };
  const result = await Effect.runPromise(
    observeMountedVolume(
      { providerId: "lando", api },
      {
        app: AppId.make("app"),
        containerId: "id",
        destination: PortablePath.make("/data"),
      },
    ),
  );
  expect(result.identity).toBeUndefined();
});
