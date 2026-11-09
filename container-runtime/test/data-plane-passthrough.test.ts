import { expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { annotateFailureRole, failureOutcomeFromCause, taggedErrorJson } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";
import { Cause, Effect, Exit, Schema, type Scope, Stream } from "effect";
import { type ProviderDataPlane, makeProviderDataPlane } from "../src/data-plane.ts";
import { echoHelperPull } from "./helper-pull-support.ts";
import { FakeEngine, type Operation } from "./support/fake-engine.ts";

const plan = Schema.decodeSync(AppPlan)({
  id: "fixture",
  name: "fixture",
  slug: "fixture",
  root: "/fixture",
  provider: "test",
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/fixture/.lando.yml", runtime: 4 },
});
const volume = { app: plan.id, store: "data" };
const target = { app: plan.id, service: ServiceName.make("web"), plan };
const snapshot = {
  provider: "test",
  id: "snapshot",
  digest: "sha256:fixture",
  sizeBytes: 1,
  format: "native" as const,
};
const secret = "transport-credential-canary";
const original = new ProviderUnavailableError({
  providerId: "test",
  operation: "transport.original",
  message: `Engine unavailable ${secret}`,
  remediation: `Repair the socket ${secret}`,
  details: { private: secret },
});
const redactor = createStandaloneRedactor("secrets", { authoritativeTokens: [secret] });
const members: ReadonlyArray<{
  readonly name: string;
  readonly operation: Operation;
  readonly invoke: (plane: ProviderDataPlane) => Effect.Effect<unknown, ProviderError, Scope.Scope>;
}> = [
  {
    name: "snapshotVolume",
    operation: "container.start",
    invoke: (plane) => plane.snapshotVolume({ volume }),
  },
  {
    name: "restoreVolume",
    operation: "image.inspect",
    invoke: (plane) =>
      plane.restoreVolume({ snapshot, target: volume, expectedTargetGeneration: "generation" }),
  },
  { name: "listVolumes", operation: "volume.list", invoke: (plane) => plane.listVolumes({}) },
  {
    name: "removeVolume",
    operation: "volume.inspect",
    invoke: (plane) => plane.removeVolume(volume, "generation"),
  },
  {
    name: "copyToService",
    operation: "archive.put",
    invoke: (plane) =>
      plane.copyToService(target, {
        sourcePath: AbsolutePath.make(import.meta.path),
        targetPath: PortablePath.make("/payload"),
      }),
  },
  {
    name: "copyFromService",
    operation: "archive.get",
    invoke: (plane) =>
      Stream.runDrain(plane.copyFromService(target, { sourcePath: PortablePath.make("/payload") })),
  },
  {
    name: "exportArtifact",
    operation: "image.get",
    invoke: (plane) =>
      Stream.runDrain(plane.exportArtifact({ providerId: ProviderId.make("test"), ref: "fixture" })),
  },
  { name: "importArtifact", operation: "image.load", invoke: (plane) => plane.importArtifact(Stream.empty) },
];

test.each(members)("$name keeps transport identity and remediation", async ({ invoke, operation }) => {
  const engine = new FakeEngine().fail(operation, original);
  const plane = makeProviderDataPlane({
    providerId: "test",
    redactor,
    capabilities: { volumeSnapshot: "native" },
    pullHelperImage: echoHelperPull(),
    api: engine.api,
  });
  const exit = await Effect.runPromiseExit(Effect.scoped(invoke(plane)));
  if (!Exit.isFailure(exit)) throw new Error("Expected transport failure");
  const error = failureOutcomeFromCause(exit.cause).error;
  expect(error).toBeInstanceOf(ProviderUnavailableError);
  expect(error).toMatchObject({
    operation: "transport.original",
    remediation: "Repair the socket [redacted]",
  });
  expect(JSON.stringify(taggedErrorJson(error))).not.toContain(secret);
});

test.each(members.filter(({ name }) => !["copyFromService", "exportArtifact"].includes(name)))(
  "$name classifies a locally detected HTTP failure",
  async ({ name, invoke, operation }) => {
    const engine = new FakeEngine().fail(operation, { status: 503, body: secret });
    const plane = makeProviderDataPlane({
      providerId: "test",
      redactor,
      capabilities: { volumeSnapshot: "native" },
      pullHelperImage: echoHelperPull(),
      api: engine.api,
    });
    const exit = await Effect.runPromiseExit(Effect.scoped(invoke(plane)));
    if (!Exit.isFailure(exit)) throw new Error("Expected HTTP failure");
    const error = failureOutcomeFromCause(exit.cause).error;
    expect(error).toMatchObject({
      _tag:
        name === "copyToService"
          ? "ServiceCopyError"
          : name === "importArtifact"
            ? "ArtifactTransferError"
            : "VolumeOperationError",
    });
    expect(taggedErrorJson(error).details).toEqual({ status: 503, body: "[redacted]" });
    expect(JSON.stringify(taggedErrorJson(error))).not.toContain(secret);
  },
);

test("copyFromService preserves a mid-stream transport cause with all reasons", async () => {
  const secondary = new ProviderUnavailableError({
    ...original,
    message: original.message,
    operation: "transport.secondary",
  });
  const engine = new FakeEngine();
  engine.feeds.set(
    "archive.get",
    Stream.concat(
      Stream.make(new Uint8Array(128)),
      Stream.failCause(
        Cause.combine(Cause.fail(original), annotateFailureRole(Cause.fail(secondary), "cleanup")),
      ),
    ),
  );
  const plane = makeProviderDataPlane({
    providerId: "test",
    redactor,
    capabilities: { volumeSnapshot: "native" },
    api: engine.api,
  });
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Stream.runDrain(plane.copyFromService(target, { sourcePath: PortablePath.make("/payload") })),
    ),
  );
  if (!Exit.isFailure(exit)) throw new Error("Expected mid-stream failure");
  const outcome = failureOutcomeFromCause(exit.cause);
  expect(outcome.error).toMatchObject({ _tag: "ProviderUnavailableError", operation: "transport.original" });
  expect(outcome.additionalErrors).toMatchObject([
    { role: "cleanup", error: { _tag: "ProviderUnavailableError", operation: "transport.secondary" } },
  ]);
  expect(JSON.stringify(taggedErrorJson(outcome.error))).not.toContain(secret);
});

