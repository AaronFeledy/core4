import { describe, expect, test } from "bun:test";
import { lowerComposeFields } from "../src/compose-fields.ts";
import type { Lando3Path } from "../src/contract.ts";
import type { ServiceLoweringContext } from "../src/lowering-contract.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "app",
  keyPath: ["services", "app"],
  fallbackSourceId: "canonical",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};
const options = { basePath: ["overrides"] } as const;

describe("Compose field lowering", () => {
  test("preserves supported fields when lowering overrides", () => {
    // Given
    const input = {
      image: "php:8.3",
      build: "./php",
      platform: "linux/amd64",
      environment: { A: "1" },
      volumes: [".:/app", "data:/data"],
      ports: ["8080:80", { target: 443, published: "8443" }],
      logging: { driver: "json-file" },
      restart: "always",
      depends_on: ["db"],
      extra_hosts: ["host:127.0.0.1"],
    };
    // When
    const result = lowerComposeFields(input, ctx, options);
    // Then
    const { depends_on, ...rest } = input;
    expect(result.patch).toEqual({ ...rest, build: { context: "./php" }, dependsOn: depends_on });
    expect(result.blocked).toBeUndefined();
    expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
      { kind: "rewritten", keyPath: [...ctx.keyPath, "overrides", "build"] },
      { kind: "needs-review", keyPath: [...ctx.keyPath, "overrides", "platform"] },
      { kind: "needs-review", keyPath: [...ctx.keyPath, "overrides", "logging"] },
      { kind: "needs-review", keyPath: [...ctx.keyPath, "overrides", "restart"] },
      { kind: "rewritten", keyPath: [...ctx.keyPath, "overrides", "depends_on"] },
      { kind: "needs-review", keyPath: [...ctx.keyPath, "overrides", "extra_hosts"] },
    ]);
    expect(result.diagnostics.every((entry) => Boolean(entry.remediation))).toBe(true);
  });

  const rejected: ReadonlyArray<readonly [Record<string, unknown>, Lando3Path]> = [
    [{ tty: true }, ["tty"]],
    [{ stdin_open: true }, ["stdin_open"]],
    [{ links: ["db"] }, ["links"]],
    [{ network_mode: "host" }, ["network_mode"]],
    [{ container_name: "app" }, ["container_name"]],
    [{ ports: ["80:80", { target: 80, mode: "host" }] }, ["ports", 1, "mode"]],
    [{ volumes: [{ source: ".", target: "/app", consistency: "cached" }] }, ["volumes", 0, "consistency"]],
    ...["ssh", "secrets", "cache_from"].map((key): readonly [Record<string, unknown>, Lando3Path] => [
      { build: { context: ".", [key]: true } },
      ["build", key],
    ]),
  ];
  test.each(rejected)("blocks when execution-shaping input %j is present", (input, path) => {
    // Given: the rejected input and its relative path.
    // When
    const result = lowerComposeFields(input, ctx, options);
    // Then
    expect(result.blocked).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      kind: "unsupported",
      sourceId: "canonical",
      keyPath: [...ctx.keyPath, "overrides", ...path],
    });
    expect(result.diagnostics[0]?.remediation).toBeTruthy();
  });

  test.each(["environment", "labels"])("normalizes lists when %s uses assignments", (key) => {
    // Given
    const input = { [key]: ["A=1", "B=2", "TOKEN=a=b", "EMPTY="] };
    // When
    const result = lowerComposeFields(input, ctx, options);
    // Then
    expect(result.patch).toEqual({ [key]: { A: "1", B: "2", TOKEN: "a=b", EMPTY: "" } });
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(key === "labels" ? ["needs-review"] : []);
  });

  test.each(["environment", "labels"])("drops null entries when %s is a scalar mapping", (key) => {
    // Given
    const input = { [key]: { A: 1, B: false, C: null } };
    // When
    const result = lowerComposeFields(input, ctx, options);
    // Then
    expect(result.patch).toEqual({ [key]: { A: "1", B: "false" } });
    expect(result.diagnostics.filter(({ kind }) => kind === "dropped")).toEqual([
      expect.objectContaining({ kind: "dropped", keyPath: [...ctx.keyPath, "overrides", key, "C"] }),
    ]);
    expect(result.diagnostics).toHaveLength(key === "labels" ? 2 : 1);
  });

  test.each([
    ["working_dir", "workingDirectory"],
    ["env_file", "envFile"],
  ])("renames %s when normalized", (key, target) => {
    // Given
    const input = { [key]: "/tmp" };
    // When
    const result = lowerComposeFields(input, ctx, { basePath: [] });
    // Then
    expect(result.patch).toEqual({ [target]: "/tmp" });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "rewritten", keyPath: [...ctx.keyPath, key] });
  });

  test("normalizes build fields when a build mapping is supplied", () => {
    // Given
    const input = {
      build: {
        context: ".",
        dockerfile: "Dockerfile.dev",
        dockerfile_inline: "FROM scratch",
        args: ["A=1"],
        target: "dev",
      },
    };
    // When
    const result = lowerComposeFields(input, ctx, { basePath: ["services"] });
    // Then
    expect(result.patch).toEqual({
      build: {
        context: ".",
        dockerfile: "Dockerfile.dev",
        dockerfileInline: "FROM scratch",
        args: { A: "1" },
        target: "dev",
      },
    });
    expect(result.blocked).toBeUndefined();
  });

  test("drops unknown fields without blocking when no model exists", () => {
    // Given
    const input = { frobnicate: 1 };
    // When
    const result = lowerComposeFields(input, ctx, options);
    // Then
    expect(result.patch).toEqual({});
    expect(result.blocked).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      kind: "dropped",
      keyPath: [...ctx.keyPath, "overrides", "frobnicate"],
    });
  });

  test.each(["pull_policy", "gpus", "deploy"])("warns when fragile capability %s is preserved", (key) => {
    // Given
    const input = { [key]: "requested" };
    // When
    const result = lowerComposeFields(input, ctx, options);
    // Then
    expect(result.patch).toEqual(input);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.kind).toBe("needs-review");
    expect(result.diagnostics[0]?.remediation).toBeTruthy();
  });

  test("is deterministic when the same input is lowered twice", () => {
    // Given
    const input = Object.freeze({ build: "./php", tty: true, environment: Object.freeze(["Z=1", "A=2"]) });
    // When
    const results = [lowerComposeFields(input, ctx, options), lowerComposeFields(input, ctx, options)];
    // Then
    expect(results[0]).toEqual(results[1]);
  });
});
