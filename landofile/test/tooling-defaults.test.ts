import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { applyToolingDefaults } from "@lando/landofile/tooling-defaults";
import { PortablePath } from "@lando/sdk/schema";
import type { LandofileShape, ToolingDefaultsShape } from "@lando/sdk/schema";
import type { ServiceTypeResolution } from "@lando/sdk/services";

import { resolveLandofileIncludes } from "../src/includes.ts";
import { makeTestLandofilePorts } from "./support.ts";

const DEFAULT_DIR = PortablePath.make("/workspace/default");
const TASK_DIR = PortablePath.make("/workspace/task");

const defaults = {
  service: "default-service",
  dir: DEFAULT_DIR,
  env: { DEFAULT_ENV: "default-env", SHARED_ENV: "default-shared" },
  vars: { DEFAULT_VAR: "default-var", SHARED_VAR: "default-shared" },
} satisfies ToolingDefaultsShape;

const resolve = (landofile: LandofileShape, appRoot = "/workspace/app") =>
  Effect.runPromise(resolveLandofileIncludes({ landofile, appRoot }));

describe("tooling defaults", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("inherits every default and preserves authored defaults when a task omits them", async () => {
    // Given
    const landofile: LandofileShape = {
      toolingDefaults: defaults,
      tooling: { build: { cmd: "bun run build" } },
    };

    // When
    const resolved = await resolve(landofile);
    const tooling = applyToolingDefaults(resolved.tooling, resolved.toolingDefaults);

    // Then
    expect(tooling?.build).toEqual({
      cmd: "bun run build",
      service: "default-service",
      dir: DEFAULT_DIR,
      env: { DEFAULT_ENV: "default-env", SHARED_ENV: "default-shared" },
      vars: { DEFAULT_VAR: "default-var", SHARED_VAR: "default-shared" },
    });
    expect(resolved.toolingDefaults).toEqual(defaults);
  });

  test("keeps full task overrides above deliberately distinct defaults", async () => {
    // Given
    const landofile: LandofileShape = {
      toolingDefaults: defaults,
      tooling: {
        build: {
          cmd: "bun run build",
          service: "task-service",
          dir: TASK_DIR,
          env: { TASK_ENV: "task-env", SHARED_ENV: "task-shared" },
          vars: { TASK_VAR: "task-var", SHARED_VAR: "task-shared" },
        },
      },
    };

    // When
    const resolved = await resolve(landofile);
    const tooling = applyToolingDefaults(resolved.tooling, resolved.toolingDefaults);

    // Then
    expect(tooling?.build).toEqual({
      cmd: "bun run build",
      service: "task-service",
      dir: TASK_DIR,
      env: {
        DEFAULT_ENV: "default-env",
        SHARED_ENV: "task-shared",
        TASK_ENV: "task-env",
      },
      vars: {
        DEFAULT_VAR: "default-var",
        SHARED_VAR: "task-shared",
        TASK_VAR: "task-var",
      },
    });
  });

  test("fills partial task maps per key without replacing task values", async () => {
    // Given
    const landofile: LandofileShape = {
      toolingDefaults: defaults,
      tooling: {
        lint: {
          service: "lint-service",
          env: { SHARED_ENV: "lint-shared" },
          vars: { LINT_VAR: false },
        },
      },
    };

    // When
    const resolved = await resolve(landofile);
    const tooling = applyToolingDefaults(resolved.tooling, resolved.toolingDefaults);

    // Then
    expect(tooling?.lint).toEqual({
      service: "lint-service",
      dir: DEFAULT_DIR,
      env: { DEFAULT_ENV: "default-env", SHARED_ENV: "lint-shared" },
      vars: { DEFAULT_VAR: "default-var", SHARED_VAR: "default-shared", LINT_VAR: false },
    });
  });

  test("leaves tooling unchanged when no defaults are authored", async () => {
    // Given
    const landofile: LandofileShape = {
      tooling: { build: { cmd: "bun run build", env: { MODE: "task" } } },
    };

    // When
    const resolved = await resolve(landofile);

    // Then
    expect(resolved).toEqual(landofile);
  });

  test("is idempotent when an already folded Landofile is resolved again", async () => {
    // Given
    const landofile: LandofileShape = {
      toolingDefaults: defaults,
      tooling: { build: { cmd: "bun run build", vars: { SHARED_VAR: "task-shared" } } },
    };

    // When
    const once = applyToolingDefaults(landofile.tooling, landofile.toolingDefaults);
    const twice = applyToolingDefaults(once, landofile.toolingDefaults);

    // Then
    expect(twice).toEqual(once);
  });

  test("accepts a service-type tooling map with the same deterministic precedence", () => {
    // Given
    const serviceTooling: NonNullable<ServiceTypeResolution["tooling"]> = {
      diagnose: {
        cmd: "check-service",
        env: { SHARED_ENV: "service-shared" },
        vars: { SERVICE_VAR: true },
      },
    };
    // When
    const first = applyToolingDefaults(serviceTooling, defaults);
    const second = applyToolingDefaults(first, defaults);

    // Then
    expect(first).toEqual(second);
    expect(first?.diagnose).toEqual({
      cmd: "check-service",
      service: "default-service",
      dir: DEFAULT_DIR,
      env: { DEFAULT_ENV: "default-env", SHARED_ENV: "service-shared" },
      vars: {
        DEFAULT_VAR: "default-var",
        SHARED_VAR: "default-shared",
        SERVICE_VAR: true,
      },
    });
  });

  test("folds defaults after include vars so include and task values stay above defaults", async () => {
    // Given
    const appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-defaults-"));
    roots.push(appRoot);
    await writeFile(
      join(appRoot, "tasks.yml"),
      ["tooling:", "  build:", "    cmd: bun run build", "    vars:", "      TASK_VALUE: task", ""].join(
        "\n",
      ),
      "utf8",
    );
    const landofile: LandofileShape = {
      toolingDefaults: {
        service: "default-service",
        vars: { DEFAULT_VALUE: "default", SHARED_VALUE: "default-shared" },
      },
      includes: [
        {
          source: "./tasks.yml",
          kind: "tooling",
          namespace: "project",
          vars: { INCLUDE_VALUE: "include", SHARED_VALUE: "include-shared" },
        },
      ],
    };

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileIncludes({
        landofile,
        appRoot,
        cacheRoot: join(appRoot, ".cache"),
        ports: makeTestLandofilePorts(join(appRoot, ".cache")),
      }),
    );
    const tooling = applyToolingDefaults(resolved.tooling, resolved.toolingDefaults);

    // Then
    expect(tooling?.["project:build"]).toEqual({
      cmd: "bun run build",
      service: "default-service",
      vars: {
        DEFAULT_VALUE: "default",
        SHARED_VALUE: "include-shared",
        INCLUDE_VALUE: "include",
        TASK_VALUE: "task",
      },
    });
    expect(resolved.toolingDefaults).toEqual(landofile.toolingDefaults);
  });
});
