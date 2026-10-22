import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { type ConfigOptions, config } from "../../src/operations/config.ts";
import { GlobalConfigSources } from "../../src/services/config.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-config-repair-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const run = (
  options: ConfigOptions,
  env: Record<string, string> = {},
  host: Record<string, unknown> = {},
) => {
  const warnings = makeCommandWarnings(true);
  return Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* config(options).pipe(Effect.result);
      return { result, warnings: yield* warnings.list };
    }).pipe(
      Effect.provideService(GlobalConfigSources, {
        env,
        host,
        rootOverrides: { userConfRoot: root },
        sources: { user: true, env: true },
      }),
      Effect.provideService(CommandWarnings, warnings),
    ),
  );
};

test.each(["view", "get"] as const)("raw %s ignores schema errors and higher layers", async (subcommand) => {
  await writeFile(join(root, "config.yml"), "router:\n  httpPort: nonsense\n");
  await mkdir(join(root, "config.d"));
  await writeFile(join(root, "config.d", "invalid.yml"), "router: [\n");
  const { result } = await run(
    { subcommand, source: "raw", key: "router.httpPort" },
    { LANDO_ROUTER_HTTP_PORT: "8080" },
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) return;
  expect(result.success).toMatchObject({ raw: { router: { httpPort: "nonsense" } }, value: "nonsense" });
  expect(result.success.config).toBeUndefined();
});

test("rejects an invalid file candidate even when an env override masks it", async () => {
  await writeFile(join(root, "config.yml"), "renderer: plain\n");
  const { result } = await run(
    { subcommand: "set", key: "router.httpPort", value: "nonsense", type: "string" },
    { LANDO_ROUTER_HTTP_PORT: "8080" },
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) return;
  expect(result.failure).toMatchObject({
    _tag: "LandofileWriteValidationError",
    issues: [
      { path: ["router", "httpPort"], source: { layer: "config-file", file: join(root, "config.yml") } },
    ],
  });
  expect(await readFile(join(root, "config.yml"), "utf8")).toBe("renderer: plain\n");
});

test.each(["env", "config-drop-in", "host"] as const)(
  "validate reports sourced %s issues",
  async (source) => {
    await writeFile(join(root, "config.yml"), "renderer: plain\n");
    if (source === "config-drop-in") {
      await mkdir(join(root, "config.d"));
      await writeFile(join(root, "config.d", "bad.yml"), "router:\n  httpsPort: 99999\n");
    }
    const { result } = await run(
      { subcommand: "validate" },
      source === "env" ? { LANDO_ROUTER_HTTPS_PORT: "99999" } : {},
      source === "host" ? { router: { httpsPort: 99999 } } : {},
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure).toMatchObject({
      _tag: "ConfigError",
      issues: [{ path: ["router", "httpsPort"], source: { layer: source }, suggestion: expect.any(String) }],
    });
  },
);

test.each(["unset", "edit", "telemetry"] as const)(
  "%s writes valid candidates despite invalid external layers",
  async (subcommand) => {
    await writeFile(join(root, "config.yml"), "router:\n  httpPort: 8080\n");
    const { result, warnings } = await run(
      {
        subcommand,
        key: subcommand === "telemetry" ? "off" : "router.httpPort",
        editorRunner: async () => ({ kind: "edited", content: "renderer: plain\n" }),
      },
      { LANDO_ROUTER_HTTPS_PORT: "99999" },
    );
    expect(Result.isSuccess(result)).toBe(true);
    expect(warnings).toMatchObject([
      {
        code: "LANDO_CONFIG_OTHER_SOURCE_INVALID",
        message: expect.stringContaining("LANDO_ROUTER_HTTPS_PORT"),
        remediation: expect.stringContaining("Unset LANDO_ROUTER_HTTPS_PORT"),
      },
    ]);
  },
);

test.each(["view", "validate"] as const)(
  "%s failures never include a malformed header secret",
  async (subcommand) => {
    const secret = "config-failure-secret-canary-759324";
    await writeFile(join(root, "config.yml"), `tracing:\n  otlp:\n    headers: ${secret}\n`);
    const { result } = await run({ subcommand });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(JSON.stringify(result.failure)).not.toContain(secret);
    expect(result.failure).toMatchObject({
      _tag: "ConfigError",
      issues: [{ path: ["tracing", "otlp", "headers"], source: { layer: "config-file" } }],
    });
  },
);

test("telemetry off preserves unrelated invalid config and warns", async () => {
  // Given
  const before = "router:\n  httpPort: nonsense\n";
  await writeFile(join(root, "config.yml"), before);
  // When
  const { result, warnings } = await run({ subcommand: "telemetry", key: "off" });
  // Then
  expect(Result.isSuccess(result)).toBe(true);
  expect(warnings).toMatchObject([
    { code: "LANDO_CONFIG_PREEXISTING_ISSUES", message: expect.stringContaining("router.httpPort") },
  ]);
  expect(await readFile(join(root, "config.yml"), "utf8")).toContain(before);
});

