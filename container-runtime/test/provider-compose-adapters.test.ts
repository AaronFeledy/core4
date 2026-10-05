import { describe, expect, test } from "bun:test";
import { FileIoError, ProviderInternalError } from "@lando/sdk/errors";
import { AppPlan } from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";
import { Effect, Schema, Stream } from "effect";
import { renderCompose } from "../src/podman/compose.ts";
import { composeAdaptersFor } from "../src/provider-assembly.ts";

const plan = Schema.decodeSync(AppPlan)({
  id: "compose",
  name: "compose",
  slug: "compose",
  root: "/app",
  provider: "lando",
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
});
const ctx = { providerId: "custom", remediation: "Custom provider remediation." };

describe("provider compose adapters", () => {
  test("renders the shared serializer output", () => {
    const adapters = composeAdaptersFor(ctx);
    const content = adapters.renderCompose(plan);
    expect(content).toBe(renderCompose(plan, ctx));
  });
  test("uses the caller's data root and plan identity for its path", () => {
    const adapters = composeAdaptersFor(ctx);
    const path = adapters.composePath(plan, { userDataRoot: "/custom-data" });
    expect(path).toBe("/custom-data/apps/compose/compose.yml");
  });
  test("retains provider context when emitting fails", async () => {
    const adapters = composeAdaptersFor(ctx);
    const failure = new FileIoError({ message: "Read-only filesystem", path: "/custom-data" });
    const fileSystem = FileSystem.of({
      read: () => Stream.fail(failure),
      readText: () => Effect.fail(failure),
      write: () => Effect.fail(failure),
      writeAtomic: () => Effect.fail(failure),
      exists: () => Effect.succeed(false),
      stat: () => Effect.fail(failure),
      lstat: () => Effect.fail(failure),
      mkdir: () => Effect.fail(failure),
      remove: () => Effect.fail(failure),
      readDir: () => Effect.fail(failure),
      readFile: () => Effect.fail(failure),
      writeFile: () => Effect.fail(failure),
    });
    const error = await Effect.runPromise(
      adapters
        .emitCompose(plan, { userDataRoot: "/custom-data" })
        .pipe(Effect.provideService(FileSystem, fileSystem), Effect.flip),
    );
    expect(error).toBeInstanceOf(ProviderInternalError);
    expect(error.providerId).toBe("custom");
    expect(error.remediation).toBe("Custom provider remediation.");
    expect(error.message).toBe("Failed to emit provider-custom Compose file.");
  });
});
