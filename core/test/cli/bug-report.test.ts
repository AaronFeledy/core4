import { describe, expect, test } from "bun:test";

import {
  CapabilityError,
  NotImplementedError,
  ProviderUnavailableError,
  ServiceStartError,
} from "@lando/sdk/errors";

import {
  buildBugReport,
  formatBugReport,
  renderJsonBugReport,
  renderPlainBugReport,
} from "../../src/cli/bug-report.ts";

const CACHE_ROOT = "/tmp/lando-test-cache";

const ctx = (overrides: Partial<{ commandId: string; appId: string; providerId: string }> = {}) => ({
  commandId: overrides.commandId ?? "app:start",
  cacheRoot: CACHE_ROOT,
  ...(overrides.appId === undefined ? {} : { appId: overrides.appId }),
  ...(overrides.providerId === undefined ? {} : { providerId: overrides.providerId }),
});

describe("buildBugReport: envelope extraction", () => {
  test("uses tagged-error _tag as the machine-readable code", () => {
    const env = buildBugReport({
      error: new NotImplementedError({
        message: "deferred",
        commandId: "meta:plugin:trust",
        remediation: "— see the current command list",
      }),
      context: ctx({ commandId: "meta:plugin:trust" }),
    });
    expect(env.code).toBe("NotImplementedError");
    expect(env.commandId).toBe("meta:plugin:trust");
  });

  test("falls back to 'Error' when error has no _tag", () => {
    const env = buildBugReport({ error: new Error("boom"), context: ctx() });
    expect(env.code).toBe("Error");
    expect(env.body).toBe("boom");
  });

  test("extracts providerId from tagged provider errors", () => {
    const env = buildBugReport({
      error: new ProviderUnavailableError({
        providerId: "lando",
        operation: "podman.info",
        message: "Podman not running",
      }),
      context: ctx({ commandId: "app:start" }),
    });
    expect(env.providerId).toBe("lando");
  });

  test("extracts service from ServiceStartError as an extra field", () => {
    const env = buildBugReport({
      error: new ServiceStartError({
        providerId: "lando",
        operation: "bringUp.create",
        service: "web",
        message: "failed to create container",
      }),
      context: ctx({ commandId: "app:start" }),
    });
    expect(env.providerId).toBe("lando");
    const serviceEntry = env.extra.find(([key]) => key === "service");
    expect(serviceEntry).toEqual(["service", "web"]);
  });

  test("extracts CapabilityError service, key, and capability as extra fields", () => {
    const env = buildBugReport({
      error: new CapabilityError({
        message: "Service web uses Compose runtime knob shm_size, which provider lando does not support.",
        service: "web",
        key: "shm_size",
        feature: "compose knob shm_size",
        capability: "composeSpec",
        providerId: "lando",
        remediation:
          "Remove shm_size from service web, choose a provider that declares composeKnobs support for shm_size, or move the intent under providers.<id>.",
      }),
      context: ctx(),
    });
    expect(env.extra).toEqual(
      expect.arrayContaining([
        ["service", "web"],
        ["key", "shm_size"],
        ["capability", "composeSpec"],
      ]),
    );
    expect(env.providerId).toBe("lando");
  });

  test("redacts env-style secrets in the body", () => {
    const env = buildBugReport({
      error: new Error("exec failed: env DATABASE_PASSWORD=hunter2 SECRET_TOKEN=abc returned 1"),
      context: ctx(),
    });
    expect(env.body).not.toContain("hunter2");
    expect(env.body).toContain("DATABASE_PASSWORD=[redacted]");
    expect(env.body).not.toContain("abc");
    expect(env.body).toContain("SECRET_TOKEN=[redacted]");
  });

  test("redacts env-style secrets in remediation", () => {
    const env = buildBugReport({
      error: {
        _tag: "NotImplementedError",
        message: "unsupported",
        remediation: "Try `lando exec -- bash -c 'echo MY_API_TOKEN=secretvalue'`",
      },
      context: ctx(),
    });
    expect(env.remediation).toBeDefined();
    expect(env.remediation).not.toContain("secretvalue");
    expect(env.remediation).toContain("MY_API_TOKEN=[redacted]");
  });

  test("logsDir is <cacheRoot>/logs and cacheDir is <cacheRoot>", () => {
    const env = buildBugReport({ error: new Error("x"), context: ctx() });
    expect(env.cacheDir).toBe(CACHE_ROOT);
    expect(env.logsDir).toBe(`${CACHE_ROOT}/logs`);
  });
});

