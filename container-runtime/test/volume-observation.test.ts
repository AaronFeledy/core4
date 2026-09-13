import { expect, test } from "bun:test";
import { Effect } from "effect";

import { AbsolutePath, AppId, PortablePath } from "@lando/sdk/schema";
import { observeMountedVolume, volumeCreationOwnerLabels } from "../src/volume-observation.ts";

test("binds creation ownership only to canonical app identity", () => {
  expect(volumeCreationOwnerLabels(undefined)).toEqual({});
  expect(
    volumeCreationOwnerLabels({ appRoot: AbsolutePath.make("/canonical/root"), ownerKey: "owner" }),
  ).toEqual({ "dev.lando.volume-owner": "/canonical/root" });
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
    Effect.either(
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
  expect(result._tag).toBe("Left");
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
    Effect.either(
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
  expect(result._tag).toBe("Left");
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
