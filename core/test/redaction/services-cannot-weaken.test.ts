import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Queue, Stream } from "effect";

import { FileSyncStartError, SecretNotFoundError, ShellExecError } from "@lando/sdk/errors";
import { EventService, type LandoEvent, SecretStore, ShellRunner } from "@lando/sdk/services";
import { SECRET_SOUP_FIXTURE } from "@lando/sdk/test";

import { type BunSelfSpawner, bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { redactDetails, redactString } from "../../src/cli/redact.ts";
import {
  type DownloaderEvents,
  makeDownloaderService,
  makeLiveDownloaderEvents,
} from "../../src/downloader/service.ts";
import type { HttpClientShape } from "../../src/http-client/service.ts";
import { RedactionServiceLive } from "../../src/redaction/service.ts";
import { ShellRunnerLive } from "../../src/services/shell-runner.ts";
import { HostProxyServiceDisabled } from "../../src/subsystems/host-proxy/api.ts";

/**
 * These assertions target each surface's shipped redaction point:
 * ShellRunner and BunSelfRunner redact emitted events through RedactionServiceLive;
 * ShellRunner also redacts ShellExecError fields before failing; Downloader
 * redacts lifecycle events at its DownloaderEvents seam; HostProxyServiceDisabled
 * emits only static status fields while host-proxy diagnostics use the CLI
 * redaction helpers; FileSyncEngine errors are redacted only at the CLI
 * formatting boundary, not inside the engine.
 */

const REGISTERED_SECRET = SECRET_SOUP_FIXTURE.registeredSecrets[0] ?? "hunter2longvalue";
const UNREGISTERED_BEARER = "Bearer landoUnregisteredBearerToken";
const VALUE_AND_PATTERN_SOUP = `${SECRET_SOUP_FIXTURE.text} Authorization: ${UNREGISTERED_BEARER}`;
const PATTERN_SOUP = `${SECRET_SOUP_FIXTURE.text.replace("superSecretTokenLongerSuffix", "")} Authorization: ${UNREGISTERED_BEARER}`;
const CANONICAL_SENTINEL = "[redacted]";
const LEGACY_SENTINEL = "[REDACTED]";

const secretStoreLayer = Layer.succeed(SecretStore, {
  id: "redaction-proof-secrets",
  get: (secret: string) => {
    const index = Number(secret.replace("SECRET_", ""));
    const value = SECRET_SOUP_FIXTURE.registeredSecrets[index];
    return value === undefined
      ? Effect.fail(new SecretNotFoundError({ secret, message: `missing ${secret}` }))
      : Effect.succeed(value);
  },
  has: (secret: string) => Effect.succeed(/^SECRET_\d+$/u.test(secret)),
  list: Effect.succeed(SECRET_SOUP_FIXTURE.registeredSecrets.map((_value, index) => `SECRET_${index}`)),
} satisfies SecretStore.Service);

const realRedactionLayer = RedactionServiceLive.pipe(Layer.provide(secretStoreLayer));

const captureEventLayer = (events: LandoEvent[]) =>
  Layer.succeed(EventService, {
    publish: (event) => Effect.sync(() => void events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.never,
  } satisfies EventService.Service);

const capturingDownloaderEvents = (): {
  readonly events: DownloaderEvents;
  readonly captured: LandoEvent[];
} => {
  const captured: LandoEvent[] = [];
  const eventService = {
    publish: (event: LandoEvent) => Effect.sync(() => void captured.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.never,
  } satisfies EventService.Service;
  return { events: makeLiveDownloaderEvents(Option.some(eventService)), captured };
};

const fakeHttpClient = (url: string, payload: string): HttpClientShape => ({
  id: "redaction-proof-http",
  stream: (request) =>
    request.url === url
      ? Effect.succeed({
          status: 200,
          headers: new Map<string, string>(),
          body: Stream.fromIterable([new TextEncoder().encode(payload)]),
        })
      : Effect.die(new Error(`unexpected download URL ${request.url}`)),
});

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const assertCanonicalRedaction = (serialized: string, rawValues: ReadonlyArray<string>): void => {
  expect(serialized).toContain(CANONICAL_SENTINEL);
  expect(serialized).not.toContain(LEGACY_SENTINEL);
  for (const value of rawValues) {
    expect(serialized).not.toContain(value);
  }
};

const assertFixtureSecretsGone = (serialized: string): void =>
  assertCanonicalRedaction(serialized, [...SECRET_SOUP_FIXTURE.registeredSecrets, UNREGISTERED_BEARER]);

const assertPatternSecretsGone = (serialized: string): void =>
  assertCanonicalRedaction(serialized, [REGISTERED_SECRET, UNREGISTERED_BEARER]);

describe("audited services compose canonical redaction", () => {
  test("ShellRunner redacts shell events and ShellExecError fields through RedactionServiceLive", async () => {
    const events: LandoEvent[] = [];
    const cwd = await mkdtemp(join(tmpdir(), `lando-redaction-${REGISTERED_SECRET}-`));
    try {
      const command = [
        `printf %s ${shellSingleQuote(VALUE_AND_PATTERN_SOUP)}`,
        `printf %s ${shellSingleQuote(VALUE_AND_PATTERN_SOUP)} >&2`,
        "exit 7",
      ].join("; ");

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ShellRunner, (shellRunner) =>
          shellRunner.exec(command, {
            cwd,
            env: { BUN_AUTH_TOKEN: REGISTERED_SECRET },
          }),
        ).pipe(
          Effect.provide(Layer.mergeAll(ShellRunnerLive, realRedactionLayer, captureEventLayer(events))),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("expected ShellRunner to fail");
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (!Option.isSome(failure)) throw new Error("expected ShellExecError failure");
      expect(failure.value).toBeInstanceOf(ShellExecError);
      const error = failure.value;

      assertFixtureSecretsGone(JSON.stringify(events));
      assertFixtureSecretsGone(
        JSON.stringify({
          message: error.message,
          command: error.command,
          cwd: error.cwd,
          stdout: error.stdout,
          stderr: error.stderr,
        }),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("BunSelfRunner redacts published event fields through RedactionServiceLive", async () => {
    const events: LandoEvent[] = [];
    const spawner: BunSelfSpawner = { spawn: async () => ({ exitCode: 0 }) };

    await Effect.runPromise(
      bunSelfRun({
        argv: ["install", VALUE_AND_PATTERN_SOUP],
        cwd: `/tmp/${REGISTERED_SECRET}/${UNREGISTERED_BEARER}`,
        env: { BUN_AUTH_TOKEN: REGISTERED_SECRET },
        spawner,
        execPath: "/bin/bun",
        callerSubsystem: `caller ${VALUE_AND_PATTERN_SOUP}`,
        verb: `verb ${VALUE_AND_PATTERN_SOUP}`,
      }).pipe(Effect.provide(Layer.mergeAll(realRedactionLayer, captureEventLayer(events)))),
    );

    expect(events.map((event) => event._tag)).toEqual(["pre-bun-self-exec", "post-bun-self-exec"]);
    assertFixtureSecretsGone(JSON.stringify(events));
  });

  test("Downloader redacts lifecycle events with the canonical secrets profile and request tokens", async () => {
    const url = "https://downloads.example.test/artifact.bin";
    const registeredToken = "download-registered-token-value";
    const callerId = `caller ${PATTERN_SOUP} token=${registeredToken}`;
    const capture = capturingDownloaderEvents();
    const downloader = makeDownloaderService(fakeHttpClient(url, "payload"), capture.events);

    await Effect.runPromise(
      downloader.download({
        url,
        destination: { kind: "memory" },
        callerId,
        redactionTokens: [registeredToken],
      }),
    );

    const serialized = JSON.stringify(capture.captured);
    assertPatternSecretsGone(serialized);
    assertCanonicalRedaction(serialized, [registeredToken]);
  });

  test("HostProxyServiceDisabled exposes only static status fields and CLI diagnostics redact host-proxy details", async () => {
    const status = await Effect.runPromise(HostProxyServiceDisabled.status());
    expect(Object.keys(status).sort()).toEqual(["active", "baseDomain", "loopback", "mechanism", "mode"]);
    expect(status).toEqual({
      active: false,
      mode: "none",
      mechanism: "skipped",
      baseDomain: "lndo.site",
      loopback: "127.0.0.1",
    });
    expect(JSON.stringify(status)).not.toContain(REGISTERED_SECRET);

    const diagnostic = {
      subsystem: "host-proxy",
      message: `host proxy failed ${PATTERN_SOUP}`,
      cause: new Error(`dns setup failed ${PATTERN_SOUP}`),
      details: { authorization: UNREGISTERED_BEARER, token: REGISTERED_SECRET },
    };
    const renderedDetails = JSON.stringify(redactDetails(diagnostic));
    const renderedMessage = redactString(`host-proxy diagnostic ${PATTERN_SOUP}`);

    assertPatternSecretsGone(renderedDetails);
    assertPatternSecretsGone(renderedMessage);
  });

  test("FileSyncEngine errors are redacted at the CLI formatter boundary", () => {
    const error = new FileSyncStartError({
      engineId: "mutagen",
      message: `mutagen failed ${PATTERN_SOUP}`,
      sessionSpec: { alpha: PATTERN_SOUP, env: { BUN_AUTH_TOKEN: REGISTERED_SECRET } },
      remediation: `remove credentials ${PATTERN_SOUP}`,
      cause: new Error(`nested ${PATTERN_SOUP}`),
    });

    const redactedDetails = JSON.stringify(redactDetails(error));
    const redactedMessage = redactString(error.message);

    assertPatternSecretsGone(redactedDetails);
    assertPatternSecretsGone(redactedMessage);
  });
});
