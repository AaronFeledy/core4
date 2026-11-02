import { expect, test } from "bun:test";
import { closeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeRedactionService } from "@lando/redaction/service";
import { Effect } from "effect";
import { openWorkerLog, stderrTailFromLog } from "../../../src/subsystems/detached-worker/log.ts";
import { ownerOnlyFileAccess } from "../../private-file-access.ts";

test.each([33, 70 * 1024])("redacts a %s-character secret before clipping the log tail", async (length) => {
  // Given a secret spanning the final tail boundary, including one larger than a read window.
  const root = await mkdtemp(join(tmpdir(), "worker-redacted-tail-"));
  const logPath = join(root, "worker.log");
  const secret = `registered-worker-${"s".repeat(length)}-credential-unique`;
  const redaction = makeRedactionService();
  await Effect.runPromise(redaction.registerValues([secret]));
  const redactor = await Effect.runPromise(redaction.forProfile("secrets"));
  await writeFile(logPath, `${secret}${"x".repeat(4040)}\n${secret}`);
  try {
    // When the complete log is projected into a diagnostic tail.
    const tail = await stderrTailFromLog(logPath, redactor);
    // Then neither a whole credential nor a clipped suffix escapes.
    expect(tail).not.toContain(secret);
    expect(tail).not.toContain("credential-unique");
    expect(tail).toContain("[redacted]");
    expect(tail.length).toBeLessThanOrEqual(4096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([5 * 1024, 80 * 1024])(
  "suppresses a multiline secret crossing the tail or read boundary (%s characters)",
  async (length) => {
    // Given a registered multiline value whose suffix falls inside the tail.
    const root = await mkdtemp(join(tmpdir(), "worker-multiline-tail-"));
    const logPath = join(root, "worker.log");
    const secret = `private-prefix\n${"s".repeat(length)}\ncredential-suffix-unique`;
    const redaction = makeRedactionService();
    await Effect.runPromise(redaction.registerValues([secret]));
    const redactor = await Effect.runPromise(redaction.forProfile("secrets"));
    await writeFile(logPath, `earlier output\n${secret}\npublic diagnostic\n`);
    try {
      // When the log is projected through its diagnostic surface.
      const tail = await stderrTailFromLog(logPath, redactor);
      // Then neither multiline suffix nor partial secret content is exposed.
      expect(tail).not.toContain("credential-suffix-unique");
      expect(tail).not.toContain("ssss");
      expect(tail).toContain("[redacted]");
      expect(tail.length).toBeLessThanOrEqual(4096);
      if (length < 64 * 1024) expect(tail).toContain("public diagnostic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each([false, true])(
  "secures new and existing logs (existing=%s)",
  async (existing) => {
    const root = await mkdtemp(join(tmpdir(), "worker-private-log-"));
    const logsDir = join(root, "logs");
    const logPath = join(logsDir, "worker.log");
    if (existing) {
      await mkdir(logsDir);
      await writeFile(logPath, "prior log\n");
      await chmod(logPath, 0o644);
    }
    try {
      const fd = await openWorkerLog(logsDir, logPath, ownerOnlyFileAccess);
      closeSync(fd);
      expect((await stat(logPath)).mode & 0o777).toBe(0o600);
      if (!existing) expect((await stat(logsDir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "rejects symlinked and non-regular worker log targets",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-log-symlink-"));
    const logPath = join(root, "worker.log");
    const target = join(root, "target");
    await writeFile(target, "untouched");
    await symlink(target, logPath);
    try {
      await expect(openWorkerLog(root, logPath, ownerOnlyFileAccess)).rejects.toMatchObject({
        name: "DetachedWorkerLogError",
        logPath,
      });
      expect(await Bun.file(target).text()).toBe("untouched");
      await rm(logPath);
      await mkdir(logPath);
      await expect(openWorkerLog(root, logPath, ownerOnlyFileAccess)).rejects.toMatchObject({
        name: "DetachedWorkerLogError",
        logPath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("worker diagnostics remain bounded structured records in an owner-only log", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-diagnostic-log-"));
  const path = join(root, "worker.log");
  const fd = await openWorkerLog(root, path, ownerOnlyFileAccess);
  try {
    const module = resolve(import.meta.dir, "../../../src/subsystems/detached-worker/log.ts");
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {writeWorkerDiagnostic} from ${JSON.stringify(module)}; for(let i=0;i<15000;i++) writeWorkerDiagnostic({callId:"call-"+i,operation:"runLando",outcome:"HostProxyAuthenticationError",durationMs:0,exitCode:1});`,
      ],
      { stderr: fd, stdout: "ignore" },
    );
    expect(await proc.exited).toBe(0);
    const file = Bun.file(path);
    expect(file.size).toBeLessThan(1024 * 1024 + 256);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const lines = (await file.text()).trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.length).toBeLessThan(256);
      expect(Object.keys(JSON.parse(line)).sort()).toEqual([
        "callId",
        "durationMs",
        "exitCode",
        "operation",
        "outcome",
      ]);
    }
  } finally {
    closeSync(fd);
    await rm(root, { recursive: true, force: true });
  }
});
