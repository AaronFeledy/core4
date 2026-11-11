import { describe, expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import type { LandoEvent } from "@lando/sdk/services";
import { EventService, ProcessRunner, ShellRunner } from "@lando/sdk/services";
import { type Context, Effect, Layer, Queue, Stream } from "effect";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import { type ShellRedactionCarrier, withShellRedactionTokens } from "../../src/services/shell-runner.ts";
import * as BunShellRunner from "../shell-runner.ts";

const shellLayer = Layer.mergeAll(
  BunShellRunner.layer(() => {
    throw new TypeError("Unexpected interactive shell");
  }),
  Layer.succeed(RedactionService, makeRedactionService()),
);

const captureEventsLayer = (events: LandoEvent[]) =>
  Layer.succeed(
    EventService,
    EventService.of({
      publish: (event: LandoEvent) => Effect.sync(() => events.push(event)),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<never>(),
      waitFor: () => Effect.never,
      subscribeWithHistory: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    } satisfies Context.Service.Shape<typeof EventService>),
  );

const shellFailStdout = (carrier: ShellRedactionCarrier, script: string, env?: Record<string, string>) =>
  withShellRedactionTokens(
    carrier,
    Effect.flatMap(ShellRunner, (shell) =>
      shell.exec(`${script}; exit 7`, env === undefined ? undefined : { env }),
    ).pipe(
      Effect.flip,
      Effect.map((error) => error.stdout ?? ""),
    ),
  ).pipe(Effect.provide(shellLayer));

describe("shell/process redaction carriers", () => {
  test("committed bytes stay whole-token; compound identifier is not masked", async () => {
    // Given
    const secret = "wordpress";
    // When
    const stdout = await Effect.runPromise(
      shellFailStdout(
        { substring: [], wholeToken: new Set([secret]) },
        `printf 'PASSWORD=%s\\n%s\\n' "$DB_PASSWORD" "wordpress-seo"`,
        { DB_PASSWORD: secret },
      ),
    );
    // Then
    expect(stdout).toBe("PASSWORD=[redacted]\nwordpress-seo\n");
  });

  test("same bytes under a different secret key stay whole-token", async () => {
    // Given
    const secret = "wordpress";
    // When
    const stdout = await Effect.runPromise(
      shellFailStdout({ substring: [], wholeToken: new Set([secret]) }, `printf 'x=%s-seo' "$API_TOKEN"`, {
        API_TOKEN: secret,
      }),
    );
    // Then
    expect(stdout).toBe("x=wordpress-seo");
  });

  test("same key with a different value stays substring", async () => {
    // Given
    const override = "override-secret-value";
    // When
    const stdout = await Effect.runPromise(
      shellFailStdout(
        { substring: [], wholeToken: new Set(["wordpress"]) },
        `printf 'x=%s-tail' "$DB_PASSWORD"`,
        { DB_PASSWORD: override },
      ),
    );
    // Then
    expect(stdout).toBe("x=[redacted]-tail");
  });

  test("explicit substring carrier overrides dominate committed whole-token bytes", async () => {
    // Given
    const secret = "wordpress";
    // When
    const stdout = await Effect.runPromise(
      shellFailStdout(
        { substring: [secret], wholeToken: new Set([secret]) },
        `printf 'x=%s-tail' "$DB_PASSWORD"`,
        { DB_PASSWORD: secret },
      ),
    );
    // Then
    expect(stdout).toBe("x=[redacted]-tail");
  });

  test("host-inherited env coincident with committed bytes stays substring", async () => {
    // Given — secret only on the host, not as an explicit caller override
    const secret = "wordpress";
    const key = "LANDO_TEST_HOST_CARRIER_PASSWORD";
    const previous = process.env[key];
    process.env[key] = secret;
    try {
      // When
      const stdout = await Effect.runPromise(
        shellFailStdout({ substring: [], wholeToken: new Set([secret]) }, `printf '%s-seo' "$${key}"`),
      );
      // Then — host never weakens to whole-token
      expect(stdout).toBe("[redacted]-seo");
    } finally {
      if (previous === undefined) process.env[key] = undefined;
      else process.env[key] = previous;
    }
  });

  test("process runner committed env classifies through process events", async () => {
    // Given
    const secret = "wordpress";
    const events: LandoEvent[] = [];
    const layer = Layer.mergeAll(
      BunProcessRunner.layer,
      Layer.succeed(RedactionService, makeRedactionService()),
      captureEventsLayer(events),
    );
    // When
    await Effect.runPromise(
      BunProcessRunner.withProcessRedactionTokens(
        { substring: [], wholeToken: new Set([secret]) },
        Effect.flatMap(ProcessRunner, (runner) =>
          runner.run({
            cmd: "sh",
            args: ["-c", "printf ok"],
            env: { DB_PASSWORD: secret },
          }),
        ),
      ).pipe(Effect.provide(layer)),
    );
    // Then
    const payload = JSON.stringify(events);
    expect(payload).not.toContain(secret);
    expect(payload).toContain("[redacted]");
  });
});
