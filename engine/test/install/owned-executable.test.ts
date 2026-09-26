import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";

import {
  type InstallOwnershipError,
  isLando4ExecutableName,
  refreshInstallRecord,
  resolveOwnedExecutable,
} from "@lando/engine/install/owned-executable";
import { decodeInstallRecord } from "@lando/engine/install/record";

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-owned-exec-"));
  roots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(roots.map((root) => Bun.$`rm -rf ${root}`.quiet().nothrow()));
});

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

interface Seed {
  readonly root: string;
  readonly recordFile: string;
  readonly executablePath: string;
  readonly bytes: string;
}

const seed = async (
  options: {
    readonly executableName?: string;
    readonly bytes?: string;
    readonly recordOverrides?: Record<string, unknown>;
    readonly writeExecutable?: boolean;
  } = {},
): Promise<Seed> => {
  const root = await makeRoot();
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const executablePath = join(binDir, options.executableName ?? "lando4");
  const bytes = options.bytes ?? "lando4-binary";
  if (options.writeExecutable !== false) {
    await writeFile(executablePath, bytes);
    await chmod(executablePath, 0o755);
  }
  const recordFile = join(root, "install", "record.json");
  await mkdir(join(root, "install"), { recursive: true });
  await writeFile(
    recordFile,
    JSON.stringify({
      version: 1,
      data: {
        executable: {
          path: executablePath,
          sha256: sha256(bytes),
          size: Buffer.byteLength(bytes),
          channel: "stable",
          platform: "linux-x64",
          releaseVersion: "4.2.0",
          ...(options.recordOverrides ?? {}),
        },
        shellProfiles: [{ path: join(root, ".bashrc"), blockSha256: "a".repeat(64) }],
      },
    }),
    { mode: 0o600 },
  );
  return { root, recordFile, executablePath, bytes };
};

const refusal = async (
  effect: Effect.Effect<unknown, InstallOwnershipError>,
): Promise<InstallOwnershipError> => {
  const outcome = await Effect.runPromise(Effect.either(effect));
  if (Either.isRight(outcome)) throw new Error("expected an ownership refusal");
  return outcome.left;
};

describe("lando4 executable name rule", () => {
  test("accepts only the exact v4 basename per platform", () => {
    expect(isLando4ExecutableName("/usr/local/bin/lando4", "linux")).toBe(true);
    expect(isLando4ExecutableName("/usr/local/bin/lando", "linux")).toBe(false);
    expect(isLando4ExecutableName("/usr/local/bin/lando4.exe", "linux")).toBe(false);
    expect(isLando4ExecutableName("/usr/local/bin/lando4-old", "linux")).toBe(false);
    expect(isLando4ExecutableName("C:\\lando\\lando4.exe", "win32")).toBe(true);
    expect(isLando4ExecutableName("C:\\lando\\LANDO4.EXE", "win32")).toBe(true);
    expect(isLando4ExecutableName("C:\\lando\\lando4", "win32")).toBe(false);
    expect(isLando4ExecutableName("C:\\lando\\lando.exe", "win32")).toBe(false);
  });
});

