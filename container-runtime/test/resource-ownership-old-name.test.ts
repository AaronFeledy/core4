import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  ProviderId,
  ServiceName,
  appIdentityKey,
  landoServiceContainerName,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import type { EngineHttpRequest } from "../src/engine-api.ts";
import { makeOwnedResourcesCleanup } from "../src/resource-cleanup.ts";
import { type OwnedResource, makeResourceOwnershipStore } from "../src/resource-ownership.ts";

test("destroy inventory cleanup removes an old-named owned container after label checks", async () => {
  // Given: inventory still names the container with the pre-double-dash physical form.
  const root = AbsolutePath.make("/apps/myapp");
  const slug = "myapp";
  const service = ServiceName.make("web");
  const oldNativeName = `lando-${slug}-${service}`;
  const currentNativeName = landoServiceContainerName(slug, service);
  expect(oldNativeName).not.toBe(currentNativeName);
  expect(currentNativeName).toBe("lando-myapp--web");

  const owner = {
    appRoot: root,
    ownerKey: appIdentityKey("owner", root),
    appId: AppId.make("myapp"),
    providerId: ProviderId.make("test"),
    identityDigest: "digest",
  };
  const container: OwnedResource = {
    ...owner,
    kind: "container",
    nativeName: oldNativeName,
    service,
  };
  const calls: EngineHttpRequest[] = [];
  const retired: OwnedResource[] = [];
  const observedId = "observed-old-container-id";
  const cleanup = makeOwnedResourcesCleanup({
    ctx: { providerId: "test", remediation: "Retry cleanup.", env: {} },
    store: {
      ...makeResourceOwnershipStore("test"),
      load: () =>
        Effect.succeed({
          appRoot: root,
          ownerKey: owner.ownerKey,
          providerId: owner.providerId,
          appIds: [owner.appId],
          resources: [container],
        }),
      retire: (_root, resource) =>
        Effect.sync(() => {
          retired.push(resource);
        }),
    },
    api: {
      request: (request) =>
        Effect.sync(() => {
          calls.push(request);
          if (request.method === "GET") {
            // Engine still holds the container under the inventoried old name with ownership labels.
            expect(request.path).toBe(`/containers/${encodeURIComponent(oldNativeName)}/json`);
            return {
              status: 200,
              body: JSON.stringify({
                Id: observedId,
                Config: {
                  Labels: {
                    "dev.lando.app": owner.appId,
                    "dev.lando.app-root": root,
                    "dev.lando.service": service,
                  },
                },
              }),
            };
          }
          return { status: 204, body: "" };
        }),
    },
  });

  // When: destroy-owned cleanup runs (same helper destroy-execute and orphan-teardown invoke).
  const result = await Effect.runPromise(cleanup(root, { volumes: false }));

  // Then: label-checked removal targets the inventoried old name, never today's recomputed name.
  expect(calls).toEqual([
    { method: "GET", path: `/containers/${encodeURIComponent(oldNativeName)}/json` },
    { method: "DELETE", path: `/containers/${encodeURIComponent(observedId)}?force=true&v=true` },
  ]);
  expect(calls.some((call) => call.path.includes(currentNativeName))).toBe(false);
  expect(retired).toEqual([container]);
  expect(result).toEqual({
    servicesRemoved: [service],
    networksRemoved: 0,
    volumesRemoved: 0,
  });
});
