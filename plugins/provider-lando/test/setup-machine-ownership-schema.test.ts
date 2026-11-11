import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import { persistSetupState, providerStatePath, setupProviderLando } from "../src/setup.ts";
import { RecordedMachineOwnership } from "../src/setup-machine-ownership.ts";

test.each([
  { name: "lando", createdByLando: false },
  { name: "lando", createdByLando: true },
  { name: "lando", createdByLando: true, createdAt: "2026-09-22T12:00:00Z" },
])("decodes and encodes valid machine proof %j", (raw) => {
  const decoded = Schema.decodeUnknownSync(RecordedMachineOwnership)(raw);
  expect(Schema.encodeSync(RecordedMachineOwnership)(decoded)).toEqual(raw);
});

test.each(
  [
    null,
    [],
    "lando",
    {},
    { name: "lando", createdByLando: true, createdAt: "" },
    { name: "lando", createdByLando: true, createdAt: 42 },
    { name: "lando", createdByLando: "true", createdAt: "created" },
    { name: "other", createdByLando: true, createdAt: "created" },
    { name: "lando", createdByLando: false, createdAt: "created" },
  ].map((raw) => ({ raw })),
)("rejects legacy or contradictory machine proof %j", ({ raw }) => {
  expect(Result.isFailure(Schema.decodeUnknownResult(RecordedMachineOwnership)(raw))).toBe(true);
});

test.each([
  // A legacy record without a generation stays untrusted and is kept for uninstall review.
  { machine: { name: "lando", createdByLando: true }, persisted: { name: "lando", createdByLando: true } },
  {
    machine: { name: "lando", createdByLando: "true", createdAt: "created" },
    persisted: { name: "lando", createdByLando: false },
  },
])(
  "setup never imports trust or activates a socket from unverified proof %j",
  async ({ machine, persisted }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-untrusted-machine-"));
    try {
      await mkdir(join(root, "provider-lando"));
      await writeFile(providerStatePath(root), JSON.stringify({ machine }));
      const actions: string[] = [];
      await Effect.runPromise(
        setupProviderLando({
          platform: "win32",
          stateDir: root,
          skipSocketProbe: true,
          podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
          podmanMachine: {
            inspect: Effect.succeed("stopped"),
            createdAt: Effect.succeed("created"),
            create: Effect.void,
            stop: Effect.void,
            upgrade: Effect.void,
            teardown: Effect.void,
            start: Effect.sync(() => {
              actions.push("start");
            }),
            syncTrust: Effect.sync(() => {
              actions.push("trust");
            }),
            activateApiSocket: Effect.sync(() => {
              actions.push("socket");
            }),
          },
        }),
      );
      expect(actions).toEqual(["start"]);
      const state: unknown = JSON.parse(await readFile(providerStatePath(root), "utf8"));
      expect(state).toMatchObject({ machine: persisted });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("setup writer rejects an empty creation proof without replacing prior state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-invalid-proof-"));
  try {
    await mkdir(join(root, "provider-lando"));
    const prior = JSON.stringify({ podmanVersion: "6.0.2" });
    await writeFile(providerStatePath(root), prior);
    const result = await Effect.runPromise(
      Effect.result(
        persistSetupState(root, {
          podmanVersion: "6.0.2",
          machine: { name: "lando", createdByLando: true, createdAt: "" },
        }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(await readFile(providerStatePath(root), "utf8")).toBe(prior);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
