// allow: SIZE_OK — installer scenarios share this exclusive two-file workstream; fixtures stay local.
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { renderPosixShellenv } from "../../src/cli/commands/shellenv.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const installerPath = resolve(repoRoot, "scripts/install.sh");

const fileUrl = (path: string): string => `file://${path}`;

const makeTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "lando-install-posix-"));

const writeExecutable = async (path: string, content: string): Promise<void> => {
  await writeFile(path, content);
  await chmod(path, 0o755);
};

const sha256 = (bytes: Uint8Array): string => {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  return hash.digest("hex");
};

const createReleaseFixture = async (
  root: string,
  channel = "stable",
  options: {
    readonly binaryScript?: string;
    readonly checksum?: string;
    readonly platform?: "linux-x64" | "darwin-x64";
    readonly sumsPathStyle?: "bare" | "release";
    readonly manifestSignatureStyle?: "gpg" | "cosign";
  } = {},
) => {
  const platform = options.platform ?? "linux-x64";
  const releaseRoot = join(root, "release");
  await mkdir(releaseRoot, { recursive: true });

  const binaryPath = join(releaseRoot, `lando-${platform}`);
  const binary = new TextEncoder().encode(options.binaryScript ?? '#!/bin/sh\necho "lando 4.0.0-test"\n');
  await writeFile(binaryPath, binary);
  await chmod(binaryPath, 0o755);

  const sumsPath = join(releaseRoot, "SHA256SUMS");
  const hash = options.checksum ?? sha256(binary);
  const sumsLine =
    options.sumsPathStyle === "release"
      ? `${hash}  ./dist/lando-${platform}\n`
      : `${hash}  lando-${platform}\n`;
  await writeFile(sumsPath, sumsLine);
  const ascPath = join(releaseRoot, "SHA256SUMS.asc");
  await writeFile(ascPath, "fixture-gpg-signature\n");
  const cosignSigPath = join(releaseRoot, "SHA256SUMS.sig");
  await writeFile(cosignSigPath, "fixture-cosign-signature\n");

  const crtPath = join(releaseRoot, "SHA256SUMS.crt");
  await writeFile(crtPath, "fixture-cosign-certificate\n");

  const signatureUrl = options.manifestSignatureStyle === "gpg" ? fileUrl(ascPath) : fileUrl(cosignSigPath);

  const manifest = {
    channel,
    latest: "4.0.0-test",
    binaries: {
      [platform]: { url: fileUrl(binaryPath), sha256: sha256(binary), size: binary.length },
    },
    checksums: { url: fileUrl(sumsPath), signature: signatureUrl },
  };

  const channelRoot = join(root, "channels");
  await mkdir(channelRoot, { recursive: true });
  const manifestPath = join(channelRoot, `${channel}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  return { ascPath, binaryPath, channelRoot, cosignSigPath, crtPath, manifestPath, sumsPath };
};

const createFakeGpg = async (root: string) => {
  const logPath = join(root, "gpg.log");
  const gpgPath = join(root, "fake-gpg.sh");
  await writeExecutable(
    gpgPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GPG_LOG"\ncase "$*" in *"--import"*) exit 0 ;; *"--homedir"*"--verify"*) exit 0 ;; *) exit 2 ;; esac\n`,
  );
  return { gpgPath, logPath };
};

const HOST_ROOT_OVERRIDES = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_INSTALL_DIR",
  "XDG_DATA_HOME",
] as const;

const hostEnvWithoutLandoRoots = (): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !HOST_ROOT_OVERRIDES.some((override) => override === key)),
  );

