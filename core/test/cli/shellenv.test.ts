import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { installRecordOwnsDestination } from "@lando/engine/install/record";
import { makeLandoPaths } from "@lando/paths";

import {
  defaultPosixShellProfilePath,
  renderPosixShellenv,
  renderPowerShellShellenv,
  shellProfileInstallCommand,
  shellenvBinDir,
} from "../../src/cli/commands/shellenv.ts";

const coreRoot = resolve(import.meta.dirname, "../..");
const binaryPath = resolve(coreRoot, "dist/lando");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (
  cmd: Array<string>,
  cwd = coreRoot,
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd,
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "compiled CLI shellenv command",
  () => {
    test("prints shell integration lines before runtime bootstrap", async () => {
      const build = await runCommand([process.execPath, "run", "build"]);
      expect(build.exitCode).toBe(0);

      const shellenv = await runCommand([binaryPath, "shellenv"]);
      const lines = shellenv.stdout.trim().split("\n");

      expect(shellenv.exitCode).toBe(0);
      expect(shellenv.stderr).toBe("");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toStartWith("export LANDO_USER_DATA_ROOT=");
      expect(lines[1]).toBe(renderPosixShellenv().split("\n")[1]);
    }, 120_000);

    test("prints PowerShell shellenv snippets when requested", async () => {
      const build = await runCommand([process.execPath, "run", "build"]);
      expect(build.exitCode).toBe(0);

      const shellenv = await runCommand([binaryPath, "shellenv", "--shell=powershell"]);

      expect(shellenv.exitCode).toBe(0);
      expect(shellenv.stderr).toBe("");
      expect(shellenv.stdout).toContain("$Env:LANDO_USER_DATA_ROOT = ");
      expect(shellenv.stdout).toContain(renderPowerShellShellenv().split("\n")[1] ?? "missing PATH export");
    }, 120_000);
  },
);

describe("shellenv snippet rendering", () => {
  for (const initial of ["/a:/b", "/a:DIR:/b", "/a:DIRx:/b"]) {
    test(`preserves complete PATH elements when evaluated twice with ${initial}`, async () => {
      // Given a directory containing shell metacharacters and a controlled PATH.
      const root = "/tmp/Lando User's $Data [x]";
      const dir = `${root}/bin`;
      const path = initial.replace("DIR", dir);
      const snippet = renderPosixShellenv(root);
      // When the real POSIX shell evaluates the snippet twice.
      const proc = Bun.spawn(["/bin/sh", "-c", `${snippet}\n${snippet}\nprintf '%s' "$PATH"`], {
        env: { PATH: path },
        stdout: "pipe",
        stderr: "pipe",
      });
      const result = await new Response(proc.stdout).text();
      // Then only a missing complete element is prepended.
      expect(await proc.exited).toBe(0);
      expect(result).toBe(initial === "/a:DIR:/b" ? path : `${dir}:${path}`);
      expect(result.split(":").filter((entry) => entry === dir)).toHaveLength(1);
    });
  }
  test("escapes POSIX paths with spaces and single quotes", () => {
    expect(renderPosixShellenv("/tmp/Lando User's Data")).toBe(
      "export LANDO_USER_DATA_ROOT='/tmp/Lando User'\"'\"'s Data'\n" +
        "case \":${PATH}:\" in *':/tmp/Lando User'\"'\"'s Data/bin:'*) ;; *) export PATH='/tmp/Lando User'\"'\"'s Data/bin'\":${PATH}\" ;; esac",
    );
  });

  test("escapes PowerShell paths with spaces and single quotes", () => {
    expect(renderPowerShellShellenv("C:/Users/Lando User's Data")).toBe(
      "$Env:LANDO_USER_DATA_ROOT = 'C:/Users/Lando User''s Data'\n" +
        "if (-not (($Env:PATH -split [IO.Path]::PathSeparator) -contains 'C:/Users/Lando User''s Data/bin')) { " +
        "$Env:PATH = 'C:/Users/Lando User''s Data/bin' + [IO.Path]::PathSeparator + $Env:PATH }",
    );
  });
});

const installFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando4-record-"));
  const custom = join(root, "custom ' $ [bin]");
  const paths = makeLandoPaths({ userDataRoot: root });
  const path = join(custom, "lando4");
  const bytes = "installed executable";
  const record = {
    version: 1 as const,
    data: {
      executable: {
        path,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        channel: "dev",
        platform: "linux-x64",
      },
      shellProfiles: [],
    },
  };
  await mkdir(custom);
  await mkdir(join(root, "install"));
  await writeFile(path, bytes);
  await writeFile(paths.installRecordFile, JSON.stringify(record));
  return {
    root,
    custom,
    paths,
    record,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
};

describe("record-backed shellenv", () => {
  test("uses the owned custom directory in both shell renderings", async () => {
    await using fixture = await installFixture();
    const { root, custom, paths } = fixture;
    const posix = renderPosixShellenv(root);
    const powershell = renderPowerShellShellenv(root);
    const proc = Bun.spawn(["/bin/sh", "-c", `${posix}\n${posix}\nprintf '%s' "$PATH"`], {
      env: { PATH: "/a:/b" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(`${custom}:/a:/b`);
    expect(powershell).toContain(`-contains '${custom.replaceAll("'", "''")}'`);
    expect(powershell).toContain(`$Env:PATH = '${custom.replaceAll("'", "''")}'`);
    expect(posix + powershell).not.toContain(paths.binDir);
  });
  test("falls back to binDir only when the record is absent", async () => {
    await using fixture = await installFixture();
    await rm(fixture.paths.installRecordFile);
    expect(shellenvBinDir(fixture.root)).toBe(fixture.paths.binDir);
  });
  for (const failure of [
    "json",
    "version",
    "schema",
    "path",
    "digest",
    "symlink",
    "directory",
    "missing",
  ] as const) {
    test(`fails closed with remediation when the record has ${failure} failure`, async () => {
      await using fixture = await installFixture();
      const { root, paths, record } = fixture;
      const file = paths.installRecordFile;
      switch (failure) {
        case "json":
          await writeFile(file, "{");
          break;
        case "version":
          await writeFile(file, JSON.stringify({ ...record, version: 2 }));
          break;
        case "schema":
          await writeFile(file, JSON.stringify({ ...record, extra: true }));
          break;
        case "path":
          await symlink(fixture.custom, join(root, "alias"));
          await writeFile(
            file,
            JSON.stringify({
              ...record,
              data: {
                ...record.data,
                executable: { ...record.data.executable, path: join(root, "alias", "lando4") },
              },
            }),
          );
          break;
        case "digest":
          await writeFile(record.data.executable.path, "drifted");
          break;
        case "symlink":
          await rm(file);
          await symlink(record.data.executable.path, file);
          break;
        case "directory":
          await rm(file);
          await mkdir(file);
          break;
        case "missing":
          await rm(record.data.executable.path);
          break;
      }
      for (const shellArgs of [[], ["--shell=powershell"]]) {
        const result = await runCommand(
          [process.execPath, "bin/lando.ts", "shellenv", ...shellArgs],
          coreRoot,
          {
            LANDO_USER_DATA_ROOT: root,
            LANDO_USER_CACHE_ROOT: join(root, "cache"),
            LANDO_USER_CONF_ROOT: join(root, "conf"),
          },
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("InstallRecordError");
        expect(result.stderr).toMatch(/remediation|repair|installer/iu);
      }
    });
  }
  test("agrees with the engine ownership predicate for owned and every rejection verdict", async () => {
    for (const reason of [
      "owned",
      "path-mismatch",
      "not-regular-file",
      "digest-mismatch",
      "size-mismatch",
    ] as const) {
      await using fixture = await installFixture();
      const { record, root, paths } = fixture;
      const executable = record.data.executable;
      const destination = reason === "path-mismatch" ? join(root, "elsewhere") : executable.path;
      const stat = {
        isFile: reason !== "not-regular-file",
        isSymbolicLink: false,
        isDirectory: reason === "not-regular-file",
        size: executable.size,
      };
      const digest = reason === "digest-mismatch" ? "0".repeat(64) : executable.sha256;
      const candidate = {
        ...record,
        data: {
          ...record.data,
          executable: {
            ...executable,
            size: reason === "size-mismatch" ? executable.size + 1 : executable.size,
          },
        },
      };
      await writeFile(paths.installRecordFile, JSON.stringify(candidate));
      if (reason === "not-regular-file") {
        await rm(destination);
        await mkdir(destination);
      }
      if (reason === "digest-mismatch") await writeFile(destination, "changed");
      const expected = installRecordOwnsDestination(candidate, destination, stat, digest);
      if (expected.owned) expect(shellenvBinDir(root, destination)).toBe(fixture.custom);
      else
        expect(() => shellenvBinDir(root, destination)).toThrow(
          expect.objectContaining({
            _tag: "InstallRecordError",
            detail: expect.stringContaining(expected.reason),
            remediation: expect.any(String),
          }),
        );
    }
  });
});

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
};

describe("shell profile install path", () => {
  test("appends one LANDO4 block while preserving the generic LANDO block", async () => {
    // Given an existing Lando 3 profile block.
    const root = await mkdtemp(join(tmpdir(), "lando4-shellenv-"));
    const profile = join(root, "profile");
    const original = "# >>> LANDO shellenv >>>\nexport PATH=/lando3:$PATH\n# <<< LANDO shellenv <<<\n";
    try {
      await writeFile(profile, original);
      const command = [...shellProfileInstallCommand(root, profile)];
      // When installation is requested twice.
      expect((await runCommand(command)).exitCode).toBe(0);
      expect((await runCommand(command)).exitCode).toBe(0);
      const installed = await readFile(profile, "utf8");
      // Then the original bytes precede a distinct, single v4 block.
      expect(installed).toStartWith(`${original}\n# >>> LANDO4 shellenv >>>\n`);
      expect(installed).toEndWith("# <<< LANDO4 shellenv <<<\n");
      expect(installed.match(/# >>> LANDO4 shellenv >>>/gu)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("writes LANDO_SHELL_PROFILE when that env is set", () => {
    expect(
      defaultPosixShellProfilePath({
        LANDO_SHELL_PROFILE: "/tmp/custom-lando.rc",
        HOME: "/home/me",
        SHELL: "/bin/bash",
      }),
    ).toBe("/tmp/custom-lando.rc");

    const previous = process.env.LANDO_SHELL_PROFILE;
    try {
      process.env.LANDO_SHELL_PROFILE = "/tmp/custom-lando.rc";
      expect(shellProfileInstallCommand("/tmp/lando-data").join("\n")).toContain("/tmp/custom-lando.rc");
    } finally {
      restoreEnv("LANDO_SHELL_PROFILE", previous);
    }
  });

  test("falls back to the default POSIX profile when LANDO_SHELL_PROFILE is unset", () => {
    expect(defaultPosixShellProfilePath({ HOME: "/home/me", SHELL: "/bin/bash" })).toBe("/home/me/.bashrc");

    const previous = process.env.LANDO_SHELL_PROFILE;
    const previousHome = process.env.HOME;
    const previousShell = process.env.SHELL;
    try {
      Reflect.deleteProperty(process.env, "LANDO_SHELL_PROFILE");
      process.env.HOME = "/home/me";
      process.env.SHELL = "/bin/bash";
      expect(defaultPosixShellProfilePath()).toBe("/home/me/.bashrc");
      expect(shellProfileInstallCommand("/tmp/lando-data").join("\n")).toContain("/home/me/.bashrc");
    } finally {
      restoreEnv("LANDO_SHELL_PROFILE", previous);
      restoreEnv("HOME", previousHome);
      restoreEnv("SHELL", previousShell);
    }
  });
});
