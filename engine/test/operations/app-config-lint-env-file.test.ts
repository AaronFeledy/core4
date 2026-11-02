import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { FileSystem, PathsService, PluginRegistry, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const lintApp = (cwd: string) =>
  Effect.runPromise(
    appConfigLint({ cwd }).pipe(Effect.provide(Layer.merge(PluginRegistryLayer.layer, BunFileSystem.layer))),
  );

test.each([
  { scope: "app.name", value: "demo", owner: "app" },
  { scope: "proxy.defaultDomain", value: "lndo.site", owner: "app" },
  { scope: "app.name", value: "demo", owner: "service" },
  { scope: "proxy.defaultDomain", value: "lndo.site", owner: "service" },
])("resolves $owner env-file paths from $scope before linting", async ({ scope, value, owner }) => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-deferred-"));
  try {
    const path = `{{ ${scope} }}.env`;
    await writeFile(
      join(root, ".lando.yml"),
      owner === "app"
        ? `name: demo\nenv_file: '${path}'\n`
        : `name: demo\nservices:\n  web:\n    type: compose\n    image: alpine\n    home: false\n    envFile: '${path}'\n`,
    );
    await writeFile(join(root, `${value}.env`), "KEY=value\n");
    const result = await lintApp(root);
    expect(result).toMatchObject({ valid: true, violations: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("warns when a double-quoted env value decodes differently from its raw text", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-escape-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: env-lint-escape\nenv_file: [runtime.env]\n");
    await writeFile(join(root, "runtime.env"), 'PATH="C:\\new"\n');

    const result = await lintApp(root);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([
      expect.objectContaining({
        path: ["env_file", 0],
        rule: "env-file.literal",
        severity: "warning",
        message: expect.stringContaining("decodes differently from its raw text"),
        suggestion: expect.stringContaining("single quotes"),
      }),
    ]);
    expect(result.violations[0]?.message).toContain("PATH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attributes deferred-path warnings to the declaring configuration entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-deferred-warning-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: demo\nservices:\n  web:\n    type: compose\n    image: alpine\n    home: false\n    env_file: '{{ app.name }}.env'\n",
    );
    await writeFile(join(root, "demo.env"), 'PATH="C:\\new"\n');
    const result = await lintApp(root);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).not.toContain("{{");
    expect(result.violations).toMatchObject([
      {
        rule: "env-file.literal",
        severity: "warning",
        path: ["services", "web", "envFile", 0],
        source: { file: join(root, ".lando.yml"), path: ["services", "web", "env_file"] },
        message: expect.stringContaining(`${join(root, "demo.env")}:1:`),
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps escaped literal env-file paths literal after resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-literal-path-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: demo\nenv_file: '{{{{ app.name }}.env'\n");
    await writeFile(join(root, "{{ app.name }}.env"), "KEY=value\n");
    const result = await lintApp(root);
    expect(result).toMatchObject({ valid: true, violations: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not read env-file sites held behind an unavailable service credential scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-blocked-path-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: demo\nservices:\n  db:\n    type: missing-type\n  web:\n    type: compose\n    image: alpine\n    home: false\n    envFile: '{{ services.db.creds.password }}.env'\n",
    );
    const envReads: string[] = [];
    const result = await Effect.runPromise(
      Effect.flatMap(FileSystem, (fs) =>
        appConfigLint({ cwd: root }).pipe(
          Effect.provideService(FileSystem, {
            ...fs,
            readText: (path) =>
              Effect.sync(() => {
                if (path.endsWith(".env")) envReads.push(path);
              }).pipe(Effect.andThen(fs.readText(path))),
          }),
        ),
      ).pipe(Effect.provide(Layer.merge(PluginRegistryLayer.layer, BunFileSystem.layer))),
    );
    expect(result.valid).toBe(false);
    expect(envReads).toEqual([]);
    expect(result.violations.some((issue) => issue.rule === "landofile.service")).toBe(true);
    expect(result.violations.some((issue) => issue.rule === "env-file.read")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("warns when an env value contains ${ without failing the lint", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-interp-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: env-lint-interp\nenv_file: [runtime.env]\n");
    await writeFile(join(root, "runtime.env"), "TOKEN=${SECRET}\n");

    const result = await lintApp(root);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([
      expect.objectContaining({
        path: ["env_file", 0],
        rule: "env-file.literal",
        severity: "warning",
        message: expect.stringContaining("${"),
        suggestion: expect.stringContaining("{{ env.* }}"),
      }),
    ]);
    expect(result.violations[0]?.suggestion).toContain("single quotes");
    expect(result.violations[0]?.suggestion).not.toContain("$$");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats a bare NAME env line as an error with environment remediation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-bare-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: env-lint-bare\nenv_file: [runtime.env]\n");
    await writeFile(join(root, "runtime.env"), "NAME\n");

    const result = await lintApp(root);

    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        path: ["env_file", 0],
        rule: "env-file.syntax",
        severity: "error",
        message: expect.stringContaining("Expected KEY=VALUE."),
        suggestion: 'environment: { NAME: "{{ env.NAME }}" }',
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails lint when a declared env file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-missing-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: env-lint-missing\nenv_file: [missing.env]\n");

    const result = await lintApp(root);

    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        path: ["env_file", 0],
        message: expect.stringContaining("Unable to read env file"),
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not add env-file warnings when no env file is declared", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-none-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: env-lint-none\n");

    const result = await lintApp(root);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect("warnings" in result).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merges env errors and warnings with fragment, tooling, event and capability findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-merged-"));
  try {
    await writeFile(join(root, ".lando.base.yml"), "runtime: wrong\n");
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: merged",
        "runtime: 4",
        "env_file: [missing.env, literal.env]",
        "services:",
        "  web:",
        "    type: compose",
        "    image: alpine",
        "    home: false",
        "    privileged: true",
        "tooling:",
        "  run:",
        "    cmd: echo check",
        "    service: ':host'",
        "events:",
        "  pre-unknown-task: [echo check]",
      ].join("\n"),
    );
    await writeFile(join(root, "literal.env"), 'PATH="C:\\new"\n');
    const result = await Effect.runPromise(
      Effect.flatMap(PluginRegistry, (registry) =>
        appConfigLint({ cwd: root }).pipe(
          Effect.provideService(PluginRegistry, {
            ...registry,
            declaredProviderCapabilities: () => ({
              ...TestRuntimeProvider.capabilities,
              composeKnobs: { supported: [] },
            }),
          }),
        ),
      ).pipe(Effect.provide(Layer.merge(PluginRegistryLayer.layer, BunFileSystem.layer))),
    );
    expect(result.valid).toBe(false);
    const rules = result.violations.map((finding) => finding.rule);
    expect(rules).toContain("env-file.read");
    expect(rules).toContain("env-file.literal");
    expect(rules).toContain("landofile.tooling");
    expect(rules).toContain("landofile.event");
    expect(rules).toContain("landofile.capability");
    expect(result.violations.some((finding) => finding.path.join(".") === "runtime")).toBe(true);
    expect(result.violations.every((finding) => finding.source !== undefined)).toBe(true);
    expect(result.violations.filter((finding) => finding.path.join(".") === "env_file.0")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves included Compose env files relative to their Compose document", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-compose-"));
  try {
    await mkdir(join(root, "compose"));
    await writeFile(
      join(root, ".lando.yml"),
      "name: included\nincludes:\n  - source: ./compose/compose.yml\n    kind: compose\n",
    );
    await writeFile(
      join(root, "compose", "compose.yml"),
      "services:\n  web:\n    image: alpine\n    env_file: runtime.env\n",
    );
    await writeFile(join(root, "compose", "runtime.env"), 'PATH="C:\\new"\n');
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(
        Effect.provide(
          Layer.mergeAll(
            PluginRegistryLayer.layer,
            BunFileSystem.layer,
            Layer.succeed(PathsService, makeLandoPaths({ userCacheRoot: join(root, "cache") })),
            Layer.succeed(
              StateStore,
              makeStateStore({
                privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
              }),
            ),
          ),
        ),
      ),
    );
    expect(result.violations.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
    const finding = result.violations.find((issue) => issue.rule === "env-file.literal");
    expect(finding?.path).toEqual(["services", "web", "envFile", 0]);
    expect(finding?.message).toContain(join(root, "compose", "runtime.env"));
    expect(finding?.source).toMatchObject({ file: join(root, "compose", "compose.yml") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses one env-file snapshot for diagnostics and service resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-snapshot-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: snapshot\nenv_file: runtime.env\nservices:\n  web:\n    type: compose\n    image: alpine\n    env_file: runtime.env\n    home: false\n",
    );
    let reads = 0;
    const result = await Effect.runPromise(
      Effect.flatMap(FileSystem, (fs) =>
        appConfigLint({ cwd: root }).pipe(
          Effect.provideService(FileSystem, {
            ...fs,
            readText: (path) =>
              path === join(root, "runtime.env")
                ? Effect.sync(() => {
                    reads += 1;
                    return reads === 1 ? 'PATH="C:\\new"\n' : "NAME\n";
                  })
                : fs.readText(path),
          }),
        ),
      ).pipe(Effect.provide(Layer.merge(PluginRegistryLayer.layer, BunFileSystem.layer))),
    );
    expect(result.valid).toBe(true);
    expect(reads).toBe(1);
    expect(result.violations.filter((issue) => issue.rule === "env-file.literal")).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
