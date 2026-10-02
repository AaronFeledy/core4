import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestRuntimeProvider } from "@lando/core/testing";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import {
  makeDoctorExecutableLocator,
  makeDoctorResourceInspector,
  resolveDoctorAppIdentity,
} from "../../src/cli/commands/doctor-plugin-context.ts";
import { withCwd } from "../_support/temp-cwd.ts";

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-context-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("finds an execute-only candidate without reading or executing it", async () => {
  // Given
  const root = await temp();
  const candidate = join(root, "lando");
  const marker = join(root, "executed");
  await writeFile(candidate, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o111 });
  const locator = makeDoctorExecutableLocator({
    env: { PATH: root },
    platform: "linux",
    execPath: candidate,
  });
  // When
  const result = await Effect.runPromise(locator.locate("lando"));
  // Then
  expect(result).toEqual({
    runningBasename: "lando",
    runningPath: await realpath(candidate),
    candidate: { kind: "found", path: await realpath(candidate) },
  });
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("resolves candidate symlinks when they target executable regular files", async () => {
  // Given
  const root = await temp();
  const target = join(root, "target");
  await writeFile(target, "", { mode: 0o755 });
  await symlink(target, join(root, "lando"));
  // When
  const result = await Effect.runPromise(
    makeDoctorExecutableLocator({
      env: { PATH: root },
      platform: "linux",
      execPath: "/missing/lando4",
    }).locate("lando"),
  );
  // Then
  expect(result).toEqual({
    runningBasename: "lando4",
    candidate: { kind: "found", path: await realpath(target) },
  });
});

test("skips non-executable files when scanning PATH", async () => {
  // Given
  const root = await temp();
  await writeFile(join(root, "lando"), "");
  await chmod(join(root, "lando"), 0o644);
  // When
  const result = await Effect.runPromise(
    makeDoctorExecutableLocator({ env: { PATH: root }, platform: "linux", execPath: "/missing/bun" }).locate(
      "lando",
    ),
  );
  // Then
  expect(result.candidate).toEqual({ kind: "missing" });
});

test.each(["", "relative", "."])(
  "ignores PATH entry %s even when cwd contains the candidate",
  async (entry) => {
    // Given
    const root = await temp();
    await writeFile(join(root, "lando"), "", { mode: 0o755 });
    // When
    const result = await withCwd(root, () =>
      Effect.runPromise(
        makeDoctorExecutableLocator({
          env: { PATH: entry },
          platform: "linux",
          execPath: "/missing/bun",
        }).locate("lando"),
      ),
    );
    // Then
    expect(result.candidate).toEqual({ kind: "missing" });
  },
);

test("returns ambiguous when the PATH search cap is exhausted", async () => {
  // Given
  const root = await temp();
  await writeFile(join(root, "lando"), "", { mode: 0o755 });
  const PATH = [...Array.from({ length: 256 }, () => "/missing"), root].join(":");
  // When
  const result = await Effect.runPromise(
    makeDoctorExecutableLocator({ env: { PATH }, platform: "linux", execPath: "/missing/bun" }).locate(
      "lando",
    ),
  );
  // Then
  expect(result.candidate.kind).toBe("ambiguous");
});

test.each(["", "../lando", "a\\lando"])("rejects candidate name %s", async (name) => {
  // Given / When
  const result = await Effect.runPromise(
    makeDoctorExecutableLocator({ env: {}, platform: "linux", execPath: "/missing/bun" }).locate(name),
  );
  // Then
  expect(result.candidate.kind).toBe("ambiguous");
});

test.each(["lando4.exe", "LANDO4.EXE", "LANDO4"])(
  "uses Windows PATH and PATHEXT with running name %s",
  async (basename) => {
    // Given
    const root = await temp();
    await writeFile(join(root, "lando.exe"), "");
    // When
    const result = await Effect.runPromise(
      makeDoctorExecutableLocator({
        env: { Path: root, PATHEXT: ".exe;.bat" },
        platform: "win32",
        execPath: `C:\\tools\\${basename}`,
      }).locate("lando"),
    );
    // Then
    expect(result).toEqual({
      runningBasename: "lando4",
      candidate: { kind: "found", path: await realpath(join(root, "lando.exe")) },
    });
  },
);

test("constructs the resource provider lazily and caches it across queries", async () => {
  // Given
  let constructions = 0;
  const inspector = makeDoctorResourceInspector({
    provider: Effect.sync(() => {
      constructions++;
      return { ...TestRuntimeProvider, inspectResourceNames: () => Effect.succeed(["z", "a", "a"]) };
    }),
    budgetMs: 100,
    redact: (s) => s,
  });
  expect(constructions).toBe(0);
  // When
  const results = await Effect.runPromise(
    Effect.all(
      [inspector.inspect({ kind: "volume", limit: 2 }), inspector.inspect({ kind: "volume", limit: 2 })],
      { concurrency: "unbounded" },
    ),
  );
  // Then
  expect(constructions).toBe(1);
  expect(results).toEqual([
    { status: "ok", names: ["a", "z"], truncated: true },
    { status: "ok", names: ["a", "z"], truncated: true },
  ]);
});

test.each([
  ["unsupported", Effect.succeed(TestRuntimeProvider)],
  ["unavailable", Effect.fail(new Error("secret"))],
  ["unavailable", Effect.die("secret")],
  ["unavailable", Effect.succeed({ ...TestRuntimeProvider, inspectResourceNames: () => Effect.never })],
] as const)("returns %s when provider inspection cannot complete", async (status, provider) => {
  // Given
  const inspector = makeDoctorResourceInspector({
    provider,
    budgetMs: 10,
    redact: (s) => s.replaceAll("secret", "[redacted]"),
  });
  // When
  const result = await Effect.runPromise(inspector.inspect({ kind: "volume", limit: 2 }));
  // Then
  expect(result.status).toBe(status);
  expect(JSON.stringify(result)).not.toContain("secret");
  if (result.status === "unavailable") expect(result.reason).not.toMatch(/\n\s+at /u);
});

test("reports a failed inspection as its tag and message without a stack trace", async () => {
  // Given
  const inspector = makeDoctorResourceInspector({
    provider: Effect.succeed({
      ...TestRuntimeProvider,
      inspectResourceNames: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "docker",
            operation: "inspectResourceNames",
            message: "Docker API request failed.",
          }),
        ),
    }),
    budgetMs: 100,
    redact: (s) => s,
  });
  // When
  const result = await Effect.runPromise(inspector.inspect({ kind: "volume", namePrefix: "app_", limit: 2 }));
  // Then
  expect(result).toEqual({
    status: "unavailable",
    reason: "ProviderUnavailableError: Docker API request failed.",
  });
});

test("rejects invalid queries without constructing the provider", async () => {
  // Given
  const inspector = makeDoctorResourceInspector({
    provider: Effect.die("must not construct"),
    budgetMs: 100,
    redact: (s) => s,
  });
  // When
  const result = await Effect.runPromise(inspector.inspect({ kind: "volume", limit: 65 }));
  // Then
  expect(result.status).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("must not construct");
});

test.each([
  ["v4", "name: example\nservices:\n  web:\n    image: nginx:alpine\n", true],
  ["v3", "name: example\nrecipe: lamp\nconfig:\n  php: '8.3'\n", false],
  ["missing", undefined, false],
  ["malformed", "name: example\nservices: invalid\n", false],
] as const)("resolves only app identity for a %s Landofile", async (_kind, content, valid) => {
  // Given
  const root = await temp();
  if (content !== undefined) await writeFile(join(root, ".lando.yml"), content);
  // When
  const result = await withCwd(root, () => Effect.runPromise(resolveDoctorAppIdentity()));
  // Then
  expect(result).toEqual(valid ? { name: "example", root: await realpath(root) } : undefined);
});
