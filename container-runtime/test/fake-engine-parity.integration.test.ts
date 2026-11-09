import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { failureOutcomeFromCause, identityRedactor } from "@lando/sdk/command-result";
import { AppId } from "@lando/sdk/schema";
import { Effect, Exit, Stream } from "effect";
import { makeProviderDataPlane } from "../src/data-plane.ts";
import type { HelperBehavior } from "./support/fake-engine-state.ts";
import { FakeEngine } from "./support/fake-engine.ts";
import { storageLifecycleClient } from "./support/storage-lifecycle.ts";

const socket = process.env.LANDO_TEST_PODMAN_SOCKET;
const image = "docker.io/library/busybox:1.37";
const bytes = (value: string) => new TextEncoder().encode(value);

for (const backend of ["fake", "live"] as const) {
  const setup = (behavior: HelperBehavior = {}) => {
    if (backend === "live" && socket === undefined)
      throw new Error("Live parity requires LANDO_TEST_PODMAN_SOCKET");
    const fake = new FakeEngine(behavior);
    fake.assets.images.set(image, { Id: "sha256:busybox", Size: 1 });
    const api =
      backend === "live" && socket !== undefined
        ? storageLifecycleClient({
            provider: "podman",
            socket,
          })
        : fake.api;
    const plane = makeProviderDataPlane({
      providerId: "podman",
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: identityRedactor,
    });
    return { api, plane };
  };
  const parity = test.skipIf(backend === "live" && socket === undefined);

  parity(`${backend} parity: attach preserves stdout, stderr and terminal exit code`, async () => {
    const { plane } = setup({ stdout: bytes("output\n"), stderr: bytes("diagnostic\n"), exitCode: 0 });
    const chunks = await Effect.runPromise(
      Effect.scoped(
        plane
          .runStream({
            image,
            command: ["sh", "-c", "printf 'output\\n'; printf 'diagnostic\\n' >&2"],
            remove: true,
          })
          .pipe(Stream.runCollect),
      ),
    );
    const output = (kind: "stdout" | "stderr") =>
      Buffer.concat(
        chunks.flatMap((chunk) => ("kind" in chunk && chunk.kind === kind ? [chunk.chunk] : [])),
      ).toString();
    expect({
      stdout: output("stdout"),
      stderr: output("stderr"),
      terminal: chunks.filter((chunk) => "exitCode" in chunk),
    }).toEqual({ stdout: "output\n", stderr: "diagnostic\n", terminal: [{ exitCode: 0 }] });
  });

  parity(`${backend} parity: missing image fails at creation with HTTP 404`, async () => {
    const { plane } = setup();
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        plane.run({
          image: `localhost/lando-parity-missing-${randomUUID()}:absent`,
          command: ["true"],
          remove: true,
        }),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected missing image failure");
    expect(failureOutcomeFromCause(exit.cause).error).toMatchObject({
      _tag: "ProviderUnavailableError",
      operation: "run.create",
      details: { status: 404 },
    });
  });

  parity(`${backend} parity: created volumes list by labels and remove by generation`, async () => {
    const { api, plane } = setup();
    const request = api.request;
    if (request === undefined) throw new Error("Missing parity request client");
    const generation = randomUUID();
    const app = AppId.make(`parity-${randomUUID()}`);
    const name = `lando-parity-${randomUUID()}`;
    const labels = {
      "dev.lando.app": app,
      "dev.lando.store": name,
      "dev.lando.scope": "app",
      "dev.lando.volume-instance": generation,
      "dev.lando.volume-owner": `/parity/${app}`,
    };
    try {
      const created = await Effect.runPromise(
        request({ method: "POST", path: "/volumes/create", body: { Name: name, Labels: labels } }),
      );
      expect([200, 201]).toContain(created.status);
      const volumes = await Effect.runPromise(
        plane.listVolumes({ app, labels: { "dev.lando.store": name } }),
      );
      expect(
        volumes.map((volume) => ({
          ref: volume.ref,
          instanceId: volume.instanceId,
          provenance: volume.provenance,
        })),
      ).toEqual([{ ref: { app, store: name, scope: "app" }, instanceId: generation, provenance: "known" }]);
      expect(await Effect.runPromise(plane.removeVolume({ app, store: name }, generation))).toBeUndefined();
    } finally {
      const removed = await Effect.runPromise(
        request({ method: "DELETE", path: `/volumes/${encodeURIComponent(name)}` }),
      );
      expect([204, 404]).toContain(removed.status);
    }
  });

  parity(`${backend} parity: helper nonzero exit remains an observable result`, async () => {
    const { plane } = setup({ exitCode: 7, stdout: bytes("kept\n"), stderr: bytes("failed\n") });
    expect(
      await Effect.runPromise(
        Effect.scoped(
          plane.run({
            image,
            command: ["sh", "-c", "printf 'kept\\n'; printf 'failed\\n' >&2; exit 7"],
            captureStdout: true,
            remove: true,
          }),
        ),
      ),
    ).toEqual({ exitCode: 7, stdout: "kept\n", stderr: "failed\n" });
  });
}
