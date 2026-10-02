import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Either, Option, Schema } from "effect";
import {
  InstallRecord,
  decodeInstallRecord,
  installRecordOwnsDestination,
  readInstallRecord,
  verifyInstallRecordOwnership,
} from "../../src/install/record.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

const digest = "a".repeat(64);
const executable = {
  path: resolve("lando4"),
  sha256: digest,
  size: 4,
  channel: "dev",
  platform: "linux-x64",
};
const record = {
  version: 1,
  data: { executable, shellProfiles: [{ path: "/home/test/.profile", blockSha256: digest }] },
} as const;
const regular = { isFile: true, isSymbolicLink: false, isDirectory: false, size: 4 };

describe("install record decoding", () => {
  test.each([undefined, "4.0.0-dev.1"])("accepts canonical v1 with releaseVersion %s", (releaseVersion) => {
    // Given
    const input = {
      ...record,
      data: {
        ...record.data,
        executable: { ...executable, ...(releaseVersion === undefined ? {} : { releaseVersion }) },
      },
    };
    // When
    const result = Effect.runSync(decodeInstallRecord(JSON.stringify(input), "record.json"));
    // Then
    expect(result).toEqual(input);
    expect(Schema.is(InstallRecord)(result)).toBe(true);
  });

  const cases = [
    { name: "future version", value: { ...record, version: 2 }, reason: "unsupported-version" },
    {
      name: "missing digest",
      value: { ...record, data: { ...record.data, executable: { ...executable, sha256: undefined } } },
      reason: "schema",
    },
    ...["bad", "A".repeat(64), "g".repeat(64)].map((sha256) => ({
      name: `digest ${sha256}`,
      value: { ...record, data: { ...record.data, executable: { ...executable, sha256 } } },
      reason: "schema",
    })),
    ...[-1, 1.5].map((size) => ({
      name: `size ${size}`,
      value: { ...record, data: { ...record.data, executable: { ...executable, size } } },
      reason: "schema",
    })),
    {
      name: "bad block digest",
      value: {
        ...record,
        data: { ...record.data, shellProfiles: [{ path: ".profile", blockSha256: "bad" }] },
      },
      reason: "schema",
    },
    { name: "missing version", value: { data: record.data }, reason: "schema" },
    { name: "null", value: null, reason: "schema" },
  ];
  test.each(cases)("rejects $name", ({ value, reason }) => {
    // Given / When
    const result = Effect.runSync(Effect.either(decodeInstallRecord(JSON.stringify(value), "record.json")));
    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result))
      expect(result.left).toMatchObject({ _tag: "InstallRecordError", reason, file: "record.json" });
  });
  test("rejects non-JSON text", () => {
    // Given / When
    const result = Effect.runSync(Effect.either(decodeInstallRecord("not json", "record.json")));
    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result))
      expect(result.left).toMatchObject({ _tag: "InstallRecordError", reason: "invalid-json" });
  });
});

describe("destination ownership", () => {
  test.each([executable.path, resolve("subdir", "..", "lando4")])(
    "owns matching resolved path %s",
    (destination) => {
      // Given / When
      const result = installRecordOwnsDestination(record, destination, regular, digest);
      // Then
      expect(result).toEqual({ owned: true });
    },
  );
  test.each([
    {
      name: "different path",
      destination: resolve("other"),
      stat: regular,
      hash: digest,
      reason: "path-mismatch",
    },
    {
      name: "parent-relative different path",
      destination: "../lando4",
      stat: regular,
      hash: digest,
      reason: "path-mismatch",
    },
    {
      name: "symlink",
      destination: executable.path,
      stat: { ...regular, isSymbolicLink: true },
      hash: digest,
      reason: "not-regular-file",
    },
    {
      name: "directory",
      destination: executable.path,
      stat: { ...regular, isDirectory: true },
      hash: digest,
      reason: "not-regular-file",
    },
    {
      name: "special file",
      destination: executable.path,
      stat: { ...regular, isFile: false },
      hash: digest,
      reason: "not-regular-file",
    },
    {
      name: "digest drift",
      destination: executable.path,
      stat: regular,
      hash: "b".repeat(64),
      reason: "digest-mismatch",
    },
    {
      name: "size drift",
      destination: executable.path,
      stat: { ...regular, size: 5 },
      hash: digest,
      reason: "size-mismatch",
    },
  ])("rejects $name", ({ destination, stat, hash, reason }) => {
    // Given / When
    const result = installRecordOwnsDestination(record, destination, stat, hash);
    // Then
    expect(result).toEqual({ owned: false, reason });
  });
});

describe("install record filesystem integration", () => {
  test.each(["absent", "regular", "symlink", "directory", "corrupt"] as const)(
    "reads %s record",
    async (kind) => {
      // Given
      const root = await mkdtemp(join(tmpdir(), "lando-install-record-"));
      try {
        const file = join(root, "record.json");
        switch (kind) {
          case "absent":
            break;
          case "regular":
            await writeFile(file, JSON.stringify(record));
            break;
          case "symlink":
            await symlink(join(root, "missing-target"), file);
            break;
          case "directory":
            await mkdir(file);
            break;
          case "corrupt":
            await writeFile(file, "{");
            break;
        }
        // When
        const result = await Effect.runPromise(
          readInstallRecord(file).pipe(Effect.either, Effect.provide(FileSystemLive)),
        );
        // Then
        if (kind === "absent" || kind === "regular") {
          expect(result).toEqual(Either.right(kind === "absent" ? Option.none() : Option.some(record)));
        } else {
          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result))
            expect(result.left).toMatchObject({
              _tag: "InstallRecordError",
              reason: kind === "corrupt" ? "invalid-json" : "not-regular-file",
            });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["owned", "no-record", "symlink", "directory", "digest-mismatch", "size-mismatch"] as const)(
    "verifies %s destination",
    async (kind) => {
      // Given
      const root = await mkdtemp(join(tmpdir(), "lando-install-ownership-"));
      try {
        const file = join(root, "record.json");
        const destination = join(root, "lando4");
        const bytes = "lando";
        const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        const input = {
          ...record,
          data: {
            ...record.data,
            executable: { ...executable, path: destination, sha256, size: kind === "size-mismatch" ? 6 : 5 },
          },
        };
        if (kind !== "no-record") await writeFile(file, JSON.stringify(input));
        if (kind === "symlink") await symlink(join(root, "absent"), destination);
        else if (kind === "directory") await mkdir(destination);
        else if (kind !== "no-record")
          await writeFile(destination, kind === "digest-mismatch" ? "drift" : bytes);
        // When
        const result = await Effect.runPromise(
          verifyInstallRecordOwnership(file, destination).pipe(Effect.provide(FileSystemLive)),
        );
        // Then
        expect(result).toEqual(
          kind === "owned"
            ? { owned: true }
            : {
                owned: false,
                reason: kind === "symlink" || kind === "directory" ? "not-regular-file" : kind,
              },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
