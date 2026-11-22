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

test.each(["legacy", "local", "peer"] as const)(
  "destroy verifies a legacy row against a %s container",
  async (kind) => {
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
    const userDataRoot = "/data/current";
    const cleanup = makeOwnedResourcesCleanup({
      ctx: { providerId: "test", remediation: "Retry cleanup.", env: {} },
      userDataRoot,
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
                      ...(kind === "legacy"
                        ? {}
                        : { "dev.lando.data-root": kind === "local" ? userDataRoot : "/data/peer" }),
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
    const result = await Effect.runPromise(cleanup(root, { volumes: false }).pipe(Effect.result));
    if (kind === "peer") {
      expect(result).toMatchObject({ _tag: "Failure", failure: { operation: "resource-ownership" } });
      expect(calls.map(({ method }) => method)).toEqual(["GET"]);
      expect(retired).toEqual([]);
      return;
    }

    // Then: label-checked removal targets the inventoried old name, never today's recomputed name.
    expect(calls).toEqual([
      { method: "GET", path: `/containers/${encodeURIComponent(oldNativeName)}/json` },
      { method: "DELETE", path: `/containers/${encodeURIComponent(observedId)}?force=true&v=true` },
    ]);
    expect(calls.some((call) => call.path.includes(currentNativeName))).toBe(false);
    expect(retired).toEqual([container]);
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        servicesRemoved: [service],
        networksRemoved: 0,
        volumesRemoved: { data: 0, cache: 0 },
      },
    });
  },
);