describe("renderPlainBugReport: stable multi-line output", () => {
  test("includes body, remediation, code, commandId, logsDir, cacheDir at minimum", () => {
    const text = renderPlainBugReport(
      buildBugReport({
        error: { _tag: "TestError", message: "something went wrong", remediation: "try again" },
        context: ctx({ commandId: "app:start" }),
      }),
    );
    expect(text).toContain("something went wrong");
    expect(text).toContain("  ↳ try again");
    expect(text).toContain("code: TestError");
    expect(text).toContain("commandId: app:start");
    expect(text).toContain(`logsDir: ${CACHE_ROOT}/logs`);
    expect(text).toContain(`cacheDir: ${CACHE_ROOT}`);
  });

  test("includes appId and providerId when known", () => {
    const text = renderPlainBugReport(
      buildBugReport({
        error: new ProviderUnavailableError({
          providerId: "lando",
          operation: "podman.info",
          message: "Podman not running",
        }),
        context: { commandId: "app:start", appId: "mvp", cacheRoot: CACHE_ROOT },
      }),
    );
    expect(text).toContain("appId: mvp");
    expect(text).toContain("providerId: lando");
  });

  test("omits appId and providerId lines when unknown", () => {
    const text = renderPlainBugReport(buildBugReport({ error: new Error("x"), context: ctx() }));
    expect(text).not.toContain("appId:");
    expect(text).not.toContain("providerId:");
  });

  test("preserves NotImplementedError commandId as a labeled diagnostic line", () => {
    const text = renderPlainBugReport(
      buildBugReport({
        error: new NotImplementedError({
          message: "deferred",
          commandId: "meta:plugin:trust",
          remediation: "not available yet",
        }),
        context: ctx({ commandId: "meta:plugin:trust" }),
      }),
    );
    expect(text).toContain("code: NotImplementedError");
    expect(text).toContain("commandId: meta:plugin:trust");
  });

  test("includes CapabilityError service and key diagnostic lines", () => {
    const text = renderPlainBugReport(
      buildBugReport({
        error: new CapabilityError({
          message: "Service web uses Compose runtime knob shm_size, which provider lando does not support.",
          service: "web",
          key: "shm_size",
          feature: "compose knob shm_size",
          capability: "composeSpec",
          providerId: "lando",
          remediation:
            "Remove shm_size from service web, choose a provider that declares composeKnobs support for shm_size, or move the intent under providers.<id>.",
        }),
        context: ctx(),
      }),
    );
    expect(text).toContain("service: web");
    expect(text).toContain("key: shm_size");
  });

  test("output never contains ANSI control sequences", () => {
    const text = renderPlainBugReport(
      buildBugReport({
        error: new Error("plain message"),
        context: ctx(),
      }),
    );
    const escChar = String.fromCharCode(27);
    expect(text.includes(`${escChar}[`)).toBe(false);
  });

  test("Given a control-bearing commandId, when plain and JSON reports render, then only plain output escapes it", () => {
    // Given
    const commandId = "app:unknown\u001b[31m";
    const envelope = buildBugReport({ error: new Error("unknown"), context: ctx({ commandId }) });

    // When
    const plain = renderPlainBugReport(envelope);
    const json = renderJsonBugReport(envelope);
    const parsed: unknown = JSON.parse(json);

    // Then
    expect(plain).toContain("commandId: app:unknown\\u001b[31m");
    expect(plain).not.toContain("\u001b");
    expect(json).not.toContain("\u001b");
    expect(parsed).toMatchObject({ commandId });
  });
});

