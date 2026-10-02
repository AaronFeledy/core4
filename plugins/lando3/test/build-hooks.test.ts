import { describe, expect, it } from "bun:test";
import { LEGACY_TAGGED, type LegacyTagged } from "@lando/sdk/landofile";
import { lowerBuildHooks } from "../src/build-hooks.ts";
import { type ServiceLoweringContext, emptyPatch } from "../src/lowering-contract.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "appserver",
  keyPath: ["services", "appserver"],
  fallbackSourceId: "canonical",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};

describe("lowerBuildHooks", () => {
  it("orders root before user and internal before authored phases when all hooks exist", () => {
    // Given
    const service = {
      build: ["user build 1", "user build 2"],
      build_internal: ["internal build 1", "internal build 2"],
      build_as_root: ["root build 1", "root build 2"],
      build_as_root_internal: ["internal root build 1", "internal root build 2"],
      run: ["user run 1", "user run 2"],
      run_internal: ["internal run 1", "internal run 2"],
      run_as_root: ["root run 1", "root run 2"],
      run_as_root_internal: ["internal root run 1", "internal root run 2"],
    };
    // When
    const result = lowerBuildHooks(service, ctx, { meUser: "www-data" });
    // Then
    expect(result.patch.build).toEqual({
      artifact: [
        { run: "internal root build 1", user: "root" },
        { run: "internal root build 2", user: "root" },
        { run: "root build 1", user: "root" },
        { run: "root build 2", user: "root" },
        { run: "internal build 1", user: "www-data" },
        { run: "internal build 2", user: "www-data" },
        { run: "user build 1", user: "www-data" },
        { run: "user build 2", user: "www-data" },
      ],
      app: [
        { run: "internal root run 1", user: "root" },
        { run: "internal root run 2", user: "root" },
        { run: "root run 1", user: "root" },
        { run: "root run 2", user: "root" },
        { run: "internal run 1", user: "www-data" },
        { run: "internal run 2", user: "www-data" },
        { run: "user run 1", user: "www-data" },
        { run: "user run 2", user: "www-data" },
      ],
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: "rewritten", keyPath: [...ctx.keyPath, "build"] }),
    ]);
  });

  it.each([{}, { meUser: "" }])(
    "omits user on non-root steps when no nonempty user is supplied: %j",
    (options) => {
      // Given
      const service = { build_as_root: "root build", build: "build", run_as_root: "root run", run: "run" };
      // When
      const result = lowerBuildHooks(service, ctx, options);
      // Then
      expect(result.patch.build).toStrictEqual({
        artifact: [{ run: "root build", user: "root" }, { run: "build" }],
        app: [{ run: "root run", user: "root" }, { run: "run" }],
      });
    },
  );

  it("preserves multiline strings when an empty internal phase precedes them", () => {
    // Given
    const command = "printf 'hello\\n'\n  printf 'world\\n'\n";
    // When
    const result = lowerBuildHooks({ build_internal: [], build: [command] }, ctx, {});
    // Then
    expect(result.patch.build).toEqual({ artifact: [{ run: command }] });
  });

  it.each(["!load", "!import"])("blocks a tagged entry at its exact index when the tag is %s", (tag) => {
    // Given
    const tagged: LegacyTagged = {
      [LEGACY_TAGGED]: true,
      tag,
      value: "./never-read.sh",
      span: {
        start: { line: 5, column: 7, offset: 30 },
        end: { line: 5, column: 28, offset: 51 },
      },
    };
    // When
    const result = lowerBuildHooks({ build: ["first", "second", tagged] }, ctx, {});
    // Then
    expect(result.blocked).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.kind === "unsupported")).toEqual([
      expect.objectContaining({ keyPath: ["services", "appserver", "build", 2] }),
    ]);
  });

  it.each([null, 42, { run: "not a legacy string" }])(
    "blocks a non-string hook when its value is %j",
    (entry) => {
      // Given / When
      const result = lowerBuildHooks({ run_internal: [entry] }, ctx, {});
      // Then
      expect(result.blocked).toBe(true);
      expect(result.patch).not.toHaveProperty("build");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ kind: "unsupported", keyPath: [...ctx.keyPath, "run_internal", 0] }),
      ]);
    },
  );

  it("maps image and app when the API-4 build object contains strings", () => {
    // Given / When
    const result = lowerBuildHooks({ build: { image: "install", app: "configure" } }, ctx, {
      meUser: "www-data",
    });
    // Then
    expect(result.patch.build).toEqual({
      artifact: [{ run: "install", user: "www-data" }],
      app: [{ run: "configure", user: "www-data" }],
    });
  });

  it("preserves list order without user overrides when the API-4 build object contains lists", () => {
    // Given / When
    const result = lowerBuildHooks({ build: { image: ["a", "b"], app: ["c", "d"] } }, ctx, {});
    // Then
    expect(result.patch.build).toStrictEqual({
      artifact: [{ run: "a" }, { run: "b" }],
      app: [{ run: "c" }, { run: "d" }],
    });
  });

  it("retains one dropped diagnostic when API-4 dockerfile is the only build key", () => {
    // Given / When
    const result = lowerBuildHooks({ build: { dockerfile: "Dockerfile" } }, ctx, {});
    // Then
    expect(result.patch).not.toHaveProperty("build");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: "dropped", keyPath: [...ctx.keyPath, "build", "dockerfile"] }),
    ]);
  });

  it.each([{ build: ["install"] }, { build: { app: "configure" } }])(
    "blocks mixed build families when Compose intent is present: %j",
    (service) => {
      // Given / When
      const result = lowerBuildHooks(service, ctx, { hasComposeBuild: true });
      // Then
      expect(result.blocked).toBe(true);
      expect(result.diagnostics.filter((diagnostic) => diagnostic.kind === "unsupported")).toEqual([
        expect.objectContaining({ keyPath: [...ctx.keyPath, "build"] }),
      ]);
    },
  );

  it.each([{}, { build_internal: [] }, { build: { image: [], app: [] } }])(
    "returns emptyPatch when no hooks produce steps: %j",
    (service) => {
      // Given / When
      const result = lowerBuildHooks(service, ctx, { hasComposeBuild: true });
      // Then
      expect(result).toBe(emptyPatch);
      expect(result.patch).not.toHaveProperty("build");
    },
  );
});
