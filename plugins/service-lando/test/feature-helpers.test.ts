import { expect, test } from "bun:test";
import { Effect, Result } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";

import {
  loopbackTcpHealthcheck,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "../src/services/_feature-helpers.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

test.each([new Error("original message"), "non-error", undefined])(
  "apply preserves the cause and chooses the message for %p",
  (cause) => {
    // Given
    const { ctx } = recordFeatureContext({ serviceType: "example", normalizedConfig: {}, config: {} });
    const apply = serviceFeatureApply("example.feature", "apply fallback", () => {
      throw cause;
    });
    // When
    const result = Effect.runSync(Effect.result(apply(ctx)));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ServiceFeatureError);
      expect(result.failure).toMatchObject({
        _tag: "ServiceFeatureError",
        feature: "example.feature",
        message: cause instanceof Error ? cause.message : "apply fallback",
        cause,
      });
      expect(result.failure.cause).toBe(cause);
    }
  },
);

test.each([new Error("original message"), "non-error", undefined])(
  "resolve preserves the cause and chooses the message for %p",
  (cause) => {
    // Given
    const resolve = serviceTypeResolve("example", "resolve fallback", () => {
      throw cause;
    });
    // When
    const result = Effect.runSync(Effect.result(resolve));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ServiceTypeError);
      expect(result.failure).toMatchObject({
        _tag: "ServiceTypeError",
        serviceType: "example",
        message: cause instanceof Error ? cause.message : "resolve fallback",
        cause,
      });
      expect(result.failure.cause).toBe(cause);
    }
  },
);

test("apply defers mutation until execution and passes the original context", () => {
  // Given
  const { ctx, calls } = recordFeatureContext({ serviceType: "example", normalizedConfig: {}, config: {} });
  const effect = serviceFeatureApply("feature", "fallback", (context) => context.setUser("root"))(ctx);
  expect(calls).toEqual([]);
  // When
  const result = Effect.runSync(effect);
  // Then
  expect(result).toBeUndefined();
  expect(calls).toEqual([["setUser", "root"]]);
});

test("resolve preserves the returned object", () => {
  // Given
  const value = { base: "lando" };
  // When
  const result = Effect.runSync(serviceTypeResolve("example", "fallback", () => value));
  // Then
  expect(result).toBe(value);
});

test.each([10, 20, 30])(
  "TCP healthcheck preserves the literal and key order at %i seconds",
  (startPeriodSeconds) => {
    // Given
    const expected = {
      kind: "command" as const,
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds,
    };
    // When
    const result = loopbackTcpHealthcheck(8080, startPeriodSeconds);
    // Then
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
  },
);

test("root identity keeps Apache homes in order and allocates fresh objects", () => {
  // Given
  const homes = { "www-data": "/home/www-data" };
  const first = rootIdentity(homes);
  // When
  const second = rootIdentity(homes);
  // Then
  expect(second).toEqual({ defaultUser: "root", homes: { root: "/root", "www-data": "/home/www-data" } });
  expect(Object.keys(second.homes)).toEqual(["root", "www-data"]);
  expect(second).not.toBe(first);
  expect(second.homes).not.toBe(first.homes);
  expect(second.homes).not.toBe(homes);
  expect(rootIdentity()).toEqual({ defaultUser: "root", homes: { root: "/root" } });
});
