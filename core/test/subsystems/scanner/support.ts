import { expect } from "bun:test";
import { Cause, Clock, Duration, Effect, Exit, Fiber, Layer, Option, TestClock, TestContext } from "effect";

import { HttpRequestError, type ScannerError } from "@lando/sdk/errors";
import {
  AppId,
  type HttpRequest,
  type HttpResponse,
  type PublishedEndpoint,
  type ServiceName,
} from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";

import type { HttpClientShape } from "../../../src/http-client/service.ts";
import { RedactionService, type RedactionServiceShape } from "../../../src/redaction/service.ts";
import type { ScanSourceEndpoint } from "../../../src/subsystems/scanner/live.ts";

export const drive = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

export const driveExit = <A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(TestContext.TestContext)));

type TimedExit<A, E> = { readonly exit: Exit.Exit<A, E>; readonly elapsedMs: number };

export const runExitUnderClock = <A, E>(
  effect: Effect.Effect<A, E, never>,
  advance: Duration.DurationInput,
): Promise<TimedExit<A, E>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const measured = Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(effect);
        return { exit, elapsedMs: (yield* Clock.currentTimeMillis) - started };
      });
      const fiber = yield* Effect.fork(measured);
      yield* TestClock.adjust(advance);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

export const successOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  expect(Exit.isSuccess(exit)).toBe(true);
  throw new Error("expected success");
};

export const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) return failure.value;
  throw new Error("expected typed failure");
};

export const appId = AppId.make("myapp");

export const publishedEndpoint = (
  service: ServiceName,
  protocol: PublishedEndpoint["protocol"],
  port: number,
): ScanSourceEndpoint => ({
  _tag: "published",
  service,
  protocol,
  port,
  publication: { hostPort: port },
});

export const endpointsOf = (
  endpoints: ReadonlyArray<ScanSourceEndpoint>,
): {
  readonly calls: AppId[];
  readonly listEndpoints: (app: AppId) => Effect.Effect<ReadonlyArray<ScanSourceEndpoint>, ScannerError>;
} => {
  const calls: AppId[] = [];
  return {
    calls,
    listEndpoints: (app) =>
      Effect.sync(() => {
        calls.push(app);
        return endpoints;
      }),
  };
};

export type ScriptedRequestResult =
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "failure"; readonly message: string }
  | { readonly kind: "sleep"; readonly duration: Duration.DurationInput; readonly status: number };

export const httpStatus = (status: number): ScriptedRequestResult => ({ kind: "status", status });

export const httpFailure = (message: string): ScriptedRequestResult => ({ kind: "failure", message });

export const httpSleep = (duration: Duration.DurationInput, status: number): ScriptedRequestResult => ({
  kind: "sleep",
  duration,
  status,
});

export interface FakeHttp {
  readonly requests: HttpRequest[];
  readonly request: HttpClientShape["request"];
}

const response = (status: number): HttpResponse => ({ status, headers: [] });

const urlOrigin = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "unknown";
  }
};

export const requestSequence = (
  results: readonly [ScriptedRequestResult, ...ScriptedRequestResult[]],
): FakeHttp => {
  let attempt = 0;
  const requests: HttpRequest[] = [];
  return {
    requests,
    request: (req) => {
      requests.push(req);
      const scripted = results[Math.min(attempt, results.length - 1)] ?? results[0];
      attempt += 1;
      switch (scripted.kind) {
        case "status":
          return Effect.succeed(response(scripted.status));
        case "failure":
          return Effect.fail(
            new HttpRequestError({ message: scripted.message, urlOrigin: urlOrigin(req.url) }),
          );
        case "sleep":
          return Effect.sleep(Duration.decode(scripted.duration)).pipe(Effect.as(response(scripted.status)));
      }
    },
  };
};

export const asHttpClient = (fake: FakeHttp): HttpClientShape => ({
  id: "test-scanner-http",
  capabilities: {
    schemes: ["https", "http"],
    streaming: false,
    upload: false,
    customCa: true,
    proxyAware: true,
  },
  request: fake.request,
  stream: () => Effect.die("scanner tests do not stream"),
  upload: () => Effect.die("scanner tests do not upload"),
});

export const secret = "s3cr3t-token";
export const marker = "[REDACTED]";

const fakeRedactString = (text: string): string => text.replaceAll(secret, marker);

const fakeRedactValue = (value: unknown): unknown => {
  if (typeof value === "string") return fakeRedactString(value);
  if (Array.isArray(value)) return value.map(fakeRedactValue);
  if (value instanceof Error) return { name: value.name, message: fakeRedactString(value.message) };
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fakeRedactValue(item)]));
  }
  return value;
};

const fakeRedactor: Redactor = { redactString: fakeRedactString, redactValue: fakeRedactValue };

const fakeRedactionService = {
  forProfile: () => Effect.succeed(fakeRedactor),
} satisfies RedactionServiceShape;

export const withFakeRedaction = <A, E>(effect: Effect.Effect<A, E, never>): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(Layer.succeed(RedactionService, fakeRedactionService)));
