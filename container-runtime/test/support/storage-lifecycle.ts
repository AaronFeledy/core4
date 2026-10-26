import assert from "node:assert/strict";
import { AbsolutePath, type AppPlan } from "@lando/sdk/schema";
import { Effect } from "effect";
import { tarStream } from "../../src/build-context.ts";
import { dockerLifecycleDialect, libpodLifecycleDialect } from "../../src/dialect.ts";
import { makeDockerApiClient } from "../../src/docker/api-client.ts";
import type { EngineApiClient } from "../../src/engine-api.ts";
import { requestContainerBuild } from "../../src/image-build-http.ts";
import { serviceContainerName } from "../../src/plan.ts";
import { makePodmanApiClient } from "../../src/podman/api-client.ts";
import { bringDown } from "../../src/podman/bring-down.ts";
import { bringUp } from "../../src/podman/bring-up.ts";
import { exec } from "../../src/podman/exec.ts";
import { postServiceLifecycle } from "../../src/service-lifecycle.ts";
import { volumeCreationLabels } from "../../src/volume-creation.ts";
import {
  decodeStorageContainer,
  storageLifecycleCommand,
  storageLifecycleFixture,
} from "./storage-lifecycle-fixture.ts";

export type StorageLifecycleInput = {
  readonly provider: "docker" | "podman";
  readonly socket: string;
};

const contextFor = (provider: StorageLifecycleInput["provider"]) => ({
  providerId: provider === "podman" ? "lando" : "docker",
  remediation: "Supply an explicit answering test socket and retry the storage lifecycle check.",
  env: {},
});

export const storageLifecycleClient = (input: StorageLifecycleInput): EngineApiClient => {
  assert.ok(input.socket.trim(), "An explicit socket is required; managed-runtime fallback is forbidden");
  switch (input.provider) {
    case "docker":
      return makeDockerApiClient(input.socket, contextFor(input.provider));
    case "podman":
      return makePodmanApiClient(input.socket, contextFor(input.provider));
    default: {
      const exhaustive: never = input.provider;
      return exhaustive;
    }
  }
};