const runInstaller = async (
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["sh", installerPath], {
    cwd: repoRoot,
    env: { ...hostEnvWithoutLandoRoots(), HOME: await makeTempRoot(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

describe("scripts/install.sh", () => {
  test.each(["install", "a b$c;d'e\\\"f"])("records an atomic lando4 install in %s", async (directory) => {
    // Given a verified release and an isolated destination.
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, directory);
    const destination = join(installDir, "lando4");
    const env = {
      HOME: root,
      LANDO_INSTALL_DIR: installDir,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    };
    // When installing.
    const result = await runInstaller(env);
    // Then only the owned executable and record are published.
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect((await lstat(destination)).isFile()).toBe(true);
    expect((await lstat(destination)).mode & 0o777).toBe(0o755);
    const bytes = await readFile(fixture.binaryPath);
    expect(await readFile(destination)).toEqual(bytes);
    const recordPath = join(root, "data/install/record.json");
    const { decodeInstallRecord } = await import("@lando/engine/install/record");
    const record = await Effect.runPromise(
      decodeInstallRecord(await readFile(recordPath, "utf8"), recordPath),
    );
    expect(record.data.executable).toMatchObject({
      path: destination,
      sha256: sha256(bytes),
      size: bytes.length,
      channel: "stable",
      platform: "linux-x64",
    });
    expect(record.data.shellProfiles).toEqual([]);
    expect((await lstat(recordPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(installDir)).toEqual(["lando4"]);
    expect(await readdir(join(root, "data/install"))).toEqual(["record.json"]);
    await expect(lstat(join(installDir, "lando"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await runInstaller(env)).exitCode).toBe(0);
    expect(await readFile(destination)).toEqual(bytes);
  });

  test.each(["regular", "symlink"])("preserves preinstalled Lando 3 %s", async (kind) => {
    // Given a hostile Lando 3 executable.
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "bin");
    await mkdir(installDir);
    const legacy = join(installDir, "lando");
    const target = join(root, "legacy-target");
    await writeFile(target, "distinctive Lando 3 bytes", { mode: 0o700 });
    if (kind === "symlink") await symlink(target, legacy);
    else await writeFile(legacy, "distinctive Lando 3 bytes", { mode: 0o700 });
    const before = await lstat(legacy);
    // When installing Lando 4 beside it.
    const result = await runInstaller({
      HOME: root,
      LANDO_INSTALL_DIR: installDir,
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    });
    // Then bytes, mode and link identity survive.
    expect(result.exitCode).toBe(0);
    const after = await lstat(legacy);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.isFile()).toBe(before.isFile());
    expect(after.isSymbolicLink()).toBe(before.isSymbolicLink());
    if (kind === "symlink") expect(await readlink(legacy)).toBe(target);
    expect(await readFile(legacy, "utf8")).toBe("distinctive Lando 3 bytes");
    expect(await readFile(target, "utf8")).toBe("distinctive Lando 3 bytes");
  });

  test.each([
    "owned",
    "no-record",
    "directory",
    "symlink",
    "dangling",
    "digest-drift",
    "size-drift",
    "corrupt",
    "version",
    "wrong-path",
  ])("bounds replacement when destination is %s", async (kind) => {
    // Given a destination with independently seeded ownership evidence.
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "bin");
    await mkdir(installDir);
    const destination = join(installDir, "lando4");
    const target = join(root, "target");
    const bytes = await readFile(fixture.binaryPath);
    await writeFile(target, "untouched target", { mode: 0o700 });
    switch (kind) {
      case "directory":
        await mkdir(destination);
        break;
      case "symlink":
        await symlink(target, destination);
        break;
      case "dangling":
        await symlink(join(root, "missing"), destination);
        break;
      default:
        await writeFile(destination, bytes, { mode: kind === "owned" ? 0o755 : 0o700 });
    }
    const recordPath = join(root, "data/install/record.json");
    if (kind !== "no-record") {
      await mkdir(join(root, "data/install"), { recursive: true });
      await writeFile(
        recordPath,
        kind === "corrupt"
          ? "{broken"
          : JSON.stringify({
              version: kind === "version" ? 2 : 1,
              data: {
                executable: {
                  path: kind === "wrong-path" ? target : destination,
                  sha256: sha256(bytes),
                  size: bytes.length,
                  channel: "stable",
                  platform: "linux-x64",
                },
                shellProfiles: [],
              },
            }),
      );
    }
    if (kind === "digest-drift") await writeFile(destination, Buffer.alloc(bytes.length, 65));
    if (kind === "size-drift") await writeFile(destination, Buffer.concat([bytes, Buffer.from("drift")]));
    const before = await lstat(destination);
    const beforeBytes = before.isFile() ? await readFile(destination) : undefined;
    const beforeLink = before.isSymbolicLink() ? await readlink(destination) : undefined;
    const env = {
      HOME: root,
      LANDO_INSTALL_DIR: installDir,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    };
    // When replacing the destination (twice for the idempotent owned case).
    const result = await runInstaller(env);
    if (kind === "owned") expect((await runInstaller(env)).exitCode).toBe(0);
    // Then only record-owned, unchanged files may be replaced.
    if (kind === "owned") expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    else {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(destination);
      expect(result.stderr).toContain("LANDO_INSTALL_DIR");
    }
    const after = await lstat(destination);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.isDirectory()).toBe(before.isDirectory());
    expect(after.isSymbolicLink()).toBe(before.isSymbolicLink());
    if (beforeBytes) expect(await readFile(destination)).toEqual(beforeBytes);
    if (beforeLink) expect(await readlink(destination)).toBe(beforeLink);
    expect(await readFile(target, "utf8")).toBe("untouched target");
    expect(await readdir(installDir)).toEqual(["lando4"]);
  });
  test("verifies SHA256SUMS.asc with the vendored GPG trust root", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root, "stable", { manifestSignatureStyle: "cosign" });
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const gpgLog = await Bun.file(logPath).text();
    expect(gpgLog).toContain("--verify");
    expect(gpgLog).toContain("SHA256SUMS.asc");
    expect((await lstat(join(installDir, "lando4"))).isFile()).toBe(true);
  });

  test("keeps GPG verification for manifests that explicitly point at an armored signature", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root, "stable", { manifestSignatureStyle: "gpg" });
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const gpgLog = await Bun.file(logPath).text();
    expect(gpgLog).toContain("--homedir");
    expect(gpgLog).toContain("--import");
    expect(gpgLog).toContain("--verify");
    expect((await lstat(join(installDir, "lando4"))).isFile()).toBe(true);
  });

  test("fails closed when the vendored GPG trust root is missing", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root, "stable", { manifestSignatureStyle: "gpg" });
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_GPG_TRUST_ROOT: join(root, "missing-release-key.asc"),
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Missing or malformed vendored GPG trust root");
    await expect(lstat(join(installDir, "lando4"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("matches SHA256SUMS entries that use release-style ./dist/ path prefixes", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root, "stable", { sumsPathStyle: "release" });
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect((await lstat(join(installDir, "lando4"))).isFile()).toBe(true);
  });

  test("installs the verified linux-x64 binary into LANDO_INSTALL_DIR", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install dir with spaces");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${join(installDir, "lando4")}`);
    expect((await lstat(join(installDir, "lando4"))).isFile()).toBe(true);
    expect(await Bun.$`${join(installDir, "lando4")} version`.text()).toContain("lando 4.0.0-test");
    expect(await Bun.file(logPath).text()).toContain("--verify");
    expect(await Bun.file(logPath).text()).toContain("SHA256SUMS.asc");
  });

  test("prints canonical shellenv PATH guidance after install", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const userDataRoot = join(root, "data root with spaces");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_NONINTERACTIVE: "1",
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
      LANDO_USER_DATA_ROOT: userDataRoot,
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Run this command to add lando4 to PATH:");
    expect(result.stdout).toContain(`eval "$('${join(userDataRoot, "bin", "lando4")}' shellenv)"`);
    expect(result.stdout).toContain(renderPosixShellenv(userDataRoot));
  });

  test("runs post-install setup when explicitly opted in", async () => {
    const root = await makeTempRoot();
    const setupLog = join(root, "setup.log");
    const fixture = await createReleaseFixture(root, "stable", {
      binaryScript: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LANDO_SETUP_LOG"\nexit 0\n',
    });
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_RUN_SETUP: "1",
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
      LANDO_SETUP_LOG: setupLog,
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("post-install setup: completed");
    expect(await Bun.file(setupLog).text()).toBe("setup --yes\n");
  });

  test("skips post-install setup in non-interactive mode", async () => {
    const root = await makeTempRoot();
    const setupLog = join(root, "setup.log");
    const fixture = await createReleaseFixture(root, "stable", {
      binaryScript: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LANDO_SETUP_LOG"\nexit 0\n',
    });
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_NONINTERACTIVE: "1",
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
      LANDO_SETUP_LOG: setupLog,
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("post-install setup: skipped");
    await expect(lstat(setupLog)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("resolves stable, next, and dev manifests from the selected channel", async () => {
    const root = await makeTempRoot();
    const fixtures = [];
    for (const channel of ["stable", "next", "dev"] as const) {
      fixtures.push(await createReleaseFixture(root, channel));
    }
    const { gpgPath, logPath } = await createFakeGpg(root);
    const [firstFixture] = fixtures;
    if (firstFixture === undefined) throw new Error("expected at least one release fixture");

    for (const channel of ["stable", "next", "dev"] as const) {
      const installDir = join(root, channel, "install");
      const result = await runInstaller({
        GPG_LOG: logPath,
        LANDO_INSTALL_GPG: gpgPath,
        LANDO_CHANNEL: channel,
        LANDO_INSTALL_BASE_URL: fileUrl(firstFixture.channelRoot),
        LANDO_INSTALL_DIR: installDir,
        LANDO_INSTALL_OS: "Linux",
        LANDO_INSTALL_ARCH: "x86_64",
        LANDO_INSTALL_LIBC: "glibc",
      });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`channel: ${channel}`);
      expect((await lstat(join(installDir, "lando4"))).isFile()).toBe(true);
    }
  });

  test("defaults to the configured user data bin directory when LANDO_INSTALL_DIR is unset", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const userDataRoot = join(root, "custom data root");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
      LANDO_USER_DATA_ROOT: userDataRoot,
    });

    const installedPath = join(userDataRoot, "bin", "lando4");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
  });

  test("ignores hostile Lando 3 config when install env overrides are unset", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const confRoot = join(root, ".lando");
    const userDataRoot = join(root, "from-config-yml");
    await mkdir(confRoot, { recursive: true });
    await writeFile(join(confRoot, "config.yml"), `userDataRoot: ${userDataRoot}\n`);
    await writeFile(join(confRoot, "sibling"), "Lando 3 state", { mode: 0o600 });
    const legacy = await Promise.all(
      (await readdir(confRoot)).map(async (name) => ({
        name,
        bytes: await readFile(join(confRoot, name)),
        mode: (await lstat(join(confRoot, name))).mode & 0o777,
      })),
    );

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      HOME: root,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
      LANDO_USER_CONF_ROOT: confRoot,
    });

    const installedPath = join(root, ".local/share/lando/bin/lando4");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
    for (const entry of legacy) {
      expect(await readFile(join(confRoot, entry.name))).toEqual(entry.bytes);
      expect((await lstat(join(confRoot, entry.name))).mode & 0o777).toBe(entry.mode);
    }
    expect(await readdir(confRoot)).toEqual(legacy.map((entry) => entry.name));
    await expect(lstat(userDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("uses the CLI userDataRoot default on Darwin when config and install env are unset", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root, "stable", { platform: "darwin-x64" });
    const { gpgPath, logPath } = await createFakeGpg(root);

    const result = await runInstaller({
      GPG_LOG: logPath,
      HOME: root,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Darwin",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_USER_CONF_ROOT: join(root, "missing-conf"),
    });

    const installedPath = join(root, "Library/Application Support/Lando/bin/lando4");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
  });

  test("ignores duplicate Lando 3 roots in favor of XDG data home", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const confRoot = join(root, ".lando");
    const firstRoot = join(root, "first-root");
    const finalRoot = join(root, "final-root");
    await mkdir(confRoot, { recursive: true });
    await writeFile(
      join(confRoot, "config.yml"),
      `userDataRoot: ${firstRoot}
nested:
  userDataRoot: ${join(root, "nested-root")}
userDataRoot: ${finalRoot}
`,
    );
    await writeFile(join(confRoot, "sibling"), "legacy duplicate roots", { mode: 0o700 });
    const legacy = await Promise.all(
      (await readdir(confRoot)).map(async (name) => ({
        name,
        bytes: await readFile(join(confRoot, name)),
        mode: (await lstat(join(confRoot, name))).mode & 0o777,
      })),
    );

    const result = await runInstaller({
      GPG_LOG: logPath,
      HOME: root,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
      LANDO_USER_CONF_ROOT: confRoot,
      XDG_DATA_HOME: join(root, "xdg"),
    });

    const installedPath = join(root, "xdg/lando/bin/lando4");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
    for (const entry of legacy) {
      expect(await readFile(join(confRoot, entry.name))).toEqual(entry.bytes);
      expect((await lstat(join(confRoot, entry.name))).mode & 0o777).toBe(entry.mode);
    }
    expect(await readdir(confRoot)).toEqual(legacy.map((entry) => entry.name));
    for (const hostile of [firstRoot, finalRoot, join(root, "nested-root")]) {
      await expect(lstat(hostile)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("leaves non-string Lando 3 config and siblings untouched", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const confRoot = join(root, ".lando");
    await mkdir(confRoot, { recursive: true });
    await writeFile(
      join(confRoot, "config.yml"),
      `userDataRoot:
  nested: ${join(root, "hostile")}
`,
    );
    await writeFile(join(confRoot, "sibling"), "legacy non-string root", { mode: 0o600 });
    const legacy = await Promise.all(
      (await readdir(confRoot)).map(async (name) => ({
        name,
        bytes: await readFile(join(confRoot, name)),
        mode: (await lstat(join(confRoot, name))).mode & 0o777,
      })),
    );

    const result = await runInstaller({
      GPG_LOG: logPath,
      HOME: root,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
      LANDO_USER_CONF_ROOT: confRoot,
    });

    const installedPath = join(root, ".local/share/lando/bin/lando4");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
    for (const entry of legacy) {
      expect(await readFile(join(confRoot, entry.name))).toEqual(entry.bytes);
      expect((await lstat(join(confRoot, entry.name))).mode & 0o777).toBe(entry.mode);
    }
    expect(await readdir(confRoot)).toEqual(legacy.map((entry) => entry.name));
    await expect(lstat(join(root, "hostile"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("maps Darwin x64 and verifies checksums with the portable shasum path", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root, "stable", { platform: "darwin-x64" });
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Darwin",
      LANDO_INSTALL_ARCH: "x86_64",
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("platform: darwin-x64");
    expect((await lstat(join(installDir, "lando4"))).isFile()).toBe(true);
  });

  test("fails closed when signature verification fails", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const gpgPath = join(root, "failing-gpg.sh");
    await writeExecutable(gpgPath, '#!/bin/sh\ncase "$*" in *"--import"*) exit 0 ;; *) exit 1 ;; esac\n');
    const installDir = join(root, "install");

    const result = await runInstaller({
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Signature verification failed");
    await expect(lstat(join(installDir, "lando4"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed when the downloaded binary does not match SHA256SUMS", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root, "stable", { checksum: "0".repeat(64) });
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Checksum mismatch");
    await expect(lstat(join(installDir, "lando4"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects unsupported POSIX platform constraints before installing", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_GPG: gpgPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "musl",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsupported Linux libc");
    await expect(lstat(join(installDir, "lando4"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
