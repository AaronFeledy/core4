import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

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
    readonly checksum?: string;
    readonly platform?: "linux-x64" | "darwin-x64";
    readonly sumsPathStyle?: "bare" | "release";
  } = {},
) => {
  const platform = options.platform ?? "linux-x64";
  const releaseRoot = join(root, "release");
  await mkdir(releaseRoot, { recursive: true });

  const binaryPath = join(releaseRoot, `lando-${platform}`);
  const binary = new TextEncoder().encode('#!/bin/sh\necho "lando 4.0.0-test"\n');
  await writeFile(binaryPath, binary);
  await chmod(binaryPath, 0o755);

  const sumsPath = join(releaseRoot, "SHA256SUMS");
  const hash = options.checksum ?? sha256(binary);
  const sumsLine =
    options.sumsPathStyle === "release"
      ? `${hash}  ./dist/lando-${platform}\n`
      : `${hash}  lando-${platform}\n`;
  await writeFile(sumsPath, sumsLine);
  const sigPath = join(releaseRoot, "SHA256SUMS.asc");
  await writeFile(sigPath, "fixture-signature\n");

  const manifest = {
    channel,
    latest: "4.0.0-test",
    binaries: {
      [platform]: { url: fileUrl(binaryPath), sha256: sha256(binary), size: binary.length },
    },
    checksums: { url: fileUrl(sumsPath), signature: fileUrl(sigPath) },
  };

  const channelRoot = join(root, "channels");
  await mkdir(channelRoot, { recursive: true });
  const manifestPath = join(channelRoot, `${channel}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  return { binaryPath, channelRoot, manifestPath, sumsPath, sigPath };
};

const createFakeGpg = async (root: string) => {
  const logPath = join(root, "gpg.log");
  const gpgPath = join(root, "fake-gpg.sh");
  await writeExecutable(
    gpgPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" > "$GPG_LOG"\ncase "$*" in *"--verify"*) exit 0 ;; *) exit 2 ;; esac\n`,
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
  test("matches SHA256SUMS entries that use release-style ./dist/ path prefixes", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root, "stable", { sumsPathStyle: "release" });
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
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(true);
  });

  test("installs the verified linux-x64 binary into LANDO_INSTALL_DIR", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install dir with spaces");

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
    expect(result.stdout).toContain(`installed: ${join(installDir, "lando")}`);
    expect(await Bun.file(join(installDir, "lando")).exists()).toBe(true);
    expect(await Bun.$`${join(installDir, "lando")} version`.text()).toContain("lando 4.0.0-test");
    expect(await Bun.file(logPath).text()).toContain("--verify");
    expect(await Bun.file(logPath).text()).toContain("SHA256SUMS.asc");
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
        LANDO_CHANNEL: channel,
        LANDO_INSTALL_BASE_URL: fileUrl(fixtures[0].channelRoot),
        LANDO_INSTALL_DIR: installDir,
        LANDO_INSTALL_GPG: gpgPath,
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
      HOME: root,
      LANDO_INSTALL_GPG: gpgPath,
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

  test("maps Darwin x64 and verifies checksums with the portable shasum path", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root, "stable", { platform: "darwin-x64" });
    const { gpgPath, logPath } = await createFakeGpg(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      GPG_LOG: logPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_GPG: gpgPath,
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
    await writeExecutable(gpgPath, "#!/bin/sh\nexit 1\n");
    const installDir = join(root, "install");

    const result = await runInstaller({
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_GPG: gpgPath,
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
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_GPG: gpgPath,
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
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_GPG: gpgPath,
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
