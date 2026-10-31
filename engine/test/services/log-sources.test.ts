import { describe, expect, test } from "bun:test";

import { Result } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { AbsolutePath, type LogSource, LogSourceId } from "@lando/sdk/schema";

import { mergeLogSources } from "../../src/services/log-sources";

const source = (input: {
  readonly id: string;
  readonly path: string;
  readonly strategy: "redirect" | "follow";
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
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("expected log source merge failure");
  expect(result.failure).toBeInstanceOf(LandofileValidationError);
  return result.failure;
};

describe("mergeLogSources", () => {
  test("preserves pathless aliases on services without a build phase", () => {
    // Given a native pipe alias with no filesystem policy.
    const alias = { id: LogSourceId.make("error"), strategy: "console", stream: "stderr" } as const;
    // When merging it on a service without a Lando build phase.
    const result = merge({ base: "l337", typeSources: [alias] });
    // Then the alias is preserved without file defaults.
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw result.failure;
    expect(result.success).toEqual([alias]);
  });

  test("lets an authored follow source override a same-id native alias", () => {
    // Given a service alias and an explicit user file with the same id.
    const file = source({ id: "access", path: "/app/access.log", strategy: "follow" });
    // When applying the established user precedence.
    const result = merge({
      typeSources: [{ id: "access", strategy: "console", stream: "stdout" }],
      userSources: [file],
    });
    // Then only the user's real file is followed.
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw result.failure;
    expect(result.success).toEqual([file]);
  });

  test("lets user logs override service-type sources with the same id", () => {
    const result = merge({
      typeSources: [source({ id: "access", path: "/var/log/service/access.log", strategy: "redirect" })],
      userSources: [source({ id: "access", path: "/app/logs/access.log", strategy: "follow" })],
    });

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw result.failure;
    expect(result.success).toHaveLength(1);
    expect(String(result.success[0]?.path)).toBe("/app/logs/access.log");
    expect(result.success[0]?.strategy).toBe("follow");
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
