import { describe, expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { Effect } from "effect";
import {
  OWNER_ONLY_FILE_ACL_SCRIPT,
  PrivateFileAccessError,
  type PrivateFileAccessProcessRunner,
  VERIFY_OWNER_ONLY_FILE_ACL_SCRIPT,
  makeOwnerOnlyFileAccess,
} from "../../src/private-file-access.ts";

import { nativeProcessRunner } from "../private-file-access.ts";

describe("owner-only private file access", () => {
  test("passes an untrusted file path only as process data", async () => {
    // Given an injection-shaped Windows path and a recording process runner
    const path = "C:\\tmp\\'; Remove-Item C:\\important; '.json";
    let invocation: Parameters<PrivateFileAccessProcessRunner["run"]>[0] | undefined;
    const processRunner: PrivateFileAccessProcessRunner = {
      run: (input) => {
        invocation = input;
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      },
    };

    // When owner-only access is applied
    const access = makeOwnerOnlyFileAccess({
      platform: "win32",
      env: { SystemRoot: "D:\\Windows" },
      processRunner,
    });
    await access.enforce(path);

    // Then the executable and script are fixed while the path travels only in the environment
    expect(invocation?.cmd).toBe(
      win32.join("D:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    expect(invocation?.args.join(" ")).not.toContain(path);
    expect(invocation?.env).toEqual({ LANDO_PRIVATE_FILE_PATH: path });
    expect(OWNER_ONLY_FILE_ACL_SCRIPT).toContain("SetAccessRuleProtection($true, $false)");
    expect(OWNER_ONLY_FILE_ACL_SCRIPT).toContain("WindowsIdentity]::GetCurrent()");
  });

  test("fails closed when PowerShell cannot verify the ACL", async () => {
    // Given a Windows ACL runner that reports failure
    const path = "C:\\tmp\\private.json";

    // When access restriction fails, then the typed failure names only the target path
    const access = makeOwnerOnlyFileAccess({
      platform: "win32",
      env: { SystemRoot: "D:\\Windows" },
      processRunner: {
        run: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "sensitive diagnostics" }),
      },
    });
    await expect(access.enforce(path)).rejects.toEqual(new PrivateFileAccessError(path));
  });

  test("fails closed when the Windows system root is unavailable", async () => {
    // Given a Windows process environment without an absolute system root
    let calls = 0;
    const access = makeOwnerOnlyFileAccess({
      platform: "win32",
      env: {},
      processRunner: {
        run: () => {
          calls += 1;
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      },
    });

    // When access restriction is attempted, then execution is refused before spawning
    await expect(access.enforce("D:\\tmp\\private.json")).rejects.toEqual(
      new PrivateFileAccessError("D:\\tmp\\private.json"),
    );
    expect(calls).toBe(0);
  });

  test("verifies an existing ACL without mutating it", async () => {
    // Given a recording Windows process runner
    let encodedCommand: string | undefined;
    const access = makeOwnerOnlyFileAccess({
      platform: "win32",
      env: { SystemRoot: "D:\\Windows" },
      processRunner: {
        run: (input) => {
          encodedCommand = input.args.at(-1);
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      },
    });

    // When an existing private file is verified
    await access.verify("D:\\tmp\\private.json");

    // Then the verifier command contains no ACL mutation
    expect(Buffer.from(encodedCommand ?? "", "base64").toString("utf16le")).toBe(
      VERIFY_OWNER_ONLY_FILE_ACL_SCRIPT,
    );
    expect(VERIFY_OWNER_ONLY_FILE_ACL_SCRIPT).not.toContain("SetAccessControl");
  });

  test("does not spawn PowerShell on non-Windows hosts", async () => {
    // Given a non-Windows platform and a runner that records calls
    let calls = 0;

    // When owner-only access is requested, then POSIX mode handling remains the only path
    const access = makeOwnerOnlyFileAccess({
      platform: "linux",
      env: {},
      processRunner: {
        run: () => {
          calls += 1;
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      },
    });
    await access.enforce("/tmp/private.json");
    await access.verify("/tmp/private.json");
    expect(calls).toBe(0);
  });

  test.skipIf(process.platform !== "win32")(
    "applies and verifies an owner-only DACL with native Windows PowerShell",
    async () => {
      // Given an exclusively created empty file on a native Windows host
      const dir = await mkdtemp(join(tmpdir(), "lando-private-acl-"));
      const path = join(dir, "private file.json");
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      try {
        // When the production ACL helper restricts and verifies the file
        const access = makeOwnerOnlyFileAccess({
          platform: "win32",
          env: process.env,
          processRunner: nativeProcessRunner,
        });
        await access.enforce(path);
        await access.verify(path);

        // Then the fixed PowerShell verifier completed successfully
        expect(await Bun.file(path).exists()).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "win32")(
    "rejects a native Windows file after its owner-only DACL is widened",
    async () => {
      // Given a natively enforced private file whose DACL is then widened to Everyone read access
      const dir = await mkdtemp(join(tmpdir(), "lando-private-acl-tamper-"));
      const path = join(dir, "private file.json");
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      const access = makeOwnerOnlyFileAccess({
        platform: "win32",
        env: process.env,
        processRunner: nativeProcessRunner,
      });
      try {
        await access.enforce(path);
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
        if (systemRoot === undefined) throw new Error("native Windows system root is unavailable");
        const script = `
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('LANDO_PRIVATE_FILE_PATH', 'Process')
$acl = [IO.File]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Access)
$everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.File]::SetAccessControl($path, $acl)
`.trim();
        const tamper = await Effect.runPromise(
          nativeProcessRunner.run({
            cmd: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(script, "utf16le").toString("base64"),
            ],
            env: { LANDO_PRIVATE_FILE_PATH: path },
          }),
        );
        expect(tamper.exitCode).toBe(0);

        // When the production verifier inspects the widened DACL, then it fails closed
        await expect(access.verify(path)).rejects.toEqual(new PrivateFileAccessError(path));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
