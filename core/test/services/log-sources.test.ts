import { describe, expect, test } from "bun:test";

import { Either } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { AbsolutePath, type LogSource, LogSourceId } from "@lando/sdk/schema";

import { mergeLogSources } from "../../src/services/log-sources.ts";

const source = (input: {
  readonly id: string;
  readonly path: string;
  readonly strategy: LogSource["strategy"];
  readonly stream?: LogSource["stream"];
}): LogSource => ({
  id: LogSourceId.make(input.id),
  path: AbsolutePath.make(input.path),
  stream: input.stream ?? "stderr",
  strategy: input.strategy,
  required: false,
  timestamps: false,
});

const merge = (input: {
  readonly base?: "l337" | "lando";
  readonly typeSources?: ReadonlyArray<unknown>;
  readonly userSources?: ReadonlyArray<unknown>;
}) =>
  mergeLogSources({
    appRoot: "/srv/apps/myapp",
    serviceName: "web",
    base: input.base ?? "lando",
    typeSources: input.typeSources ?? [],
    userSources: input.userSources ?? [],
  });

const expectFailure = (result: ReturnType<typeof merge>): LandofileValidationError => {
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isRight(result)) throw new Error("expected log source merge failure");
  expect(result.left).toBeInstanceOf(LandofileValidationError);
  return result.left;
};

describe("mergeLogSources", () => {
  test("lets user logs override service-type sources with the same id", () => {
    const result = merge({
      typeSources: [source({ id: "access", path: "/var/log/service/access.log", strategy: "redirect" })],
      userSources: [source({ id: "access", path: "/app/logs/access.log", strategy: "follow" })],
    });

    expect(Either.isRight(result)).toBe(true);
    if (Either.isLeft(result)) throw result.left;
    expect(result.right).toHaveLength(1);
    expect(String(result.right[0]?.path)).toBe("/app/logs/access.log");
    expect(result.right[0]?.strategy).toBe("follow");
  });

  test("rejects duplicate ids within service-type sources", () => {
    const failure = expectFailure(
      merge({
        typeSources: [
          source({ id: "error", path: "/var/log/service/error.log", strategy: "redirect" }),
          source({ id: "error", path: "/var/log/service/error-2.log", strategy: "redirect" }),
        ],
      }),
    );

    expect(failure.message).toContain("duplicate log source id error");
  });

  test("rejects relative paths", () => {
    const failure = expectFailure(
      merge({
        typeSources: [
          {
            ...source({ id: "error", path: "/var/log/service/error.log", strategy: "redirect" }),
            path: "var/log/service/error.log",
          },
        ],
      }),
    );

    expect(failure.message).toContain("absolute in-container path");
  });

  test("rejects redirect sources on l337 services", () => {
    const failure = expectFailure(
      merge({
        base: "l337",
        typeSources: [source({ id: "error", path: "/var/log/service/error.log", strategy: "redirect" })],
      }),
    );

    expect(failure.message).toContain("Use strategy: follow");
  });

  test("rejects user redirect sources on l337 services", () => {
    const failure = expectFailure(
      merge({
        base: "l337",
        userSources: [source({ id: "user-error", path: "/app/logs/error.log", strategy: "redirect" })],
      }),
    );

    expect(failure.message).toContain("Use strategy: follow");
    expect(failure.message).toContain("user-error");
  });
});
