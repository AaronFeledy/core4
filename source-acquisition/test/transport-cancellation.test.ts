import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ProcessExecError } from "@lando/sdk/errors";
import type { ProcessResult, ProcessSpawnOptions } from "@lando/sdk/services";
import { Effect, Fiber } from "effect";
import { makeGitTransport } from "../src/git.ts";
import { disposeTestSourceStore, makeTestSourceStore, withTestSession } from "../src/testing.ts";

const FULL_SHA = "a".repeat(40);

describe("transport cancellation signal forwarding", () => {
  test("archive fetch settles only when the transport signal aborts and releases staging/leases", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const settled = Promise.withResolvers<"aborted" | "resolved">();
    const fixture = await makeTestSourceStore({
      archive: {
        fetch: async (_url, options) => {
          const signal = options?.signal;
          if (signal === undefined) throw new Error("archive transport expected AbortSignal");
          entered.resolve(signal);
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              settled.resolve("aborted");
              reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                settled.resolve("aborted");
                reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
              },
              { once: true },
            );
          });
          settled.resolve("resolved");
          return new Uint8Array();
        },
      },
    });
    try {
      const fiber = Effect.runFork(
        withTestSession(fixture.store, (session) =>
          session.acquireArchive({ url: "https://example.test/hang.tgz" }),
        ),
      );
      const signal = await Effect.runPromise(
        Effect.promise(() => entered.promise).pipe(Effect.timeout("500 millis")),
      );
      expect(signal.aborted).toBe(false);
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.timeout("500 millis")));
      expect(
        await Effect.runPromise(Effect.promise(() => settled.promise).pipe(Effect.timeout("500 millis"))),
      ).toBe("aborted");
      expect(signal.aborted).toBe(true);
      expect(await readdir(join(fixture.root, ".leases"))).toEqual([]);
      expect((await readdir(fixture.root)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
    } finally {
      await disposeTestSourceStore(fixture);
    }
  });

  test("git fetch receives the fiber AbortSignal and ProcessRunner observes abortion", async () => {
    const observed: AbortSignal[] = [];
    const entered = Promise.withResolvers<void>();
    const hang = Promise.withResolvers<void>();
    const runner = {
      run: (options: ProcessSpawnOptions) => {
        if (options.signal === undefined) {
          return Effect.fail(
            new ProcessExecError({
              message: "git transport must forward AbortSignal",
              cmd: options.cmd,
              remediation: "Pass signal through makeGitTransport.",
            }),
          );
        }
        observed.push(options.signal);
        entered.resolve();
        return Effect.tryPromise({
          try: async (fiberSignal) => {
            const signal =
              options.signal === undefined ? fiberSignal : AbortSignal.any([options.signal, fiberSignal]);
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) {
                hang.resolve();
                reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
                return;
              }
              signal.addEventListener(
                "abort",
                () => {
                  hang.resolve();
                  reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
                },
                { once: true },
              );
            });
            return { exitCode: 0, stdout: FULL_SHA, stderr: "" } satisfies ProcessResult;
          },
          catch: (cause) =>
            new ProcessExecError({
              message: cause instanceof Error ? cause.message : String(cause),
              cmd: options.cmd,
              remediation: "Ensure the host command is installed and reachable from PATH.",
              cause,
            }),
        });
      },
      stream: () => {
        throw new Error("unused");
      },
      streamWithExit: () => {
        throw new Error("unused");
      },
    };
    const transport = makeGitTransport(runner);
    const controller = new AbortController();
    const running = transport
      .fetch({
        url: "https://example.test/r.git",
        ref: "main",
        dest: "/tmp/lando-git-signal-unused",
        signal: controller.signal,
      })
      .then(
        () => ({ status: "success" as const }),
        (cause: unknown) => ({ status: "failure" as const, cause }),
      );
    await Effect.runPromise(Effect.promise(() => entered.promise).pipe(Effect.timeout("500 millis")));
    expect(observed[0]?.aborted).toBe(false);
    controller.abort();
    expect(await running).toMatchObject({ status: "failure" });
    await Effect.runPromise(Effect.promise(() => hang.promise).pipe(Effect.timeout("500 millis")));
    expect(observed[0]?.aborted).toBe(true);
  });

  test("session git acquisition aborts the transport signal on fiber interrupt", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const settled = Promise.withResolvers<"aborted" | "resolved">();
    const fixture = await makeTestSourceStore({
      git: {
        fetch: async (input) => {
          const signal = input.signal;
          if (signal === undefined) throw new Error("git transport expected AbortSignal");
          entered.resolve(signal);
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              settled.resolve("aborted");
              reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                settled.resolve("aborted");
                reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
              },
              { once: true },
            );
          });
          settled.resolve("resolved");
          return { commit: FULL_SHA };
        },
      },
    });
    try {
      const fiber = Effect.runFork(
        withTestSession(fixture.store, (session) =>
          session.acquireGit({ url: "https://example.test/r.git", ref: "main" }),
        ),
      );
      const signal = await Effect.runPromise(
        Effect.promise(() => entered.promise).pipe(Effect.timeout("500 millis")),
      );
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.timeout("500 millis")));
      expect(
        await Effect.runPromise(Effect.promise(() => settled.promise).pipe(Effect.timeout("500 millis"))),
      ).toBe("aborted");
      expect(signal.aborted).toBe(true);
      expect(await readdir(join(fixture.root, ".leases"))).toEqual([]);
      expect((await readdir(fixture.root)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
    } finally {
      await disposeTestSourceStore(fixture);
    }
  });
});
