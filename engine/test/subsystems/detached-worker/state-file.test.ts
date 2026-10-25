import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { withDetachedWorkerLock } from "../../../src/subsystems/detached-worker/state-file.ts";

test("a separate process waits when the holder removes its worker run directory", async () => {
  // Given a worker lock held in this process and a contender in a separate process.
  const root = await mkdtemp(join(tmpdir(), "lando-worker-lock-"));
  const path = join(root, "run", "demo", "worker.json");
  const firstMessage = Promise.withResolvers<unknown>();
  const messages: unknown[] = [];
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  await mkdir(dirname(path), { recursive: true });
  try {
    // When the holder removes its run directory before the contender acquires.
    await Effect.runPromise(
      withDetachedWorkerLock(
        {
          path,
          label: "host-proxy-worker",
          paths: { userDataRoot: root },
          privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
        },
        Effect.promise(async () => {
          await rm(dirname(path), { recursive: true, force: true });
          child = Bun.spawn(
            [process.execPath, join(import.meta.dir, "fixtures", "lock-contender.ts"), path, root],
            {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              ipc: (message: unknown) => {
                messages.push(message);
                firstMessage.resolve(message);
              },
            },
          );
          expect(await Promise.race([firstMessage.promise, child.exited.then(() => "exited")])).toBe("held");
        }),
      ),
    );
    if (child === undefined) throw new TypeError("Contender was not started");
    const exitCode = await child.exited;
    // Then it observes contention before entering only after the holder releases.
    expect(exitCode).toBe(0);
    expect(messages[0]).toBe("held");
    expect(child.stdout).not.toBeNull();
    expect(await new Response(child.stdout).text()).toBe("entered\n");
  } finally {
    child?.kill();
    if (child !== undefined) await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
