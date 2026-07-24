import { describe, expect, test } from "bun:test";

import { AbsolutePath, type LogSource, LogSourceId } from "@lando/sdk/schema";

import {
  redirectLogSourceBuildSteps,
  runtimeFollowLogSources,
} from "../../src/services/redirect-log-sources.ts";

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

describe("redirectLogSourceBuildSteps", () => {
  test("emits argv-safe parent creation immediately before a stdout redirect", () => {
    const steps = redirectLogSourceBuildSteps({
      base: "lando",
      logSources: [
        source({
          id: "access",
          path: "/usr/local/apache2/logs/access_log",
          strategy: "redirect",
          stream: "stdout",
        }),
      ],
    });

    expect(steps).toEqual([
      {
        id: "lando-log-redirect-mkdir:access",
        phase: "build",
        command: ["mkdir", "-p", "/usr/local/apache2/logs"],
      },
      {
        id: "lando-log-redirect:access",
        phase: "build",
        command: ["ln", "-sf", "/dev/stdout", "/usr/local/apache2/logs/access_log"],
      },
    ]);
  });

  test("emits argv-safe parent creation immediately before a stderr redirect", () => {
    const steps = redirectLogSourceBuildSteps({
      base: "lando",
      logSources: [
        source({
          id: "error",
          path: "/usr/local/apache2/logs/error_log",
          strategy: "redirect",
          stream: "stderr",
        }),
      ],
    });

    expect(steps).toEqual([
      {
        id: "lando-log-redirect-mkdir:error",
        phase: "build",
        command: ["mkdir", "-p", "/usr/local/apache2/logs"],
      },
      {
        id: "lando-log-redirect:error",
        phase: "build",
        command: ["ln", "-sf", "/dev/stderr", "/usr/local/apache2/logs/error_log"],
      },
    ]);
  });

  test("emits no step for a follow source", () => {
    const steps = redirectLogSourceBuildSteps({
      base: "lando",
      logSources: [source({ id: "slow-query", path: "/var/lib/mysql/slow.log", strategy: "follow" })],
    });

    expect(steps).toEqual([]);
  });

  test("creates the nested parent directory for a redirect source", () => {
    const steps = redirectLogSourceBuildSteps({
      base: "lando",
      logSources: [source({ id: "nested", path: "/var/log/services/php/access.log", strategy: "redirect" })],
    });

    expect(steps[0]?.command).toEqual(["mkdir", "-p", "/var/log/services/php"]);
    expect(steps[1]?.command).toEqual(["ln", "-sf", "/dev/stderr", "/var/log/services/php/access.log"]);
  });

  test("uses the container root as the parent for a root-level redirect path", () => {
    const steps = redirectLogSourceBuildSteps({
      base: "lando",
      logSources: [source({ id: "root", path: "/service.log", strategy: "redirect" })],
    });

    expect(steps[0]?.command).toEqual(["mkdir", "-p", "/"]);
    expect(steps[1]?.command).toEqual(["ln", "-sf", "/dev/stderr", "/service.log"]);
  });

  test("returns [] for a non-lando base even if a redirect source slips through", () => {
    const steps = redirectLogSourceBuildSteps({
      base: "l337",
      logSources: [
        source({ id: "access", path: "/var/log/access.log", strategy: "redirect", stream: "stdout" }),
      ],
    });

    expect(steps).toEqual([]);
  });

  test("orders paired mkdir and link steps by source id and skips follow sources", () => {
    const steps = redirectLogSourceBuildSteps({
      base: "lando",
      logSources: [
        source({ id: "error", path: "/logs/error_log", strategy: "redirect", stream: "stderr" }),
        source({ id: "slow", path: "/logs/slow.log", strategy: "follow" }),
        source({ id: "access", path: "/logs/access_log", strategy: "redirect", stream: "stdout" }),
      ],
    });

    expect(steps.map((step) => step.id)).toEqual([
      "lando-log-redirect-mkdir:access",
      "lando-log-redirect:access",
      "lando-log-redirect-mkdir:error",
      "lando-log-redirect:error",
    ]);
  });

  test("produces identical output for identical input (idempotent content)", () => {
    const input = {
      base: "lando" as const,
      logSources: [
        source({ id: "access", path: "/logs/access_log", strategy: "redirect", stream: "stdout" as const }),
      ],
    };

    expect(redirectLogSourceBuildSteps(input)).toEqual(redirectLogSourceBuildSteps(input));
  });

  test("encodes stream and path so a changed source yields a different command", () => {
    const before = redirectLogSourceBuildSteps({
      base: "lando",
      logSources: [
        source({ id: "access", path: "/logs/access_log", strategy: "redirect", stream: "stdout" }),
      ],
    });
    const after = redirectLogSourceBuildSteps({
      base: "lando",
      logSources: [source({ id: "access", path: "/logs/other_log", strategy: "redirect", stream: "stdout" })],
    });

    expect(before[1]?.command).not.toEqual(after[1]?.command);
  });
});

describe("runtimeFollowLogSources", () => {
  test("keeps follow sources and excludes redirect sources", () => {
    const follow = source({ id: "slow-query", path: "/var/lib/mysql/slow.log", strategy: "follow" });
    const result = runtimeFollowLogSources([
      source({ id: "access", path: "/logs/access_log", strategy: "redirect", stream: "stdout" }),
      follow,
    ]);

    expect(result).toEqual([follow]);
  });

  test("returns [] when every source is a redirect (no follower scheduled)", () => {
    const result = runtimeFollowLogSources([
      source({ id: "access", path: "/logs/access_log", strategy: "redirect", stream: "stdout" }),
      source({ id: "error", path: "/logs/error_log", strategy: "redirect", stream: "stderr" }),
    ]);

    expect(result).toEqual([]);
  });
});