describe("renderJsonBugReport: single NDJSON line", () => {
  test("emits one valid JSON object with _tag, code, commandId, body, logsDir, cacheDir", () => {
    const line = renderJsonBugReport(
      buildBugReport({
        error: { _tag: "TestError", message: "boom", remediation: "fix it" },
        context: ctx({ commandId: "app:start" }),
      }),
    );
    expect(line.includes("\n")).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed._tag).toBe("message.error");
    expect(parsed.code).toBe("TestError");
    expect(parsed.commandId).toBe("app:start");
    expect(parsed.body).toBe("boom");
    expect(parsed.remediation).toBe("fix it");
    expect(parsed.logsDir).toBe(`${CACHE_ROOT}/logs`);
    expect(parsed.cacheDir).toBe(CACHE_ROOT);
    expect(typeof parsed.timestamp).toBe("string");
  });

  test("includes appId and providerId when known", () => {
    const line = renderJsonBugReport(
      buildBugReport({
        error: new ProviderUnavailableError({
          providerId: "lando",
          operation: "podman.info",
          message: "Podman not running",
        }),
        context: { commandId: "app:start", appId: "mvp", cacheRoot: CACHE_ROOT },
      }),
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.appId).toBe("mvp");
    expect(parsed.providerId).toBe("lando");
  });

  test("omits appId/providerId/remediation fields when absent (round-trip JSON shape)", () => {
    const line = renderJsonBugReport(buildBugReport({ error: new Error("solo"), context: ctx() }));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "appId")).toBe(false);
    expect(Object.hasOwn(parsed, "providerId")).toBe(false);
    expect(Object.hasOwn(parsed, "remediation")).toBe(false);
  });

  test("redacts env-style secrets in body before serialization", () => {
    const line = renderJsonBugReport(
      buildBugReport({
        error: new Error("export FOO_TOKEN=leakedvalue && do_thing"),
        context: ctx(),
      }),
    );
    expect(line).not.toContain("leakedvalue");
    expect(line).toContain("FOO_TOKEN=[redacted]");
  });

  test("_tag is the first key in the serialized JSON", () => {
    const line = renderJsonBugReport(buildBugReport({ error: new Error("hi"), context: ctx() }));
    expect(line.startsWith('{"_tag":"message.error"')).toBe(true);
  });

  test("includes CapabilityError fields while keeping _tag first", () => {
    const line = renderJsonBugReport(
      buildBugReport({
        error: new CapabilityError({
          message: "Service web uses Compose runtime knob shm_size, which provider lando does not support.",
          service: "web",
          key: "shm_size",
          feature: "compose knob shm_size",
          capability: "composeSpec",
          providerId: "lando",
          remediation:
            "Remove shm_size from service web, choose a provider that declares composeKnobs support for shm_size, or move the intent under providers.<id>.",
        }),
        context: ctx(),
      }),
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.service).toBe("web");
    expect(parsed.key).toBe("shm_size");
    expect(parsed.capability).toBe("composeSpec");
    expect(parsed.providerId).toBe("lando");
    expect(Object.keys(parsed)[0]).toBe("_tag");
  });
});

describe("formatBugReport: dispatches on renderer mode", () => {
  test("json renderer mode returns NDJSON; plain/lando modes return multi-line text", () => {
    const error = new Error("boom");
    const context = ctx();
    const json = formatBugReport({ error, context, rendererMode: "json" });
    const plain = formatBugReport({ error, context, rendererMode: "plain" });
    const lando = formatBugReport({ error, context, rendererMode: "lando" });
    expect(json.startsWith('{"_tag":"message.error"')).toBe(true);
    expect(json.includes("\n")).toBe(false);
    expect(plain).toContain("boom");
    expect(plain).toContain("commandId: app:start");
    expect(plain.includes("\n")).toBe(true);
    expect(lando).toBe(plain);
  });
});
