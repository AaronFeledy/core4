import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { type Context, Effect } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";
import type { LandofileService } from "@lando/sdk/services";

import { loadUserLandofile } from "@lando/engine/landofile/app-resolution";

test("loadUserLandofile resolves toolingIncludes-only injected services", async () => {
  // Given an injected Landofile service whose only include surface is toolingIncludes
  const appRoot = await mkdtemp(join(tmpdir(), "lando-app-resolution-tooling-"));
  const previous = process.cwd();
  try {
    await writeFile(join(appRoot, ".lando.yml"), "name: injected\n", "utf8");
    await writeFile(join(appRoot, "tasks.yml"), "tooling:\n  build:\n    cmd: make\n", "utf8");
    process.chdir(appRoot);
    const shape: LandofileShape = {
      name: "injected",
      toolingIncludes: { docs: { file: "./tasks.yml" } },
    };
    const service = { discover: Effect.succeed(shape) } satisfies Context.Tag.Service<
      typeof LandofileService
    >;

    // When the user Landofile is loaded through the injected service path
    const resolved = await Effect.runPromise(loadUserLandofile(service));

    // Then the tooling include is resolved instead of returning the injected shape untouched
    expect(resolved.tooling?.["docs:build"]?.cmd).toBe("make");
    expect(resolved.toolingIncludes).toBeUndefined();
  } finally {
    process.chdir(previous);
    await rm(appRoot, { recursive: true, force: true });
  }
});
