import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { makeProviderDataPlane } from "../src/data-plane.ts";
import { buildContainerRemoveRequest } from "../src/engine-api.ts";
import { ephemeralDataHelperLabels } from "../src/ephemeral-data-helpers.ts";
import { standaloneSecretsRedactor } from "../src/redact.ts";
import { volumeCreationLabels } from "../src/volume-creation.ts";
import { decodeStorageContainer, storageLifecycleFixture } from "./support/storage-lifecycle-fixture.ts";
import { storageLifecycleClient } from "./support/storage-lifecycle.ts";

const socket = process.env.LANDO_TEST_DOCKER_SOCKET;

test.skipIf(socket === undefined)(
  "native holder diagnostics preserve active, stopped and replacement helpers",
  async () => {
    if (socket === undefined) return;
    const client = storageLifecycleClient({ provider: "docker", socket });
    await Effect.runPromise(client.info);
    const anonymous: string[] = [];
    let retained = "";
    {
      await using fixture = storageLifecycleFixture(client, "docker");
      retained = fixture.retained;
      const tag = fixture.image.lastIndexOf(":");
      await fixture.call({
        method: "POST",
        path: `/images/alpine:3.20/tag?repo=${encodeURIComponent(fixture.image.slice(0, tag))}&tag=fixture`,
      });
      const store = fixture.plan.stores[0];
      if (store === undefined) throw new Error("Missing fixture store");
      const labels = volumeCreationLabels(fixture.plan, store);
      const generation = labels["dev.lando.volume-instance"];
      if (generation === undefined) throw new Error("Missing fixture generation");
      await fixture.call({
        method: "POST",
        path: "/volumes/create",
        body: { Name: retained, Labels: labels },
      });
      const name = `lando-docker-data-${fixture.plan.id}`;
      const create = async (owned: boolean) => {
        const response = await fixture.call({
          method: "POST",
          path: `/containers/create?name=${encodeURIComponent(name)}`,
          body: {
            Image: fixture.image,
            Cmd: ["sleep", "300"],
            Labels: owned
              ? ephemeralDataHelperLabels({
                  providerId: "docker",
                  app: fixture.plan.id,
                  appRoot: fixture.plan.root,
                  store: retained,
                })
              : {},
            Volumes: { "/ephemeral": {} },
            HostConfig: { Binds: [`${retained}:/retained`], NetworkMode: "none" },
          },
        });
        const id = (JSON.parse(response.body) as { Id: string }).Id;
        const observed = decodeStorageContainer(
          (await fixture.call({ method: "GET", path: `/containers/${id}/json` })).body,
        );
        const volume = observed.Mounts.find((mount) => mount.Destination === "/ephemeral")?.Name;
        if (volume === undefined) throw new Error("Missing fixture anonymous volume");
        anonymous.push(volume);
        return id;
      };
      const firstId = await create(true);
      let startDuringDiscovery = true;
      const requests: string[] = [];
      const plane = makeProviderDataPlane({
        providerId: "docker",
        capabilities: { volumeSnapshot: "none" },
        redactor: standaloneSecretsRedactor({}),
        api: {
          request: (input) => {
            requests.push(`${input.method} ${input.path}`);
            const request = fixture.api.request;
            if (request === undefined) throw new Error("Missing fixture request");
            return request(input).pipe(
              Effect.tap((response) => {
                if (!input.path.startsWith("/containers/json?") || !startDuringDiscovery) return Effect.void;
                startDuringDiscovery = false;
                expect(JSON.parse(response.body)).toEqual(
                  expect.arrayContaining([expect.objectContaining({ Id: firstId, State: "created" })]),
                );
                return request({ method: "POST", path: `/containers/${firstId}/start` });
              }),
            );
          },
        },
      });
      const blocked = async (id: string) => {
        const result = await Effect.runPromise(
          plane.removeVolume({ app: fixture.plan.id, store: retained }, generation).pipe(Effect.result),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.message).toContain(id);
        expect(requests.filter((request) => request.startsWith("DELETE /containers/"))).toEqual([]);
      };
      await blocked(firstId);
      expect(
        JSON.parse((await fixture.call({ method: "GET", path: `/containers/${firstId}/json` })).body).State
          .Running,
      ).toBe(true);
      await fixture.call({ method: "POST", path: `/containers/${firstId}/stop?t=1` });
      await blocked(firstId);
      await fixture.call({ method: "GET", path: `/containers/${firstId}/json` });
      await fixture.call(buildContainerRemoveRequest(firstId));
      const successorId = await create(false);
      expect(successorId).not.toBe(firstId);
      await blocked(successorId);
      expect(
        JSON.parse((await fixture.call({ method: "GET", path: `/containers/${successorId}/json` })).body).Id,
      ).toBe(successorId);
    }
    const request = client.request;
    if (request === undefined) throw new Error("Missing engine request");
    for (const volume of [retained, ...anonymous]) {
      expect(
        (await Effect.runPromise(request({ method: "GET", path: `/volumes/${encodeURIComponent(volume)}` })))
          .status,
      ).toBe(404);
    }
  },
  30000,
);
