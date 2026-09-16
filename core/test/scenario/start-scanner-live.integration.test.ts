import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Exit, Fiber, Schema } from "effect";

import {
  liveEnabled,
  recordedRequest,
  scannerFixture,
  startCli,
  waitForFile,
} from "./scanner-live-fixture.ts";

const envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.Struct({
    servicesStarted: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        state: Schema.String,
        endpoints: Schema.Array(Schema.String),
      }),
    ),
  }),
});
const warning = Schema.Struct({ payload: Schema.Struct({ body: Schema.String }) });

describe.serial("live start scanner", () => {
  for (const path of ["/scan", "/fail"] as const) {
    test.skipIf(!liveEnabled)(
      path === "/scan" ? "scanner-live-published" : "scanner-live-warn",
      async () => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              // Given: isolated real compose responder with an OS-selected host port.
              const fixture = yield* scannerFixture(path);
              const closed = yield* waitForFile(fixture.root, "closed");
              // When: the actual native CLI dispatches lando start.
              const cli = yield* startCli(fixture.root);
              // Then: the scanner called exactly the published authority and start succeeded.
              expect(cli.exitCode).toBe(0);
              const json = cli.stdout.split("\n").find((line) => line.startsWith('{"_tag":"result"'));
              const result = Schema.decodeUnknownSync(Schema.parseJson(Schema.Struct({ envelope })))(
                json,
              ).envelope;
              expect(result.ok).toBe(true);
              const url = result.result.servicesStarted[0]?.endpoints[0];
              if (url === undefined) return yield* Effect.dieMessage("start published no URL");
              const request = yield* recordedRequest(fixture.root);
              expect(request).toEqual({ host: new URL(url).host, path, method: "GET" });
              const warningLine = cli.stdout
                .split("\n")
                .find((line) => line.startsWith('{"_tag":"event","event":"message.warn"'));
              expect(warningLine !== undefined).toBe(path === "/fail");
              if (warningLine !== undefined) {
                const body = Schema.decodeUnknownSync(Schema.parseJson(warning))(warningLine).payload.body;
                expect(body).toContain(`${url}/fail`);
                expect(body).toContain("503");
              }
              const independent = yield* Effect.promise(() =>
                fetch(new URL("/independent", url), { signal: AbortSignal.timeout(5000) }),
              );
              expect(yield* Effect.promise(() => independent.text())).toBe("published-responder");
              yield* closed.pipe(Effect.timeout("5 seconds"));
              expect(yield* Effect.promise(() => readFile(join(fixture.root, "closed"), "utf8"))).toBe(
                "closed",
              );
              console.log(
                "SCANNER_EVIDENCE",
                JSON.stringify({ id: path, url, request, warning: warningLine }),
              );
            }),
          ).pipe(Effect.timeout("120 seconds")),
        );
      },
      130_000,
    );
  }

  test.skipIf(!liveEnabled)(
    "scanner-live-interrupt",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Given: the same real start operation, with a responder withholding headers.
            const fixture = yield* scannerFixture("/hang");
            const arrived = yield* waitForFile(fixture.root, "active.json");
            const closed = yield* waitForFile(fixture.root, "closed");
            const start = yield* Effect.forkScoped(fixture.app.start());
            yield* arrived.pipe(Effect.timeout("90 seconds"));
            const request = yield* recordedRequest(fixture.root);
            expect(request.path).toBe("/hang");
            const independent = yield* Effect.promise(() =>
              fetch(`http://${request.host}/independent`, { signal: AbortSignal.timeout(5000) }),
            );
            expect(yield* Effect.promise(() => independent.text())).toBe("published-responder");
            // When: interrupt only after the container observes the in-flight scanner GET.
            const exit = yield* Fiber.interrupt(start);
            // Then: interruption propagates rather than becoming a successful warning.
            expect(Exit.isInterrupted(exit)).toBe(true);
            yield* closed.pipe(Effect.timeout("5 seconds"));
            console.log(
              "SCANNER_INTERRUPTED",
              JSON.stringify({ request, interrupted: Exit.isInterrupted(exit), streamClosed: true }),
            );
          }),
        ).pipe(Effect.timeout("120 seconds")),
      );
    },
    130_000,
  );
});