test("removeVolume keeps multiple transport reasons", async () => {
  const secondary = new ProviderUnavailableError({
    ...original,
    message: original.message,
    operation: "transport.secondary",
  });
  const engine = new FakeEngine().inject(
    "volume.inspect",
    Effect.failCause(
      Cause.combine(Cause.fail(original), annotateFailureRole(Cause.fail(secondary), "cleanup")),
    ),
  );
  const plane = makeProviderDataPlane({
    providerId: "test",
    redactor,
    capabilities: { volumeSnapshot: "native" },
    api: engine.api,
  });
  const exit = await Effect.runPromiseExit(plane.removeVolume(volume, "generation"));
  if (!Exit.isFailure(exit)) throw new Error("Expected multiple failures");
  const outcome = failureOutcomeFromCause(exit.cause);
  expect(outcome.error).toMatchObject({ _tag: "ProviderUnavailableError", operation: "transport.original" });
  expect(outcome.additionalErrors).toMatchObject([
    { role: "cleanup", error: { operation: "transport.secondary" } },
  ]);
});

test.each(["listVolumes", "snapshotVolume"] as const)(
  "%s classifies invalid JSON locally",
  async (member) => {
    const engine = new FakeEngine().fail(member === "listVolumes" ? "volume.list" : "container.wait", {
      status: 201,
      body: `invalid-json-${secret}`,
    });
    const api = engine.api;
    const plane = makeProviderDataPlane({
      providerId: "test",
      redactor,
      capabilities: { volumeSnapshot: "native" },
      pullHelperImage: echoHelperPull(),
      api,
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        member === "listVolumes"
          ? plane.listVolumes({}).pipe(Effect.asVoid)
          : plane.snapshotVolume({ volume }).pipe(Effect.asVoid),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected decode failure");
    expect(failureOutcomeFromCause(exit.cause).error).toMatchObject({
      _tag: "VolumeOperationError",
      operation: member,
    });
    expect(JSON.stringify(taggedErrorJson(failureOutcomeFromCause(exit.cause).error))).not.toContain(secret);
  },
);

test.each([new Uint8Array(1), new Uint8Array(512).fill(120)])(
  "copyFromService classifies malformed tar data locally",
  async (payload) => {
    const engine = new FakeEngine();
    engine.feeds.set("archive.get", Stream.make(payload));
    const plane = makeProviderDataPlane({
      providerId: "test",
      redactor,
      capabilities: { volumeSnapshot: "native" },
      api: engine.api,
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Stream.runDrain(plane.copyFromService(target, { sourcePath: PortablePath.make("/payload") })),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected tar failure");
    expect(failureOutcomeFromCause(exit.cause).error).toMatchObject({
      _tag: "ServiceCopyError",
      operation: "copyFromService",
      cause: expect.any(RangeError),
    });
  },
);
