import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventService, type LandoEvent, ShellRunner } from "@lando/sdk/services";
import { Effect, Layer, Queue, Stream } from "effect";
import * as BunShellRunner from "../../src/services/shell-runner.ts";
import { testRedactionLayer } from "../redaction.ts";

test.each(["exec", "run", "runScript"] as const)(
  "%s shares its invocation snapshot with the child and event redactor",
  async (method) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-shell-invocation-"));
    const parentKey = "LANDO_HOST_CONTEXT_TEST_TOKEN";
    const previous = process.env[parentKey];
    const originalSecret = "original-invocation-secret";
    const lateSecret = "late-subscriber-secret";
    process.env[parentKey] = originalSecret;
    const env: Record<string, string> = { CALLER_VALUE: "original-caller" };
    const argv = ["original-arg"];
    const events: LandoEvent[] = [];
    const eventLayer = Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
            if (event._tag === "pre-shell-exec") {
              env.CALLER_VALUE = "late-caller";
              env.PWD = "late-caller-pwd";
              argv[0] = "late-arg";
              process.env[parentKey] = lateSecret;
            }
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<never>(),
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    );
    try {
      const cwd = await realpath(root);
      const script = join(root, "snapshot.bun.sh");
      await writeFile(script, `printf '%s|%s|%s|%s' "$CALLER_VALUE" "$${parentKey}" "$PWD" "$1"`);
      const command = `printf '%s|%s|%s|' "$CALLER_VALUE" "$${parentKey}" "$PWD"; printf '%s'`;
      // When
      const result = await Effect.runPromise(
        Effect.flatMap(ShellRunner, (shell) =>
          shell[method](method === "runScript" ? script : command, { cwd: root, env, argv }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              BunShellRunner.layer(() => {
                throw new TypeError("unused interactive IO");
              }),
              eventLayer,
              testRedactionLayer([]),
            ),
          ),
        ),
      );
      // Then
      const post = events.find((event) => event._tag === "post-shell-exec");
      expect(JSON.stringify(post)).not.toContain(lateSecret);
      expect(result.stdout).toBe(`original-caller|${originalSecret}|${cwd}|original-arg`);
      expect(post?.stdout).toBe(`original-caller|[redacted]|${cwd}|original-arg`);
      expect(post?.env).toEqual({ CALLER_VALUE: "original-caller" });
    } finally {
      if (previous === undefined) delete process.env[parentKey];
      else process.env[parentKey] = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
