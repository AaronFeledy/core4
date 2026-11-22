import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { databaseAdminSeedPath } from "@lando/paths";
import { Effect, Redacted } from "effect";
import { deriveDatabaseAdminPassword } from "../src/database-admin-seed.ts";
import { PrivateFileAccessService } from "../src/private-file-access.ts";

const generation = "b4edd6d7-8640-4b39-a81b-f93f9e01e7d2";
const derive = (
  userDataRoot: string,
  overrides: Partial<Parameters<typeof deriveDatabaseAdminPassword<never>>[0]> = {},
) =>
  deriveDatabaseAdminPassword({
    userDataRoot,
    generation,
    family: "mssql",
    register: () => Effect.void,
    ...overrides,
  });

test.skipIf(process.platform === "win32")(
  "concurrent callers publish one private seed and derive the same password",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-db-seed-"));
    try {
      const derived = await Effect.runPromise(
        Effect.all(
          Array.from({ length: 5 }, () => derive(root)),
          {
            concurrency: "unbounded",
          },
        ).pipe(Effect.provide(PrivateFileAccessService.layer)),
      );
      const password = derived.map(Redacted.value);
      const file = databaseAdminSeedPath(root);
      expect(new Set(password).size).toBe(1);
      expect(password[0]).toMatch(/^L1a![A-Za-z0-9_-]{43}$/u);
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(file))).mode & 0o777).toBe(0o700);
      expect(await readdir(dirname(file))).toEqual(["key.v1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "read-only derivation never initializes a missing seed",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-db-seed-"));
    try {
      const derived = await Effect.runPromiseExit(
        derive(root, { mode: "read" }).pipe(Effect.provide(PrivateFileAccessService.layer)),
      );
      expect(derived._tag).toBe("Failure");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "derives the versioned password and registers the seed encodings before returning",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-db-seed-"));
    try {
      const file = databaseAdminSeedPath(root);
      const seed = Buffer.alloc(32, 42);
      await mkdir(dirname(file), { mode: 0o700 });
      await writeFile(file, `${seed.toString("base64url")}\n`, { mode: 0o600 });
      const registrations: string[][] = [];
      const [first, otherFamily, otherGeneration] = await Effect.runPromise(
        Effect.all([
          derive(root, {
            mode: "read",
            register: (values) =>
              Effect.sync(() => {
                registrations.push([...values]);
              }),
          }),
          derive(root, { family: "mongodb" }),
          derive(root, { generation: "aacdb8e8-fe33-4b58-9b3b-734f934e4e7e" }),
        ]).pipe(Effect.provide(PrivateFileAccessService.layer)),
      );
      const password = Redacted.value(first);
      expect(password).toBe("L1a!nWwagrMnuBV9xS57WcOdYb0e_drcRpP5u4t7tZbq6EA");
      expect(new Set([password, Redacted.value(otherFamily), Redacted.value(otherGeneration)]).size).toBe(3);
      expect(registrations).toEqual([
        [seed.toString("base64url"), seed.toString("base64"), seed.toString("hex"), password],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test
  .skipIf(process.platform === "win32")
  .each(["malformed", "open-mode", "linked-file", "linked-directory", "directory"] as const)(
  "refuses %s seed storage without overwriting it",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-db-seed-"));
    try {
      const file = databaseAdminSeedPath(root);
      const directory = dirname(file);
      const elsewhere = join(root, "elsewhere");
      const content = kind === "malformed" ? "not a seed\n" : `${Buffer.alloc(32).toString("base64url")}\n`;
      if (kind === "linked-directory") {
        await mkdir(elsewhere, { mode: 0o700 });
        await symlink(elsewhere, directory, "dir");
        await writeFile(file, content, { mode: 0o600 });
      } else {
        await mkdir(directory, { mode: 0o700 });
        if (kind === "directory") await mkdir(file, { mode: 0o700 });
        else if (kind === "linked-file") {
          await writeFile(elsewhere, content, { mode: 0o600 });
          await symlink(elsewhere, file);
        } else {
          await writeFile(file, content, { mode: 0o600 });
          if (kind === "open-mode") await chmod(file, 0o644);
        }
      }
      const before = await lstat(kind === "linked-directory" ? directory : file);
      await expect(
        Effect.runPromise(derive(root).pipe(Effect.provide(PrivateFileAccessService.layer))),
      ).rejects.toMatchObject({
        _tag: "StateStoreError",
        operation: "database admin seed",
      });
      const after = await lstat(kind === "linked-directory" ? directory : file);
      expect({ dev: after.dev, ino: after.ino, mode: after.mode }).toEqual({
        dev: before.dev,
        ino: before.ino,
        mode: before.mode,
      });
      if (kind !== "directory") expect(await readFile(file, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each([
  { mode: 0o775, accepted: true },
  { mode: 0o777, accepted: false },
])("a data root with mode $mode is accepted: $accepted", async ({ mode, accepted }) => {
  // A umask-0002 host creates the data root group-writable; only a world-writable root is unsafe.
  const parent = await mkdtemp(join(tmpdir(), "lando-db-seed-"));
  const root = join(parent, "data");
  try {
    await mkdir(root);
    await chmod(root, mode);
    const exit = await Effect.runPromiseExit(
      derive(root).pipe(Effect.provide(PrivateFileAccessService.layer)),
    );
    expect(exit._tag).toBe(accepted ? "Success" : "Failure");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