test.each([
  { subcommand: "unset", key: "router.httpPort" },
  { subcommand: "set", key: "router.httpPort", value: "8080" },
] as const)("$subcommand repairs one of three problems and preserves comments", async (options) => {
  // Given
  await writeFile(
    join(root, "config.yml"),
    "# my comment\nrouter:\n  httpPort: 99999\ndefaultProvidreId: docker\ntracing:\n  otlp:\n    headers: scalar\n",
  );
  // When
  const { result, warnings } = await run(options);
  // Then
  expect(Result.isSuccess(result)).toBe(true);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.code).toBe("LANDO_CONFIG_PREEXISTING_ISSUES");
  expect(warnings[0]?.message).toContain("defaultProvidreId");
  expect(warnings[0]?.message).toContain("tracing.otlp.headers");
  expect(warnings[0]?.message).not.toContain("router.httpPort");
  expect(warnings[0]?.message).toContain("lando config unset");
  expect(await readFile(join(root, "config.yml"), "utf8")).toStartWith("# my comment\n");
});

test.each(["router.httpPort", "router.httpsPort"])(
  "rejects an invalid set at %s without modifying the file",
  async (key) => {
    // Given
    const before = "# my comment\nrouter:\n  httpPort: 99999\ndefaultProvidreId: docker\n";
    await writeFile(join(root, "config.yml"), before);
    // When
    const { result, warnings } = await run({ subcommand: "set", key, value: "70000", type: "number" });
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        _tag: "LandofileWriteValidationError",
        issues: [{ path: key.split(".") }],
      });
    expect(warnings).toEqual([]);
    expect(await readFile(join(root, "config.yml"), "utf8")).toBe(before);
  },
);

test.each(["view", "validate"] as const)(
  "%s host-event schema failures omit received secret-bearing objects",
  async (subcommand) => {
    const secret = "host-event-config-secret-canary-674321";
    await writeFile(
      join(root, "config.yml"),
      `hostEvents:\n  pre-start:\n    - cmd:\n        API_TOKEN: ${secret}\n`,
    );
    const { result } = await run({ subcommand });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure).toMatchObject({ _tag: "ConfigError" });
    expect(JSON.stringify(result.failure)).not.toContain(secret);
  },
);

test("raw view preserves a YAML ConfigError instead of attempting schema decode", async () => {
  await writeFile(join(root, "config.yml"), "router: [\n");
  const { result } = await run({ source: "raw" });
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) return;
  expect(result.failure).toMatchObject({
    _tag: "ConfigError",
    path: join(root, "config.yml"),
    remediation: expect.stringContaining("YAML syntax"),
  });
  expect("issues" in result.failure ? result.failure.issues : undefined).toBeUndefined();
});

test.each([
  { subcommand: "view", source: "resolved" },
  { subcommand: "view", source: "raw" },
  { subcommand: "validate" },
  { subcommand: "edit" },
] as const)("$subcommand $source omits malformed YAML secrets", async (options) => {
  // Given a parser failure containing an opaque secret.
  const secret = "opaque-canary-malformed-yaml";
  await writeFile(join(root, "config.yml"), `tracing:\n  otlp:\n    headers: [${secret}\n`);
  // When reading, validating, or editing the malformed document.
  const { result } = await run({
    ...options,
    editorRunner: async () => ({ kind: "edited", content: `tracing:\n  otlp:\n    headers: [${secret}\n` }),
  });
  // Then the failure carries syntax location, never the rejected bytes.
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) return;
  expect(JSON.stringify(result.failure)).not.toContain(secret);
  expect(result.failure.message).toContain(
    options.subcommand === "edit" ? "not valid YAML" : "Invalid YAML in config file",
  );
  expect(result.failure.message).toContain("line 3, column 14");
});

test("inferred set reports an invalid external layer once", async () => {
  // Given a valid file, an invalid env override, and a value whose text form fails first.
  await writeFile(join(root, "config.yml"), "router:\n  httpPort: 8080\n");
  // When the value type is inferred.
  const { result, warnings } = await run(
    { subcommand: "set", key: "router.httpPort", value: "8090" },
    { LANDO_ROUTER_HTTPS_PORT: "99999" },
  );
  // Then the write succeeds and the external problem is reported exactly once.
  expect(Result.isSuccess(result)).toBe(true);
  expect(warnings.filter((warning) => warning.code === "LANDO_CONFIG_OTHER_SOURCE_INVALID")).toHaveLength(1);
  expect(await readFile(join(root, "config.yml"), "utf8")).toBe("router:\n  httpPort: 8090\n");
});
