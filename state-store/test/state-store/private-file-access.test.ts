import { describe, expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { Effect } from "effect";
import {
  PrivateFileAccessError,
  type PrivateFileAccessLiveOptions,
  PrivateFileAccessService,
  makePrivateFileAccessLive,
} from "../../src/private-file-access.ts";

import {
  OWNER_ONLY_FILE_ACL_BODY,
  OWNER_ONLY_FILE_ACL_WORKER_SCRIPT,
  VERIFY_OWNER_ONLY_FILE_ACL_BODY,
} from "../../src/private-file-worker.ts";
import { nativeProcessRunner } from "../private-file-access.ts";
import { makeRecordingWorkerSpawn } from "../private-file-worker.ts";

const runWithAccess = <A>(
  options: PrivateFileAccessLiveOptions,
  use: (access: typeof PrivateFileAccessService.Service) => Promise<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const access = yield* PrivateFileAccessService;
        return yield* Effect.promise(() => use(access));
      }).pipe(Effect.provide(makePrivateFileAccessLive(options))),
    ),
  );

describe("owner-only private file access", () => {
  test("passes an untrusted file path only as process data", async () => {
    // Given an injection-shaped Windows path and a recording process runner
    const path = "C:\\tmp\\'; Remove-Item C:\\important; '.json";
    const worker = makeRecordingWorkerSpawn();

    // When owner-only access is applied
    await runWithAccess(
      { platform: "win32", env: { SystemRoot: "D:\\Windows" }, spawn: worker.spawn },
      (access) => access.enforce(path),
    );

    // Then the executable and script are fixed while the path travels only in the environment
    expect(worker.commands[0]?.[0]).toBe(
      win32.join("D:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    expect(worker.commands[0]?.join(" ")).not.toContain(path);
    expect(worker.requests).toEqual([{ id: "1", operation: "enforce", path }]);
    expect(OWNER_ONLY_FILE_ACL_BODY).toContain("SetAccessRuleProtection($true, $false)");
    expect(OWNER_ONLY_FILE_ACL_WORKER_SCRIPT).toContain("WindowsIdentity]::GetCurrent()");
  });

  test("reuses one Windows ACL process for sequential operations", async () => {
    // Given a recording Windows ACL process runner
    const worker = makeRecordingWorkerSpawn();

    // When two private-file operations run sequentially
    await runWithAccess(
      { platform: "win32", env: { SystemRoot: "D:\\Windows" }, spawn: worker.spawn },
      async (access) => {
        await access.enforce("D:\\tmp\\first.json");
        await access.verify("D:\\tmp\\second.json");
      },
    );

    // Then PowerShell starts only once
    expect(worker.spawnCount()).toBe(1);
  });

  test("serializes concurrent Windows ACL operations", async () => {
    // Given a worker that records concurrent request handling
    let active = 0;
    let peak = 0;
    const worker = makeRecordingWorkerSpawn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { kind: "response", ok: true };
    });

    // When private-file operations start concurrently
    await runWithAccess(
      { platform: "win32", env: { SystemRoot: "D:\\Windows" }, spawn: worker.spawn },
      (access) => Promise.all([access.enforce("D:\\tmp\\first.json"), access.verify("D:\\tmp\\second.json")]),
    );

    // Then the single worker receives one complete request at a time
    expect(peak).toBe(1);
    expect(worker.spawnCount()).toBe(1);
  });

  test("fails closed when PowerShell cannot verify the ACL", async () => {
    // Given a Windows ACL runner that reports failure
    const path = "C:\\tmp\\private.json";

    // When access restriction fails, then the typed failure names only the target path
    const worker = makeRecordingWorkerSpawn(() => ({ kind: "response", ok: false }));
    await expect(
      runWithAccess(
        { platform: "win32", env: { SystemRoot: "D:\\Windows" }, spawn: worker.spawn },
        (access) => access.enforce(path),
      ),
    ).rejects.toThrow(new PrivateFileAccessError(path).message);
  });

  test("fails closed when the Windows system root is unavailable", async () => {
    // Given a Windows process environment without an absolute system root
    const worker = makeRecordingWorkerSpawn();

    // When access restriction is attempted, then execution is refused before spawning
    await expect(
      runWithAccess({ platform: "win32", env: {}, spawn: worker.spawn }, (access) =>
        access.enforce("D:\\tmp\\private.json"),
      ),
    ).rejects.toThrow(new PrivateFileAccessError("D:\\tmp\\private.json").message);
    expect(worker.spawnCount()).toBe(0);
  });

  test("verifies an existing ACL without mutating it", async () => {
    // Given a recording Windows process runner
    const worker = makeRecordingWorkerSpawn();

    // When an existing private file is verified
    await runWithAccess(
      { platform: "win32", env: { SystemRoot: "D:\\Windows" }, spawn: worker.spawn },
      (access) => access.verify("D:\\tmp\\private.json"),
    );

    // Then the verifier command contains no ACL mutation
    expect(worker.requests[0]?.operation).toBe("verify");
    expect(VERIFY_OWNER_ONLY_FILE_ACL_BODY).not.toContain("SetAccessControl");
  });

  test("does not spawn PowerShell on non-Windows hosts", async () => {
    // Given a non-Windows platform and a runner that records calls
    const worker = makeRecordingWorkerSpawn();

    // When owner-only access is requested, then POSIX mode handling remains the only path
    await runWithAccess({ platform: "linux", env: {}, spawn: worker.spawn }, async (access) => {
      await access.enforce("/tmp/private.json");
      await access.verify("/tmp/private.json");
    });
    expect(worker.spawnCount()).toBe(0);
  });

  test("does not replay a failed request and restarts for a later operation", async () => {
    // Given a worker that exits while handling the first request
    let requests = 0;
    const worker = makeRecordingWorkerSpawn(() => {
      requests += 1;
      return requests === 1 ? { kind: "exit", code: 1 } : { kind: "response", ok: true };
    });
    const failedPath = "D:\\tmp\\failed.json";
    const recoveredPath = "D:\\tmp\\recovered.json";

    // When the failed operation is followed by a new operation in the same scope
    await runWithAccess(
      { platform: "win32", env: { SystemRoot: "D:\\Windows" }, spawn: worker.spawn },
      async (access) => {
        await expect(access.enforce(failedPath)).rejects.toEqual(new PrivateFileAccessError(failedPath));
        await access.verify(recoveredPath);
      },
    );

    // Then the failed request was sent once and the later request used a replacement worker
    expect(worker.requests.map(({ path }) => path)).toEqual([failedPath, recoveredPath]);
    expect(worker.spawnCount()).toBe(2);
  });

  test("fails closed on a malformed worker response", async () => {
    // Given a worker that emits non-protocol stdout
    const worker = makeRecordingWorkerSpawn(() => ({ kind: "response", line: "not-json" }));
    const path = "D:\\tmp\\private.json";

    // When enforcement receives the malformed frame, then only the path-bearing error escapes
    await expect(
      runWithAccess(
        { platform: "win32", env: { SystemRoot: "D:\\Windows" }, spawn: worker.spawn },
        (access) => access.enforce(path),
      ),
    ).rejects.toThrow(new PrivateFileAccessError(path).message);
  });

  test("reaps the Windows ACL worker when its Effect scope closes", async () => {
    // Given a scoped private-file service with an active worker
    const worker = makeRecordingWorkerSpawn();

    // When the service scope closes after a successful operation
    await runWithAccess(
      { platform: "win32", env: { SystemRoot: "D:\\Windows" }, spawn: worker.spawn },
      (access) => access.enforce("D:\\tmp\\private.json"),
    );

    // Then the worker process is reaped
    expect(worker.killCount()).toBe(1);
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
        await runWithAccess({ platform: "win32", env: process.env }, async (access) => {
          await access.enforce(path);
          await access.verify(path);
        });

        // Then the fixed PowerShell verifier completed successfully
        expect(await Bun.file(path).exists()).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.skipIf(process.platform !== "win32")(
    "rejects a native Windows file after its owner-only DACL is widened",
    async () => {
      // Given a natively enforced private file whose DACL is then widened to Everyone read access
      const dir = await mkdtemp(join(tmpdir(), "lando-private-acl-tamper-"));
      const path = join(dir, "private file.json");
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      try {
        await runWithAccess({ platform: "win32", env: process.env }, async (access) => {
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
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