describe("resolveOwnedExecutable", () => {
  test("resolves the recorded executable when the record proves ownership", async () => {
    const fixture = await seed();
    const owned = await Effect.runPromise(
      resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }),
    );
    expect(owned.path).toBe(fixture.executablePath);
    expect(owned.sha256).toBe(sha256(fixture.bytes));
    expect(owned.size).toBe(Buffer.byteLength(fixture.bytes));
    expect(owned.record.data.executable.channel).toBe("stable");
  });

  test("refuses when no install record exists", async () => {
    const root = await makeRoot();
    const error = await refusal(
      resolveOwnedExecutable({ recordFile: join(root, "install", "record.json"), platform: "linux" }),
    );
    expect(error._tag).toBe("InstallOwnershipError");
    expect(error.reason).toBe("no-record");
    expect(error.remediation.length).toBeGreaterThan(0);
  });

  test("refuses a record that is not valid version 1 JSON", async () => {
    const fixture = await seed();
    await writeFile(fixture.recordFile, "{not json");
    expect(
      (await refusal(resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }))).reason,
    ).toBe("record-invalid");
  });

  test("refuses a record whose executable entry names a foreign basename", async () => {
    const fixture = await seed({ executableName: "lando" });
    const error = await refusal(
      resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }),
    );
    expect(error.reason).toBe("foreign-basename");
    expect(error.destination).toBe(fixture.executablePath);
    expect(await readFile(fixture.executablePath, "utf8")).toBe(fixture.bytes);
  });

  test("refuses when the recorded executable digest drifted", async () => {
    const fixture = await seed();
    await writeFile(fixture.executablePath, "tampered-binary-of-the-same-length!");
    expect(
      (await refusal(resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }))).reason,
    ).toBe("digest-mismatch");
  });

  test("refuses when the recorded size no longer matches", async () => {
    const fixture = await seed();
    await writeFile(
      fixture.recordFile,
      (await readFile(fixture.recordFile, "utf8")).replace(/"size":\s*\d+/u, '"size": 999999'),
    );
    expect(
      (await refusal(resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }))).reason,
    ).toBe("size-mismatch");
  });

  test("refuses a symlinked destination", async () => {
    const fixture = await seed({ writeExecutable: false });
    const real = join(fixture.root, "bin", "real-binary");
    await writeFile(real, fixture.bytes);
    await symlink(real, fixture.executablePath);
    expect(
      (await refusal(resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }))).reason,
    ).toBe("not-regular-file");
  });

  test("refuses when the recorded executable is missing", async () => {
    const fixture = await seed({ writeExecutable: false });
    expect(
      (await refusal(resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }))).reason,
    ).toBe("destination-unreadable");
  });

  test("refuses a destination that is not the recorded path", async () => {
    const fixture = await seed();
    const error = await refusal(
      resolveOwnedExecutable({
        recordFile: fixture.recordFile,
        platform: "linux",
        destination: join(fixture.root, "bin", "lando"),
      }),
    );
    expect(error.reason).toBe("path-mismatch");
  });

  test("accepts a destination that resolves to the recorded path", async () => {
    const fixture = await seed();
    const owned = await Effect.runPromise(
      resolveOwnedExecutable({
        recordFile: fixture.recordFile,
        platform: "linux",
        destination: join(fixture.root, "bin", ".", "lando4"),
      }),
    );
    expect(owned.path).toBe(fixture.executablePath);
  });
});

describe("refreshInstallRecord", () => {
  test("rewrites only the executable digest, size, and release version", async () => {
    const fixture = await seed();
    const owned = await Effect.runPromise(
      resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }),
    );
    const replacement = "a-brand-new-lando4-binary";
    await writeFile(fixture.executablePath, replacement);
    await Effect.runPromise(
      refreshInstallRecord({
        recordFile: fixture.recordFile,
        record: owned.record,
        sha256: sha256(replacement),
        size: Buffer.byteLength(replacement),
        releaseVersion: "4.3.0",
      }),
    );

    const refreshed = await Effect.runPromise(
      decodeInstallRecord(await readFile(fixture.recordFile, "utf8"), fixture.recordFile),
    );
    expect(refreshed.data.executable.sha256).toBe(sha256(replacement));
    expect(refreshed.data.executable.size).toBe(Buffer.byteLength(replacement));
    expect(refreshed.data.executable.releaseVersion).toBe("4.3.0");
    expect(refreshed.data.executable.path).toBe(fixture.executablePath);
    expect(refreshed.data.executable.channel).toBe("stable");
    expect(refreshed.data.executable.platform).toBe("linux-x64");
    expect(refreshed.data.shellProfiles).toEqual(owned.record.data.shellProfiles);

    const stat = await Bun.file(fixture.recordFile).stat();
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("a refreshed record proves ownership of the replaced binary", async () => {
    const fixture = await seed();
    const owned = await Effect.runPromise(
      resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }),
    );
    const replacement = "the-replacement-binary";
    await writeFile(fixture.executablePath, replacement);
    await Effect.runPromise(
      refreshInstallRecord({
        recordFile: fixture.recordFile,
        record: owned.record,
        sha256: sha256(replacement),
        size: Buffer.byteLength(replacement),
        releaseVersion: "4.3.0",
      }),
    );
    const reowned = await Effect.runPromise(
      resolveOwnedExecutable({ recordFile: fixture.recordFile, platform: "linux" }),
    );
    expect(reowned.sha256).toBe(sha256(replacement));
  });
});
