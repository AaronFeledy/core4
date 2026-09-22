// allow: SIZE_OK — exclusive single-file installer harness; trust, roots, and ownership scenarios share fixtures.
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

import { renderPowerShellShellenv } from "../../src/cli/commands/shellenv.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const installerPath = resolve(repoRoot, "scripts/install.ps1");
const powershellTestTimeoutMs = 60_000;
const powershell = Bun.which("pwsh");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const powershellTest = (name: string, fn: () => void | Promise<void>): void => {
  (powershell === null ? test.skip : test)(name, fn, powershellTestTimeoutMs);
};

const fileUrl = (path: string): string => pathToFileURL(path).href;

const makeTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-install-windows-"));
  roots.push(root);
  return root;
};

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

const HOST_ROOT_OVERRIDES = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_INSTALL_DIR",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
] as const;

const hostEnvWithoutLandoRoots = (): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !HOST_ROOT_OVERRIDES.some((override) => override === key)),
  );

const runInstaller = async (
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath], {
    cwd: roots.at(-1) ?? repoRoot,
    env: {
      ...hostEnvWithoutLandoRoots(),
      HOME: roots.at(-1),
      LOCALAPPDATA: join(roots.at(-1) ?? tmpdir(), "LocalAppData"),
      LANDO_INSTALL_NONINTERACTIVE: "1",
      ...env,
    },
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

const treeSnapshot = async (path: string): Promise<readonly unknown[]> => {
  const stat = await lstat(path);
  const identity = { path, mode: stat.mode, size: stat.size, ino: stat.ino, mtime: stat.mtimeMs };
  if (stat.isSymbolicLink()) return [{ ...identity, target: await readlink(path) }];
  if (stat.isDirectory())
    return [
      identity,
      ...(await Promise.all((await readdir(path)).sort().map((name) => treeSnapshot(join(path, name))))),
    ];
  return [{ ...identity, sha256: sha256(await readFile(path)) }];
};

const ownershipFixture = async () => {
  const root = await makeTempRoot();
  const release = await createReleaseFixture(root);
  const { cosignPath, logPath } = await createFakeCosign(root);
  const dataRoot = join(root, "data");
  const installDir = join(root, "bin");
  await mkdir(installDir);
  const destination = join(installDir, "lando4.exe");
  const recordPath = join(dataRoot, "install", "record.json");
  const bytes = await readFile(release.binaryPath);
  const record = {
    version: 1,
    data: {
      executable: {
        path: destination,
        sha256: sha256(bytes),
        size: bytes.length,
        channel: "stable",
        platform: "windows-x64",
      },
      shellProfiles: [],
    },
  };
  const env = {
    COSIGN_LOG: logPath,
    HOME: root,
    LANDO_INSTALL_COSIGN: cosignPath,
    LANDO_INSTALL_DIR: installDir,
    LANDO_INSTALL_MANIFEST_URL: fileUrl(release.manifestPath),
    LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
    LANDO_USER_DATA_ROOT: dataRoot,
  };
  return { root, installDir, destination, recordPath, bytes, record, env, logPath };
};

describe("Windows installer ownership", () => {
  powershellTest("writes a valid install record and no legacy executable or temporary files", async () => {
    // Given a verified release and an empty destination.
    const fixture = await ownershipFixture();
    // When installed through the real PowerShell entry point.
    const result = await runInstaller(fixture.env);
    // Then bytes and the independently decoded record identify only Lando 4.
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect((await lstat(fixture.destination)).isFile()).toBe(true);
    expect(await readFile(fixture.destination)).toEqual(fixture.bytes);
    const { decodeInstallRecord } = await import("@lando/engine/install/record");
    const { Effect } = await import("effect");
    const decoded = await Effect.runPromise(
      decodeInstallRecord(await readFile(fixture.recordPath, "utf8"), fixture.recordPath),
    );
    expect(decoded).toEqual({ ...fixture.record, version: 1 });
    expect((await lstat(fixture.recordPath)).isFile()).toBe(true);
    expect(await readdir(fixture.installDir)).toEqual(["lando4.exe"]);
    expect(await readdir(join(fixture.env.LANDO_USER_DATA_ROOT, "install"))).toEqual(["record.json"]);
    await expect(lstat(join(fixture.installDir, "lando.exe"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  powershellTest("repeats an owned install idempotently", async () => {
    // Given an already installed, record-owned executable.
    const fixture = await ownershipFixture();
    expect((await runInstaller(fixture.env)).exitCode).toBe(0);
    const record = await readFile(fixture.recordPath);
    // When the same release is installed again.
    const result = await runInstaller(fixture.env);
    // Then content and ownership remain unchanged, with no staging residue.
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await readFile(fixture.destination)).toEqual(fixture.bytes);
    expect(await readFile(fixture.recordPath)).toEqual(record);
    expect(await readdir(fixture.installDir)).toEqual(["lando4.exe"]);
    expect(await readdir(join(fixture.env.LANDO_USER_DATA_ROOT, "install"))).toEqual(["record.json"]);
  });

  for (const kind of ["file", "symlink"] as const) {
    powershellTest(`preserves legacy lando.exe and bare lando when seeded as ${kind}`, async () => {
      // Given hostile legacy executables, including a reparse target.
      const fixture = await ownershipFixture();
      const target = join(fixture.root, "legacy-target");
      await writeFile(target, "legacy target bytes");
      for (const name of ["lando.exe", "lando"]) {
        const path = join(fixture.installDir, name);
        if (kind === "symlink") await symlink(target, path);
        else {
          await writeFile(path, `legacy ${name}`);
          await chmod(path, 0o444);
        }
      }
      const before = await Promise.all(
        ["lando.exe", "lando"].map((name) => treeSnapshot(join(fixture.installDir, name))),
      );
      const targetBefore = await treeSnapshot(target);
      // When Lando 4 is installed beside them.
      const result = await runInstaller(fixture.env);
      // Then every legacy inode, attribute, link, and byte is preserved.
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(
        await Promise.all(["lando.exe", "lando"].map((name) => treeSnapshot(join(fixture.installDir, name)))),
      ).toEqual(before);
      expect(await treeSnapshot(target)).toEqual(targetBefore);
    });
  }

  for (const kind of [
    "unrecorded",
    "directory",
    "symlink",
    "dangling",
    "digest-drift",
    "size-drift",
    "corrupt",
    "version",
    "path",
    "record-symlink",
    "record-directory",
  ] as const) {
    powershellTest(`rejects foreign destination before writing when ${kind}`, async () => {
      // Given an unowned destination or unusable ownership evidence.
      const fixture = await ownershipFixture();
      const target = join(fixture.root, "target");
      await mkdir(join(fixture.env.LANDO_USER_DATA_ROOT, "install"), { recursive: true });
      switch (kind) {
        case "directory":
          await mkdir(fixture.destination);
          break;
        case "symlink":
          await writeFile(target, fixture.bytes);
          await symlink(target, fixture.destination);
          break;
        case "dangling":
          await symlink(target, fixture.destination);
          break;
        default:
          await writeFile(fixture.destination, fixture.bytes);
      }
      switch (kind) {
        case "digest-drift":
          fixture.record.data.executable.sha256 = "0".repeat(64);
          break;
        case "size-drift":
          fixture.record.data.executable.size++;
          break;
        case "version":
          fixture.record.version = 2;
          break;
        case "path":
          fixture.record.data.executable.path = target;
          break;
        default:
          break;
      }
      if (kind === "record-directory") await mkdir(fixture.recordPath);
      else if (kind === "record-symlink") {
        await writeFile(target, JSON.stringify(fixture.record));
        await symlink(target, fixture.recordPath);
      } else if (kind !== "unrecorded")
        await writeFile(fixture.recordPath, kind === "corrupt" ? "{broken" : JSON.stringify(fixture.record));
      const before = await treeSnapshot(fixture.installDir);
      const dataBefore = await treeSnapshot(fixture.env.LANDO_USER_DATA_ROOT);
      // When the installer attempts replacement.
      const result = await runInstaller(fixture.env);
      // Then it fails with actionable ownership remediation and changes nothing.
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(fixture.destination);
      expect(result.stderr).toContain("LANDO_INSTALL_DIR");
      expect(await treeSnapshot(fixture.installDir)).toEqual(before);
      expect(await treeSnapshot(fixture.env.LANDO_USER_DATA_ROOT)).toEqual(dataBefore);
      await expect(lstat(fixture.logPath)).rejects.toMatchObject({ code: "ENOENT" });
      if (kind === "symlink") expect(await readFile(target)).toEqual(fixture.bytes);
      if (kind === "dangling") await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  for (const source of ["override", "localappdata", "home", "userprofile"] as const) {
    powershellTest(
      `ignores the entire hostile legacy state tree with ${source} root resolution`,
      async () => {
        // Given a legacy configuration that points installs inside Lando 3 state.
        const fixture = await ownershipFixture();
        const legacy = join(fixture.root, ".lando");
        await mkdir(join(legacy, "state"), { recursive: true });
        await writeFile(join(legacy, "config.yml"), `userDataRoot: ${join(legacy, "hijacked")}\n`);
        await writeFile(join(legacy, "state", "secret"), "legacy state\0");
        await symlink("state/secret", join(legacy, "link"));
        const before = await treeSnapshot(legacy);
        const local = join(fixture.root, "local");
        const expected =
          source === "override"
            ? fixture.env.LANDO_USER_DATA_ROOT
            : source === "localappdata"
              ? join(local, "Lando", "Data")
              : join(fixture.root, "AppData", "Local", "Lando", "Data");
        // When v4 resolves its roots independently of every legacy config override.
        const result = await runInstaller({
          ...fixture.env,
          HOME: source === "userprofile" ? undefined : fixture.root,
          USERPROFILE: fixture.root,
          LANDO_INSTALL_DIR: "",
          LANDO_USER_DATA_ROOT: source === "override" ? expected : "",
          LOCALAPPDATA: source === "localappdata" ? local : "",
          LANDO_USER_CONF_ROOT: legacy,
          LANDO_CONFIG__user_conf_root: legacy,
        });
        // Then only the v4 matrix root is used; the entire legacy tree is unchanged.
        expect(result).toMatchObject({ exitCode: 0, stderr: "" });
        expect(await readFile(join(expected, "bin", "lando4.exe"))).toEqual(fixture.bytes);
        expect(await treeSnapshot(legacy)).toEqual(before);
      },
    );
  }
});

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
    expect(result.stdout).toContain(`installed: ${join(installDir, "lando4.exe")}`);
    expect(await Bun.file(join(installDir, "lando4.exe")).text()).toBe("lando windows fixture\n");
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
      `& '${join(userDataRoot, "bin", "lando4.exe")}' shellenv --shell=powershell`,
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
    await expect(lstat(setupLog)).rejects.toMatchObject({ code: "ENOENT" });
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
    await expect(lstat(join(installDir, "lando4.exe"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
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
      expect((await lstat(join(installDir, "lando4.exe"))).isFile()).toBe(true);
    }
  });

  powershellTest("uses HOME/AppData/Local when LOCALAPPDATA and install env are unset", async () => {
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
      LOCALAPPDATA: "",
    });

    const installedPath = join(root, "AppData/Local/Lando/Data/bin/lando4.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
  });

  powershellTest("uses LOCALAPPDATA rather than XDG_DATA_HOME for the default userDataRoot", async () => {
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

    const installedPath = join(root, "LocalAppData/Lando/Data/bin/lando4.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
    await expect(lstat(xdgDataHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  powershellTest("ignores HOME/.lando as the legacy config root", async () => {
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

    const installedPath = join(root, "LocalAppData/Lando/Data/bin/lando4.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
    await expect(lstat(userDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  powershellTest("ignores userDataRoot from config.yml when install env overrides are unset", async () => {
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

    const installedPath = join(root, "LocalAppData/Lando/Data/bin/lando4.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
    await expect(lstat(userDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  powershellTest("ignores indented top-level userDataRoot in legacy config", async () => {
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

    const installedPath = join(root, "LocalAppData/Lando/Data/bin/lando4.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
    await expect(lstat(finalRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  powershellTest("ignores legacy config with a non-string YAML value", async () => {
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

    const installedPath = join(root, "LocalAppData/Lando/Data/bin/lando4.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
    await expect(lstat(staleRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  powershellTest("ignores legacy config containing a flow scalar", async () => {
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

    const installedPath = join(root, "LocalAppData/Lando/Data/bin/lando4.exe");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`installed: ${installedPath}`);
    expect((await lstat(installedPath)).isFile()).toBe(true);
    await expect(lstat(ignoredRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  powershellTest("ignores quoted YAML keywords in legacy config", async () => {
    const root = await makeTempRoot();
    const fixture = await createReleaseFixture(root);
    const { cosignPath, logPath } = await createFakeCosign(root);

    for (const keyword of ["null", "true", "false"] as const) {
      const confRoot = join(root, `conf-${keyword}`);
      await mkdir(confRoot, { recursive: true });
      await writeFile(join(confRoot, "config.yml"), `userDataRoot: "${keyword}"\n`);

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

      const installedPath = join(root, "LocalAppData/Lando/Data/bin/lando4.exe");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`installed: ${installedPath}`);
      expect((await lstat(installedPath)).isFile()).toBe(true);
      expect(await readFile(join(confRoot, "config.yml"), "utf8")).toBe(`userDataRoot: "${keyword}"\n`);
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
    expect((await lstat(join(installDir, "lando4.exe"))).isFile()).toBe(true);
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
    await expect(lstat(join(installDir, "lando4.exe"))).rejects.toMatchObject({ code: "ENOENT" });
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
    await expect(lstat(join(installDir, "lando4.exe"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
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
    await expect(lstat(join(installDir, "lando4.exe"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
