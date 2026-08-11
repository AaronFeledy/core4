import { describe, expect, test } from "bun:test";
import { Effect, type Scope } from "effect";

import { type ManagedFile, PortablePath } from "@lando/sdk/schema";

import { makeTestManagedFileStore } from "./support.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);
const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

const managedFile = (
  overrides: Omit<Partial<ManagedFile>, "path"> & Pick<ManagedFile, "id"> & { readonly path: string },
): ManagedFile => ({
  owner: "package-test",
  mode: "file",
  format: "text",
  content: { kind: "text", value: "hello world\n" },
  ...overrides,
  path: PortablePath.make(overrides.path),
});

describe("ManagedFileService decision algorithm", () => {
  test("creates a managed file then skips unchanged content", async () => {
    // Given
    const store = await run(makeTestManagedFileStore());
    const file = managedFile({ id: "test:greeting", path: "greeting.txt" });

    // When
    const created = await runScoped(store.service.apply([file]));
    const unchanged = await runScoped(store.service.apply([file]));

    // Then
    expect(created.entries[0]?.action).toBe("create");
    expect(store.read("greeting.txt")).toContain("lando-generated:test:greeting");
    expect(store.ledger()).toHaveLength(1);
    expect(unchanged.entries[0]?.action).toBe("skip-unchanged");
  });

  test("updates desired content while the managed file matches its baseline", async () => {
    // Given
    const store = await run(makeTestManagedFileStore());
    const original = managedFile({ id: "test:update", path: "update.txt" });
    await runScoped(store.service.apply([original]));
    const changed = managedFile({
      id: "test:update",
      path: "update.txt",
      content: { kind: "text", value: "new body\n" },
    });

    // When
    const result = await runScoped(store.service.apply([changed]));

    // Then
    expect(result.entries[0]?.action).toBe("update");
    expect(store.read("update.txt")).toContain("new body");
  });

  test("adopts an unmarked user file without clobbering it", async () => {
    // Given
    const store = await run(makeTestManagedFileStore());
    const userContent = "written by the user\n";
    store.seed("user.txt", userContent);
    const file = managedFile({ id: "test:user", path: "user.txt" });

    // When
    const result = await runScoped(store.service.apply([file]));

    // Then
    expect(result.entries[0]?.action).toBe("skip-adopted");
    expect(store.read("user.txt")).toBe(userContent);
    expect(store.ledger()[0]?.state).toBe("adopted");
  });

  test("detects adoption when a user removes an existing ownership marker", async () => {
    // Given
    const store = await run(makeTestManagedFileStore());
    const file = managedFile({ id: "test:adopt", path: "adopt.txt" });
    await runScoped(store.service.apply([file]));
    store.seed("adopt.txt", "user-owned replacement\n");

    // When
    const result = await runScoped(store.service.apply([file]));

    // Then
    expect(result.entries[0]?.action).toBe("adopt-detected");
    expect(store.read("adopt.txt")).toBe("user-owned replacement\n");
    expect(store.ledger()[0]?.state).toBe("adopted");
  });

  test("refuses to clobber drifted managed content", async () => {
    // Given
    const store = await run(makeTestManagedFileStore());
    const file = managedFile({ id: "test:drift", path: "drift.txt" });
    await runScoped(store.service.apply([file]));
    const drifted = `${store.read("drift.txt")}user edit\n`;
    store.seed("drift.txt", drifted);

    // When
    const result = await runScoped(store.service.apply([file]));

    // Then
    expect(result.entries[0]?.action).toBe("conflict");
    expect(store.read("drift.txt")).toBe(drifted);
  });
});
