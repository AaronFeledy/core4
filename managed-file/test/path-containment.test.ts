import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { makeDiskBackend } from "../src/service.ts";
import { targetPath } from "../src/transaction-private-file.ts";
import { fixture, ownerOnlyFileAccess } from "./transaction-fixture.ts";

for (const path of ["..local/missing/file", "."]) {
  test(`allows managed-file target ${path}`, async () => {
    // Given a disk backend and a contained path with missing suffixes or equality
    const { appRoot, dataRoot } = await fixture();
    const backend = await Effect.runPromise(
      makeDiskBackend({
        defaultBase: () => appRoot,
        ledgerRoot: () => dataRoot,
        privateFileAccess: ownerOnlyFileAccess,
      }),
    );
    // When the target is resolved
    const result = await Effect.runPromise(backend.resolveTarget(appRoot, path, "apply"));
    // Then suffixes and the backend's equality allowance are preserved
    expect(result).toBe(join(appRoot, path));
  });
}

test("propagates injected target EACCES as IO without climbing", async () => {
  // Given a successful base lookup and a denied target lookup
  const { appRoot, dataRoot } = await fixture();
  const backend = await Effect.runPromise(
    makeDiskBackend({
      defaultBase: () => appRoot,
      ledgerRoot: () => dataRoot,
      privateFileAccess: ownerOnlyFileAccess,
    }),
  );
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const lookup = spyOn(fs, "realpath").mockResolvedValueOnce(appRoot).mockRejectedValueOnce(denied);
  try {
    // When the managed-file caller resolves the target
    const result = await Effect.runPromise(Effect.result(backend.resolveTarget(appRoot, "file", "apply")));
    // Then it preserves its stricter target-error policy
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("io");
      expect(result.failure.cause).toBe(denied);
    }
    expect(lookup.mock.calls.map(([path]) => path)).toEqual([appRoot, join(appRoot, "file")]);
  } finally {
    lookup.mockRestore();
  }
});

test("keeps the managed-file base fallback separate from target EACCES policy", async () => {
  // Given a denied base lookup followed by missing-target and existing-parent lookups
  const { appRoot, dataRoot } = await fixture();
  const backend = await Effect.runPromise(
    makeDiskBackend({
      defaultBase: () => appRoot,
      ledgerRoot: () => dataRoot,
      privateFileAccess: ownerOnlyFileAccess,
    }),
  );
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const lookup = spyOn(fs, "realpath").mockRejectedValueOnce(denied);
  try {
    // When only the base's realpath fails
    const result = await Effect.runPromise(backend.resolveTarget(appRoot, "missing/file", "apply"));
    // Then the original base remains the comparison root
    expect(result).toBe(join(appRoot, "missing", "file"));
  } finally {
    lookup.mockRestore();
  }
});

test("reconstructs missing suffixes through an in-root symlink", async () => {
  // Given a permitted in-root symlink and an absent descendant
  const { appRoot, dataRoot } = await fixture();
  await fs.mkdir(join(appRoot, "actual"));
  await fs.symlink(join(appRoot, "actual"), join(appRoot, "alias"), "junction");
  const backend = await Effect.runPromise(
    makeDiskBackend({
      defaultBase: () => appRoot,
      ledgerRoot: () => dataRoot,
      privateFileAccess: ownerOnlyFileAccess,
    }),
  );
  // When the managed-file backend resolves that target
  const result = await Effect.runPromise(backend.resolveTarget(appRoot, "alias/missing/file", "apply"));
  // Then containment allows it but returns the authored lexical target
  expect(result).toBe(join(appRoot, "alias", "missing", "file"));
});

for (const code of ["ENOENT", "ENOTDIR"]) {
  test(`climbs past injected target ${code}`, async () => {
    // Given a missing-target lookup and an existing base
    const { appRoot, dataRoot } = await fixture();
    const backend = await Effect.runPromise(
      makeDiskBackend({
        defaultBase: () => appRoot,
        ledgerRoot: () => dataRoot,
        privateFileAccess: ownerOnlyFileAccess,
      }),
    );
    const missing = Object.assign(new Error("missing"), { code });
    const lookup = spyOn(fs, "realpath").mockResolvedValueOnce(appRoot).mockRejectedValueOnce(missing);
    try {
      // When the target callback reports an allowed missing-path error
      const result = await Effect.runPromise(backend.resolveTarget(appRoot, "file", "apply"));
      // Then the caller reconstructs the suffix beneath the existing base
      expect(result).toBe(join(appRoot, "file"));
      expect(lookup.mock.calls.map(([path]) => path)).toEqual([appRoot, join(appRoot, "file"), appRoot]);
    } finally {
      lookup.mockRestore();
    }
  });
}

test("still rejects transaction root equality", async () => {
  // Given a canonical transaction root
  const { appRoot } = await fixture();
  // When the target names that same root
  const result = await targetPath(appRoot, ".").then(
    () => "accepted",
    (error: unknown) => error,
  );
  // Then stricter transaction policy is not replaced by lexical equality allowance
  expect(result).toMatchObject({ reason: "path", phase: "prepare" });
});
