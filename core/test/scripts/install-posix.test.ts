import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

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

const runInstaller = async (
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["sh", installerPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(true);
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
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(true);
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
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(false);
    expect(await Bun.file(logPath).exists()).toBe(false);
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
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(true);
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
    expect(result.stdout).toContain(`installed: ${join(installDir, "lando")}`);
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(true);
    expect(await Bun.$`${join(installDir, "lando")} version`.text()).toContain("lando 4.0.0-test");
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
    expect(result.stdout).toContain("Run this command to add Lando to PATH:");
    expect(result.stdout).toContain(`eval "$(\"${join(userDataRoot, "bin", "lando")}\" shellenv)"`);
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
    expect(await Bun.file(setupLog).exists()).toBe(false);
  });

  test("resolves stable, next, and dev manifests from the selected channel", async () => {
    const root = await makeTempRoot();
    const fixtures = [];
    for (const channel of ["stable", "next", "dev"] as const) {
      fixtures.push(await createReleaseFixture(root, channel));
    }
    const { gpgPath, logPath } = await createFakeGpg(root);

    for (const channel of ["stable", "next", "dev"] as const) {
      const installDir = join(root, channel, "install");
      const result = await runInstaller({
        GPG_LOG: logPath,
        LANDO_INSTALL_GPG: gpgPath,
        LANDO_CHANNEL: channel,
        LANDO_INSTALL_BASE_URL: fileUrl(fixtures[0].channelRoot),
        LANDO_INSTALL_DIR: installDir,
        LANDO_INSTALL_OS: "Linux",
        LANDO_INSTALL_ARCH: "x86_64",
        LANDO_INSTALL_LIBC: "glibc",
      });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`channel: ${channel}`);
      expect(await Bun.file(join(installDir, "lando")).exists()).toBe(true);
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

    const installedPath = join(userDataRoot, "bin", "lando");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
  });

  test("reads userDataRoot from config.yml when install env overrides are unset", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const confRoot = join(root, "conf");
    const userDataRoot = join(root, "from-config-yml");
    await mkdir(confRoot, { recursive: true });
    await writeFile(join(confRoot, "config.yml"), `userDataRoot: ${userDataRoot}\n`);

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

    const installedPath = join(userDataRoot, "bin", "lando");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
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

    const installedPath = join(root, ".local/share/lando/bin/lando");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
  });

  test("matches minimal config parsing by using the last top-level string userDataRoot", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const confRoot = join(root, "conf");
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

    const installedPath = join(finalRoot, "bin", "lando");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
  });

  test("falls back when config userDataRoot resolves to a non-string YAML value", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const confRoot = join(root, "conf");
    await mkdir(confRoot, { recursive: true });
    await writeFile(
      join(confRoot, "config.yml"),
      `userDataRoot:
  nested: value
`,
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

    const installedPath = join(root, ".local/share/lando/bin/lando");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
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
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(true);
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
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(false);
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
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(false);
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
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(false);
    expect(await Bun.file(logPath).exists()).toBe(false);
  });
});