/** Ordinary behavioral driver: no test-runner dependency, usable from a compiled Bun executable. */
export const runStorageLifecycle = async (
  input: StorageLifecycleInput,
  client: EngineApiClient = storageLifecycleClient(input),
) => {
  // The answering API probe precedes every resource acquisition, including fixture cleanup registration.
  await Effect.runPromise(client.info);
  await using fixture = storageLifecycleFixture(client, input.provider);
  const { api, call, plan, image, retained, foreign, borrower, network, serviceName } = fixture;
  const ctx = contextFor(input.provider);
  const options = {
    api,
    ctx,
    dialect: input.provider === "docker" ? dockerLifecycleDialect : libpodLifecycleDialect,
  };
  const target = { app: plan.id, service: serviceName };
  const container = serviceContainerName(plan, serviceName);
  const inspect = async () =>
    decodeStorageContainer((await call({ method: "GET", path: `/containers/${container}/json` })).body);
  const anonymousId = (observed: ReturnType<typeof decodeStorageContainer>) => {
    const id = observed.Mounts.find(
      (mount) => mount.Type === "volume" && mount.Destination === "/ephemeral",
    )?.Name;
    assert.ok(id, "Fixture image must create an image-declared volume at /ephemeral");
    assert.notEqual(id, retained);
    return id;
  };
  const volumeStatus = (id: string, status: number) =>
    call({ method: "GET", path: `/volumes/${encodeURIComponent(id)}` }, [status]);
  const run = async (command: readonly string[]) => {
    const result = await Effect.runPromise(exec(plan, target, { command }, options).pipe(Effect.scoped));
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout;
  };
  assert.ok(api.request);
  await Effect.runPromise(
    requestContainerBuild({
      request: api.request,
      options: { providerId: ctx.providerId, api, sourceEnv: {} },
      tag: image,
      path: `/build?t=${encodeURIComponent(image)}&dockerfile=Dockerfile&rm=true&forcerm=true`,
      stdin: tarStream([
        {
          kind: "file",
          name: "Dockerfile",
          mode: 0o644,
          content: new TextEncoder().encode(
            `FROM docker.io/library/busybox:1.37\nVOLUME ["/ephemeral"]\nCMD ${JSON.stringify(storageLifecycleCommand)}\n`,
          ),
        },
      ]),
      secretValues: [],
    }),
  );
  const foreignStore = { name: foreign, scope: "app", kind: "data" } as const;
  await call({
    method: "POST",
    path: "/volumes/create",
    body: {
      Name: foreign,
      // Same app id, different root: selection is not proof of ownership.
      Labels: volumeCreationLabels(
        { ...plan, root: AbsolutePath.make(`${plan.root}-foreign`) },
        foreignStore,
      ),
    },
  });
  await Effect.runPromise(bringUp(plan, options));
  const first = await inspect();
  const firstAnonymous = anonymousId(first);
  const marker = `retained:${plan.id}\nsecond line\n`;
  await run([
    "sh",
    "-c",
    'printf "%s" "$1" > /retained/marker; printf "%s" "$1" > /ephemeral/marker',
    "sh",
    marker,
  ]);

  // Selected in-place restart must retain both container identity and image-volume identity/data.
  await Effect.runPromise(postServiceLifecycle(plan, target, "restart", options));
  const restarted = await inspect();
  assert.equal(restarted.Id, first.Id);
  assert.equal(anonymousId(restarted), firstAnonymous);
  assert.equal(await run(["cat", "/ephemeral/marker"]), marker);

  const service = plan.services[serviceName];
  assert.ok(service);
  const replacement: AppPlan = {
    ...plan,
    services: {
      [serviceName]: { ...service, environment: { ...service.environment, STORAGE_FIXTURE_RECREATE: "1" } },
    },
  };
  await Effect.runPromise(bringUp(replacement, { ...options, reconcile: true }));
  const replaced = await inspect();
  const secondAnonymous = anonymousId(replaced);
  assert.notEqual(replaced.Id, first.Id);
  assert.notEqual(secondAnonymous, firstAnonymous);
  await volumeStatus(firstAnonymous, 404);
  assert.equal(await run(["cat", "/retained/marker"]), marker);

  await Effect.runPromise(bringDown(replacement, options));
  await volumeStatus(secondAnonymous, 404);
  await volumeStatus(retained, 200);
  await call({ method: "GET", path: `/containers/${container}/json` }, [404]);
  await call({ method: "GET", path: `/networks/${network}` }, [404]);
  await Effect.runPromise(bringUp(plan, options));
  assert.equal(await run(["cat", "/retained/marker"]), marker);
  const thirdAnonymous = anonymousId(await inspect());
  assert.notEqual(thirdAnonymous, secondAnonymous);

  // Borrow by exact name while the original owner exists. Docker may keep it after both owners go;
  // the fixture ledger explicitly removes it at the end rather than promising different semantics.
  await call({
    method: "POST",
    path: `/containers/create?name=${borrower}`,
    body: {
      Image: image,
      Cmd: storageLifecycleCommand,
      HostConfig: { NetworkMode: "none", Binds: [`${thirdAnonymous}:/ephemeral`] },
    },
  });
  await Effect.runPromise(
    bringDown({ ...plan, stores: [...plan.stores, foreignStore] }, { ...options, volumes: true }),
  );
  await volumeStatus(retained, 404);
  await volumeStatus(foreign, 200);
  await volumeStatus(thirdAnonymous, 200);
  return {
    outcome: "passed" as const,
    provider: input.provider,
    app: plan.id,
    anonymousRemoved: [firstAnonymous, secondAnonymous],
    retained,
    referenced: thirdAnonymous,
    foreign,
    checks: [
      "restart-identity",
      "replacement",
      "default-teardown",
      "named-marker-persistence",
      "owned-named-deletion",
      "foreign-preservation",
      "referenced-preservation",
    ],
    // async disposal completes before the caller receives this result; cleanup failure rejects it.
    cleanup: "completed" as const,
  };
};
