import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

import { renderPowerShellShellenv } from "../../src/cli/commands/shellenv.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const installerPath = resolve(repoRoot, "scripts/install.ps1");
const powershellTestTimeoutMs = 60_000;

const powershellTest = (name: string, fn: () => void | Promise<void>): void => {
  test(name, fn, powershellTestTimeoutMs);
};

const fileUrl = (path: string): string => pathToFileURL(path).href;

const makeTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "lando-install-windows-"));

const sha256 = (bytes: Uint8Array): string => {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  return hash.digest("hex");
};

const createReleaseFixture = async (
  root: string,
  channel = "stable",
  options: { readonly binaryScript?: string; readonly checksum?: string } = {},
) => {
  const releaseRoot = join(root, "release");
  await mkdir(releaseRoot, { recursive: true });

  const binaryPath = join(releaseRoot, "lando-windows-x64.exe");
  const binary = new TextEncoder().encode(options.binaryScript ?? "lando windows fixture\n");
  await writeFile(binaryPath, binary);
  await chmod(binaryPath, 0o755);

  const sumsPath = join(releaseRoot, "SHA256SUMS");
  const hash = options.checksum ?? sha256(binary);
  await writeFile(sumsPath, `${hash}  ./dist/lando-windows-x64.exe\n`);

  const sigPath = join(releaseRoot, "SHA256SUMS.sig");
  await writeFile(sigPath, "fixture-cosign-signature\n");
  const crtPath = join(releaseRoot, "SHA256SUMS.crt");
  await writeFile(crtPath, "fixture-cosign-certificate\n");

  const manifest = {
    channel,
    latest: "4.0.0-test",
    binaries: {
      "windows-x64": { url: fileUrl(binaryPath), sha256: sha256(binary), size: binary.length },
    },
    checksums: { url: fileUrl(sumsPath), signature: fileUrl(sigPath) },
  };

  const channelRoot = join(root, "channels");
  await mkdir(channelRoot, { recursive: true });
  const manifestPath = join(channelRoot, `${channel}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  return { binaryPath, channelRoot, crtPath, manifestPath, sigPath, sumsPath };
};

const createFakeCosign = async (root: string, exitCode = 0) => {
  const logPath = join(root, "cosign.log");
  const cosignPath = join(root, "fake-cosign.ps1");
  await writeFile(
    cosignPath,
    `$ErrorActionPreference = "Stop"\nif ($env:COSIGN_LOG) { Set-Content -LiteralPath $env:COSIGN_LOG -Value ($args -join " ") }\nexit ${exitCode}\n`,
  );
  await chmod(cosignPath, 0o755);
  return { cosignPath, logPath };
};

const writeCosignTrustRoot = async (
  root: string,
  trustRoot: { readonly certificateIdentityRegexp: string; readonly certificateOidcIssuer: string },
): Promise<string> => {
  const trustRootPath = join(root, "cosign-trust-root.json");
  await writeFile(trustRootPath, `${JSON.stringify(trustRoot)}\n`);
  return trustRootPath;
};

const runInstaller = async (
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath], {
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

describe("scripts/install.ps1", () => {
  powershellTest("installs the verified windows-x64 binary into LANDO_INSTALL_DIR", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const installDir = join(root, "install dir with spaces");

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("platform: windows-x64");
    expect(result.stdout).toContain(`installed: ${join(installDir, "lando.exe")}`);
    expect(await Bun.file(join(installDir, "lando.exe")).text()).toBe("lando windows fixture\n");
    const cosignLog = await Bun.file(logPath).text();
    expect(cosignLog).toContain("verify-blob");
    expect(cosignLog).toContain("SHA256SUMS.signature");
    expect(cosignLog).toContain("SHA256SUMS.crt");
  });

  powershellTest("prints canonical shellenv PATH guidance after install", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const userDataRoot = join(root, "data root with spaces");

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: "",
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_NONINTERACTIVE: "1",
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_USER_DATA_ROOT: userDataRoot,
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Run this command to add Lando to PATH:");
    expect(result.stdout).toContain(
      `& '${join(userDataRoot, "bin", "lando.exe")}' shellenv --shell=powershell`,
    );
    expect(result.stdout).toContain(renderPowerShellShellenv(userDataRoot));
  });

  powershellTest("runs post-install setup when explicitly opted in", async () => {
    const root = await makeTempRoot();
    const setupLog = join(root, "setup.log");
    const fixture = await createReleaseFixture(root, "stable", {
      binaryScript: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LANDO_SETUP_LOG"\nexit 0\n',
    });
    const { cosignPath, logPath } = await createFakeCosign(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_RUN_SETUP: "1",
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_SETUP_LOG: setupLog,
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("post-install setup: completed");
    expect(await Bun.file(setupLog).text()).toBe("setup --yes\n");
  });

  powershellTest("skips post-install setup in non-interactive mode", async () => {
    const root = await makeTempRoot();
    const setupLog = join(root, "setup.log");
    const fixture = await createReleaseFixture(root, "stable", {
      binaryScript: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LANDO_SETUP_LOG"\nexit 0\n',
    });
    const { cosignPath, logPath } = await createFakeCosign(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_NONINTERACTIVE: "1",
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_SETUP_LOG: setupLog,
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("post-install setup: skipped");
    expect(await Bun.file(setupLog).exists()).toBe(false);
  });

  powershellTest("uses the installer cosign trust root for checksum signature verification", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const trustRootPath = await writeCosignTrustRoot(root, {
      certificateIdentityRegexp:
        "^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/v4\\..+$",
      certificateOidcIssuer: "https://token.actions.githubusercontent.com",
    });

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_COSIGN_TRUST_ROOT: trustRootPath,
      LANDO_INSTALL_DIR: join(root, "install"),
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const cosignLog = await Bun.file(logPath).text();
    expect(cosignLog).toContain(
      "^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/v4\\..+$",
    );
    expect(cosignLog).toContain("https://token.actions.githubusercontent.com");
  });

  powershellTest("fails closed when the cosign trust root is missing", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_COSIGN_TRUST_ROOT: join(root, "missing-cosign-trust-root.json"),
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Missing or malformed vendored cosign trust root");
    expect(await Bun.file(join(installDir, "lando.exe")).exists()).toBe(false);
    expect(await Bun.file(logPath).exists()).toBe(false);
  });

  powershellTest("resolves stable, next, and dev manifests from the selected channel", async () => {
    const root = await makeTempRoot();
    const channelRoot = join(root, "channels");
    for (const channel of ["stable", "next", "dev"] as const) {
      await createReleaseFixture(root, channel);
    }
    const { cosignPath, logPath } = await createFakeCosign(root);

    for (const channel of ["stable", "next", "dev"] as const) {
      const installDir = join(root, channel, "install");
      const result = await runInstaller({
        COSIGN_LOG: logPath,
        LANDO_CHANNEL: channel,
        LANDO_INSTALL_BASE_URL: fileUrl(channelRoot),
        LANDO_INSTALL_COSIGN: cosignPath,
        LANDO_INSTALL_DIR: installDir,
        LANDO_INSTALL_WINDOWS_ARCH: "x86_64",
      });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`channel: ${channel}`);
      expect(await Bun.file(join(installDir, "lando.exe")).exists()).toBe(true);
    }
  });

  powershellTest("uses the CLI userDataRoot default when config and install env are unset", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      HOME: root,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: "",
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_USER_CONF_ROOT: join(root, "missing-conf"),
      LANDO_USER_DATA_ROOT: "",
      XDG_DATA_HOME: "",
    });

    const installedPath = join(root, ".local/share/lando/bin/lando.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
  });

  powershellTest("uses XDG_DATA_HOME for the default userDataRoot", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const xdgDataHome = join(root, "xdg-data");

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      HOME: root,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: "",
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_USER_CONF_ROOT: join(root, "missing-conf"),
      LANDO_USER_DATA_ROOT: "",
      XDG_DATA_HOME: xdgDataHome,
    });

    const installedPath = join(xdgDataHome, "lando", "bin", "lando.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
  });

  powershellTest("uses HOME/.lando as the default config root", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const confRoot = join(root, ".lando");
    const userDataRoot = join(root, "home-config-data-root");
    await mkdir(confRoot, { recursive: true });
    await writeFile(join(confRoot, "config.yml"), `userDataRoot: ${userDataRoot}\n`);

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      HOME: root,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: "",
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_USER_CONF_ROOT: "",
      LANDO_USER_DATA_ROOT: "",
      XDG_DATA_HOME: join(root, "xdg-data"),
    });

    const installedPath = join(userDataRoot, "bin", "lando.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
  });

  powershellTest("reads userDataRoot from config.yml when install env overrides are unset", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const confRoot = join(root, "conf");
    const userDataRoot = join(root, "from-config-yml");
    await mkdir(confRoot, { recursive: true });
    await writeFile(join(confRoot, "config.yml"), `userDataRoot: ${userDataRoot}\n`);

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: "",
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_USER_CONF_ROOT: confRoot,
      LANDO_USER_DATA_ROOT: "",
      LOCALAPPDATA: join(root, "LocalAppData"),
    });

    const installedPath = join(userDataRoot, "bin", "lando.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
  });

  powershellTest("matches minimal config parsing for indented top-level userDataRoot", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const confRoot = join(root, "conf");
    const firstRoot = join(root, "first-root");
    const finalRoot = join(root, "final-root");
    await mkdir(confRoot, { recursive: true });
    await writeFile(
      join(confRoot, "config.yml"),
      `  userDataRoot: ${firstRoot}
  nested:
    userDataRoot: ${join(root, "nested-root")}
  userDataRoot: ${finalRoot}
`,
    );

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: "",
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_USER_CONF_ROOT: confRoot,
      LANDO_USER_DATA_ROOT: "",
      LOCALAPPDATA: join(root, "LocalAppData"),
    });

    const installedPath = join(finalRoot, "bin", "lando.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
  });

  powershellTest("falls back when the last config userDataRoot is a non-string YAML value", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const confRoot = join(root, "conf");
    const staleRoot = join(root, "stale-root");
    await mkdir(confRoot, { recursive: true });
    await writeFile(
      join(confRoot, "config.yml"),
      `userDataRoot: ${staleRoot}
userDataRoot: null
`,
    );

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: "",
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_USER_CONF_ROOT: confRoot,
      LANDO_USER_DATA_ROOT: "",
      HOME: root,
      XDG_DATA_HOME: "",
    });

    const installedPath = join(root, ".local/share/lando/bin/lando.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
    expect(await Bun.file(join(staleRoot, "bin", "lando.exe")).exists()).toBe(false);
  });

  powershellTest("falls back when config.yml contains an unsupported flow scalar", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const confRoot = join(root, "conf");
    const ignoredRoot = join(root, "ignored-root");
    await mkdir(confRoot, { recursive: true });
    await writeFile(
      join(confRoot, "config.yml"),
      `plugins: ["unsupported"]
userDataRoot: ${ignoredRoot}
`,
    );

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: "",
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_USER_CONF_ROOT: confRoot,
      LANDO_USER_DATA_ROOT: "",
      HOME: root,
      XDG_DATA_HOME: "",
    });

    const installedPath = join(root, ".local/share/lando/bin/lando.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect(await Bun.file(installedPath).exists()).toBe(true);
    expect(await Bun.file(join(ignoredRoot, "bin", "lando.exe")).exists()).toBe(false);
  });

  powershellTest("treats quoted YAML keywords as string userDataRoot values", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);

    for (const keyword of ["null", "true", "false"] as const) {
      const confRoot = join(root, `conf-${keyword}`);
      await mkdir(confRoot, { recursive: true });
      await writeFile(join(confRoot, "config.yml"), `userDataRoot: "${keyword}"\n`);

      try {
        const result = await runInstaller({
          COSIGN_LOG: logPath,
          LANDO_INSTALL_COSIGN: cosignPath,
          LANDO_INSTALL_DIR: "",
          LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
          LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
          LANDO_USER_CONF_ROOT: confRoot,
          LANDO_USER_DATA_ROOT: "",
          LOCALAPPDATA: join(root, "LocalAppData"),
        });

        const installedPath = join(keyword, "bin", "lando.exe");
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`installed: ${installedPath}`);
        expect(await Bun.file(join(repoRoot, installedPath)).exists()).toBe(true);
      } finally {
        await rm(join(repoRoot, keyword), { recursive: true, force: true });
      }
    }
  });

  powershellTest("detects the x64 host architecture from 32-bit PowerShell sessions", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "",
      PROCESSOR_ARCHITECTURE: "x86",
      PROCESSOR_ARCHITEW6432: "AMD64",
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("platform: windows-x64");
    expect(await Bun.file(join(installDir, "lando.exe")).exists()).toBe(true);
  });

  powershellTest("fails closed when signature verification fails", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath } = await createFakeCosign(root, 1);
    const installDir = join(root, "install");

    const result = await runInstaller({
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Signature verification failed");
    expect(await Bun.file(join(installDir, "lando.exe")).exists()).toBe(false);
  });

  powershellTest("rejects unsupported Windows architectures before installing", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);
    const installDir = join(root, "install");

    const result = await runInstaller({
      COSIGN_LOG: logPath,
      LANDO_INSTALL_COSIGN: cosignPath,
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
      LANDO_INSTALL_WINDOWS_ARCH: "ARM64",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsupported Windows architecture");
    expect(await Bun.file(join(installDir, "lando.exe")).exists()).toBe(false);
    expect(await Bun.file(logPath).exists()).toBe(false);
  });

  powershellTest("prints execution policy remediation when PowerShell blocks the installer", async () => {
    const root = await makeTempRoot();
    const installDir = join(root, "install");

    const result = await runInstaller({
      LANDO_INSTALL_DIR: installDir,
      LANDO_INSTALL_EXECUTION_POLICY_BLOCKED: "1",
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("PowerShell execution policy blocked install.ps1");
    expect(result.stderr).toContain("Set-ExecutionPolicy -Scope CurrentUser RemoteSigned");
    expect(result.stderr).toContain("powershell -ExecutionPolicy Bypass -File install.ps1");
    expect(await Bun.file(join(installDir, "lando.exe")).exists()).toBe(false);
  });
});
