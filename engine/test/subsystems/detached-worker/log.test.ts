import { expect, test } from "bun:test";
import { closeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRedactionValues } from "@lando/redaction/service";
import { Effect } from "effect";
import { openWorkerLog, stderrTailFromLog } from "../../../src/subsystems/detached-worker/log.ts";
import { ownerOnlyFileAccess } from "../../private-file-access.ts";

test.each([33, 70 * 1024])("redacts a %s-character secret before clipping the log tail", async (length) => {
  // Given a secret spanning the final tail boundary, including one larger than a read window.
  const root = await mkdtemp(join(tmpdir(), "worker-redacted-tail-"));
  const logPath = join(root, "worker.log");
  const secret = `registered-worker-${"s".repeat(length)}-credential-unique`;
  await Effect.runPromise(registerRedactionValues([secret]));
  await writeFile(logPath, `${secret}${"x".repeat(4040)}\n${secret}`);
  try {
    // When the complete log is projected into a diagnostic tail.
    const tail = await stderrTailFromLog(logPath);
    // Then neither a whole credential nor a clipped suffix escapes.
    expect(tail).not.toContain(secret);
    expect(tail).not.toContain("credential-unique");
    expect(tail).toContain("[redacted]");
    expect(tail.length).toBeLessThanOrEqual(4096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
