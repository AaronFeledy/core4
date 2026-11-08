import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Stream } from "effect";
import { execCancellationFixture as fixture, liveExecHost as host } from "./exec-cancellation-fixture.ts";

describe.skipIf(host === undefined)("Mounted helper non-TTY exec (Docker-compatible engine)", () => {
  test("one exec-run preserves binary stdin, logical EOF and exit status", async () => {
    const f = await fixture("1000:1000");
    try {
      const payload = new Uint8Array([0, 255, 195, 169, 10, 1, 0]);
      const chunks = await Effect.runPromise(
        Effect.scoped(
          Stream.runCollect(
            f.provider.execStream(f.target, {
              command: ["sh", "-c", "cat; exit 23"],
              stdinStream: {
                async *[Symbol.asyncIterator]() {
                  yield payload;
                },
              },
            }),
          ),
        ),
      );
      expect(
        Buffer.concat(
          chunks.flatMap((chunk) => ("exitCode" in chunk || chunk.kind !== "stdout" ? [] : [chunk.chunk])),
        ),
      ).toEqual(Buffer.from(payload));
      expect(chunks.filter((chunk) => "exitCode" in chunk)).toEqual([{ exitCode: 23 }]);
      expect(f.commands).toEqual([
        [
          "/run/lando/helper/lando-container-helper",
          "exec-run",
          "--nonce",
          expect.stringMatching(/^[a-f0-9]{32}$/u),
          "--umask",
          "0022",
          "--",
          "sh",
          "-c",
          "cat; exit 23",
        ],
      ]);
    } finally {
      await f.close();
    }
  }, 30_000);

  for (const user of [undefined, "1000:1000"]) {
    test.each(["SIGINT", "SIGTERM"])(
      `joins escaped descendants on %s (${user ?? "root"})`,
      async (signal) => {
        const f = await fixture(user);
        try {
          const abort = new AbortController();
          let cancelledAt: number | undefined;
          const exit = await Effect.runPromiseExit(
            Effect.scoped(
              Stream.runForEach(
                f.provider.execStream(f.target, {
                  command: [
                    "sh",
                    "-c",
                    "setsid sh -c 'trap \"echo TERM >/tmp/received; exit 0\" TERM; echo $$ >/tmp/child; while :; do sleep 0.01; done' & trap '' INT TERM; echo $$ >/tmp/main; while [ ! -s /tmp/child ]; do sleep 0.01; done; echo ready; wait",
                  ],
                  signal: abort.signal,
                }),
                (chunk) =>
                  Effect.sync(() => {
                    if (!("exitCode" in chunk) && new TextDecoder().decode(chunk.chunk).includes("ready")) {
                      cancelledAt = performance.now();
                      abort.abort(signal);
                    }
                  }),
              ),
            ),
          );
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          if (cancelledAt === undefined) throw new Error("Command never became ready");
          expect(performance.now() - cancelledAt).toBeLessThan(6000);
          await f.inside([
            "sh",
            "-c",
            "test ! -e /proc/$(cat /tmp/main) && test ! -e /proc/$(cat /tmp/child)",
          ]);
          if (signal === "SIGTERM") expect(await f.inside(["cat", "/tmp/received"])).toBe("TERM");
        } finally {
          await f.close();
        }
      },
      30_000,
    );
  }

  test("raw attach disconnect kills and joins the owned tree", async () => {
    const f = await fixture();
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Stream.runForEach(
            f.provider.execStream(f.target, {
              command: [
                "sh",
                "-c",
                "echo $$ >/tmp/main; trap '' TERM; echo ready; while :; do sleep 1; done",
              ],
            }),
            (chunk) =>
              Effect.sync(() => {
                if (!("exitCode" in chunk) && new TextDecoder().decode(chunk.chunk).includes("ready"))
                  f.disconnect();
              }),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      await f.inside(["sh", "-c", "test ! -e /proc/$(cat /tmp/main)"]);
    } finally {
      await f.close();
    }
  }, 30_000);

  test("normal exit preserves a background child and status", async () => {
    const f = await fixture();
    try {
      const result = await Effect.runPromise(
        f.provider.exec(f.target, {
          command: ["sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $! >/tmp/background; exit 7"],
        }),
      );
      expect(result.exitCode).toBe(7);
      await f.inside(["sh", "-c", "kill -0 $(cat /tmp/background)"]);
    } finally {
      await f.close();
    }
  }, 30_000);

  test("umask compensation preserves direct 127/126 and file mode", async () => {
    const f = await fixture();
    try {
      await f.inside(["sh", "-c", "printf 'exit 0\n' >/tmp/text; chmod 755 /tmp/text"]);
      for (const [program, exitCode, message] of [
        ["lando-no-such-command", 127, "command not found"],
        ["/tmp/text", 126, "cannot execute"],
      ] as const) {
        expect(await Effect.runPromise(f.provider.exec(f.target, { command: [program] }))).toEqual({
          exitCode,
          stdout: "",
          stderr: `lando: ${program}: ${message}\n`,
        });
      }
      const mode = await Effect.runPromise(
        f.provider.exec(f.target, { command: ["sh", "-c", ": >/tmp/created; stat -c %a /tmp/created"] }),
      );
      expect(mode).toEqual({ exitCode: 0, stdout: "644\n", stderr: "" });
    } finally {
      await f.close();
    }
  }, 30_000);
});
