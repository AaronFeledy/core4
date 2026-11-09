import { expect, test } from "bun:test";
import { identityRedactor } from "@lando/sdk/command-result";
import { AbsolutePath, AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema, Stream } from "effect";
import { makeProviderDataPlane } from "../src/data-plane.ts";
import { FakeEngineContractError } from "./support/fake-engine-state.ts";
import { FakeEngine } from "./support/fake-engine.ts";

test.each(["/unsupported", "/containers/helper/unsupported", "/volumes/data/unsupported"] as const)(
  "rejects an unimplemented engine route loudly: %s",
  async (path) => {
    const engine = new FakeEngine();
    await expect(Effect.runPromise(engine.request({ method: "GET", path }))).rejects.toBeInstanceOf(
      FakeEngineContractError,
    );
    await expect(
      Effect.runPromise(Stream.runDrain(engine.stream({ method: "GET", path }))),
    ).rejects.toBeInstanceOf(FakeEngineContractError);
  },
);

test("copying a file into a fake container makes its archive readable by the data plane", async () => {
  const engine = new FakeEngine().seedContainer("lando-parity--web");
  const plan = Schema.decodeUnknownSync(AppPlan)({
    id: "parity",
    name: "parity",
    slug: "parity",
    root: "/parity",
    provider: "test",
    services: {},
    stores: [],
    routes: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/parity/.lando.yml", runtime: 4 },
  });
  const target = { app: plan.id, service: ServiceName.make("web"), plan };
  const plane = makeProviderDataPlane({
    providerId: "test",
    api: engine.api,
    capabilities: { volumeSnapshot: "none" },
    redactor: identityRedactor,
  });
  await Effect.runPromise(
    plane.copyToService(target, {
      sourcePath: AbsolutePath.make(import.meta.path),
      targetPath: PortablePath.make("/tmp/payload"),
    }),
  );
  const chunks = await Effect.runPromise(
    Stream.runCollect(plane.copyFromService(target, { sourcePath: PortablePath.make("/tmp/payload") })),
  );
  expect(Buffer.concat(chunks).toString()).toBe(await Bun.file(import.meta.path).text());
});

test("loading an image stores the archive that export reads and deletion removes", async () => {
  const engine = new FakeEngine();
  const plane = makeProviderDataPlane({
    providerId: "test",
    api: engine.api,
    capabilities: { volumeSnapshot: "none" },
    redactor: identityRedactor,
  });
  const archive = new TextEncoder().encode("archive bytes");
  const ref = await Effect.runPromise(plane.importArtifact(Stream.make(archive)));
  const exported = await Effect.runPromise(Stream.runCollect(plane.exportArtifact(ref)));
  expect(Buffer.concat(exported)).toEqual(Buffer.from(archive));
  expect(
    (
      await Effect.runPromise(
        engine.request({ method: "DELETE", path: `/images/${encodeURIComponent(ref.ref)}` }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await Effect.runPromise(
        engine.request({ method: "GET", path: `/images/${encodeURIComponent(ref.ref)}/json` }),
      )
    ).status,
  ).toBe(404);
  expect(ref.providerId).toBe(ProviderId.make("test"));
});
