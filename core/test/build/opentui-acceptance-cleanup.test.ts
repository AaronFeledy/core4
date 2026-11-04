import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAcceptanceRoot, withAcceptanceCleanup } from "./fixtures/opentui-acceptance-cleanup.ts";

for (const code of ["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]) {
  test(`Windows acceptance cleanup retries transient ${code} and requires removal`, async () => {
    let attempts = 0;
    const waits: number[] = [];
    await removeAcceptanceRoot("owned-root", {
      platform: "win32",
      remove: async () => {
        if (attempts++ < 2) throw Object.assign(new Error(code), { code });
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 250]);
  });
}

test("Windows acceptance cleanup rejects a persistent lock after its bounded attempts", async () => {
  const failure = Object.assign(new Error("still locked"), { code: "EBUSY" });
  let attempts = 0;
  let waits = 0;
  await expect(
    removeAcceptanceRoot("owned-root", {
      platform: "win32",
      remove: async () => {
        attempts++;
        throw failure;
      },
      wait: async () => {
        waits++;
      },
    }),
  ).rejects.toBe(failure);
  expect(attempts).toBe(20);
  expect(waits).toBe(19);
});

for (const [platform, code] of [
  ["linux", "EBUSY"],
  ["win32", "EINVAL"],
] as const) {
  test(`acceptance cleanup propagates ${platform}/${code} without retry`, async () => {
    const failure = Object.assign(new Error(code), { code });
    let attempts = 0;
    await expect(
      removeAcceptanceRoot("owned-root", {
        platform,
        remove: async () => {
          attempts++;
          throw failure;
        },
        wait: async () => {
          throw new Error("Unexpected retry");
        },
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
}

test("acceptance cleanup preserves the assertion failure and both cleanup errors", async () => {
  const assertion = new Error("renderer assertion");
  const cleanup = new Error("cleanup locked");
  const roots: string[] = [];
  const result = await withAcceptanceCleanup(
    ["app-root", "binary-root"],
    async () => {
      throw assertion;
    },
    async (root) => {
      roots.push(root);
      throw cleanup;
    },
  ).then(
    () => undefined,
    (error) => error,
  );
  expect(roots).toEqual(["app-root", "binary-root"]);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors).toEqual([assertion, cleanup, cleanup]);
});

test("successful acceptance still rejects a cleanup failure", async () => {
  const failure = new Error("cleanup failure");
  await expect(
    withAcceptanceCleanup(
      ["owned-root"],
      async () => "passed",
      async () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
});

test("synchronous cleanup throws preserve the assertion and still attempt both roots", async () => {
  const assertion = new Error("renderer assertion");
  const cleanup = new Error("synchronous cleanup failure");
  const roots: string[] = [];
  const result = await withAcceptanceCleanup(
    ["app-root", "binary-root"],
    async () => {
      throw assertion;
    },
    (root) => {
      roots.push(root);
      throw cleanup;
    },
  ).then(
    () => undefined,
    (error) => error,
  );
  expect(roots).toEqual(["app-root", "binary-root"]);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors).toEqual([assertion, cleanup, cleanup]);
});

test("successful cleanup preserves the original assertion failure", async () => {
  const failure = new Error("renderer assertion");
  await expect(
    withAcceptanceCleanup(
      ["owned-root"],
      async () => {
        throw failure;
      },
      async () => {},
    ),
  ).rejects.toBe(failure);
});

const withOwnedCwdLock = async (
  run: (root: string, released: Promise<PromiseSettledResult<number>[]>) => Promise<void>,
  settled: string[],
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-opentui-owned-lock-"));
  let cleanup = () => removeAcceptanceRoot(root);
  await withAcceptanceCleanup(
    [root],
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          'console.log("READY"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0))',
        ],
        {
          cwd: root,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const reader = child.stdout.getReader();
      const pending: {
        stdin?: Promise<void>;
        stdout?: Promise<PromiseSettledResult<void>[]>;
        release?: Promise<PromiseSettledResult<number>[]>;
      } = {};
      const closeStdin = () => {
        pending.stdin ??= Promise.resolve().then(async () => {
          await child.stdin.end();
        });
        return pending.stdin;
      };
      const drainStdout = async () => {
        while (!(await reader.read()).done) {}
      };
      const stderr = Promise.allSettled([new Response(child.stderr).text()]);
      cleanup = async () => {
        const processResults = await Promise.allSettled([closeStdin(), child.exited]);
        pending.stdout ??= Promise.allSettled([drainStdout()]);
        const streamResults = [...(await pending.stdout), ...(await stderr)];
        const releaseResults = pending.release === undefined ? [] : await pending.release;
        const readerResults = await Promise.allSettled([Promise.resolve().then(() => reader.releaseLock())]);
        const removalResults = await Promise.allSettled([removeAcceptanceRoot(root)]);
        const errors = [
          ...processResults,
          ...streamResults,
          ...releaseResults,
          ...readerResults,
          ...removalResults,
        ].flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (child.exitCode !== 0) errors.push(new Error(`Owned child exited with ${child.exitCode}`));
        if (errors.length > 0) throw new AggregateError(errors, "Owned cwd fixture cleanup failed");
        settled.push(
          "stdin closed",
          "child exited",
          "stdout settled",
          "stderr settled",
          "release settled",
          "reader unlocked",
          "root removed",
        );
      };
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("READY");
      await expect(rm(root, { recursive: true, force: true })).rejects.toMatchObject({ code: "EBUSY" });
      pending.stdout = Promise.allSettled([drainStdout()]);
      pending.release = Promise.allSettled([
        (async () => {
          await Bun.sleep(100);
          await closeStdin();
          return await child.exited;
        })(),
      ]);
      await run(root, pending.release);
    },
    () => cleanup(),
  );
};

test.skipIf(process.platform !== "win32")(
  "Windows cleanup removes an owned cwd after its child releases the handle",
  async () => {
    const settled: string[] = [];
    await withOwnedCwdLock(async (root, release) => {
      await removeAcceptanceRoot(root);
      expect(await release).toEqual([{ status: "fulfilled", value: 0 }]);
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    }, settled);
    expect(settled).toContain("reader unlocked");
  },
  10_000,
);

test.skipIf(process.platform !== "win32")(
  "owned cwd fixture settles child, readers and delayed release after an early assertion failure",
  async () => {
    const assertion = new Error("early assertion failure");
    const settled: string[] = [];
    await expect(
      withOwnedCwdLock(async () => {
        throw assertion;
      }, settled),
    ).rejects.toBe(assertion);
    expect(settled).toEqual([
      "stdin closed",
      "child exited",
      "stdout settled",
      "stderr settled",
      "release settled",
      "reader unlocked",
      "root removed",
    ]);
  },
  10_000,
);
