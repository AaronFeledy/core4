import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { ServiceConfig } from "@lando/sdk/schema";
import type { ServiceTypeProjectFileInput } from "@lando/sdk/services";

import { nodeServiceType, resolveNodeInference } from "../src/services/node.ts";

const projectFile = (path: string, text: string): ServiceTypeProjectFileInput => ({
  path,
  present: true,
  text,
  sha256: `sha256:${path}:${text.length}`,
});

const absentProjectFile = (path: string): ServiceTypeProjectFileInput => ({ path, present: false });

const resolve = (nvmrc: string | undefined, packageJson: string | undefined) =>
  resolveNodeInference([
    nvmrc === undefined ? absentProjectFile(".nvmrc") : projectFile(".nvmrc", nvmrc),
    packageJson === undefined ? absentProjectFile("package.json") : projectFile("package.json", packageJson),
  ]);

describe("bare node version inference", () => {
  test.each([
    ["22.11.0", "node:22.11.0", "22.11.0"],
    ["22.11", "node:22.11", "22.11"],
    ["22", "node:22", "22"],
    ["v22", "node:22", "22"],
    ["jod", "node:22", "22"],
    ["lts/*", "node:lts", "lts/*"],
  ] satisfies ReadonlyArray<readonly [string, string, string]>)(
    "preserves the %s constraint as %s",
    (constraint, artifact, normalizedConstraint) => {
      expect(resolve(constraint, undefined)).toMatchObject({
        artifact,
        normalizedConstraint,
        sourcePath: ".nvmrc",
      });
    },
  );

  test.each([
    ["22", ">=22.0.0 <23.0.0", "node:22"],
    ["22", "22", "node:22"],
    ["22", "^22.0.0", "node:22"],
    ["22.11", ">=22.11.0 <22.12.0", "node:22.11"],
    ["22.11", "~22.11.0", "node:22.11"],
    ["22.11.0", "22.11.0", "node:22.11.0"],
  ] satisfies ReadonlyArray<readonly [string, string, string]>)(
    "accepts compatible package engines for %s",
    (nvmrc, engines, artifact) => {
      expect(resolve(nvmrc, JSON.stringify({ engines: { node: engines } }))).toMatchObject({ artifact });
    },
  );

  test("uses package engines only when they contain the complete supported major", () => {
    expect(resolve(undefined, JSON.stringify({ engines: { node: ">=22.0.0 <23.0.0" } }))).toMatchObject({
      artifact: "node:22",
      normalizedConstraint: ">=22.0.0 <23.0.0",
      sourcePath: "package.json",
    });
  });

  test.each([
    ["18", undefined, /unsupported Node version/i],
    ["22.011", undefined, /unsupported Node version/i],
    ["22.9007199254740992", undefined, /unsupported Node version/i],
    ["22", JSON.stringify({ engines: { node: ">=22.0.0 <22.12.0" } }), /conflicts with package\.json/i],
    ["22.11", JSON.stringify({ engines: { node: ">=22.11.0 <22.11.5" } }), /conflicts with package\.json/i],
    ["lts/*", JSON.stringify({ engines: { node: "22" } }), /conflicts with package\.json/i],
    ["22.11.0", "{", /valid JSON/i],
    ["18", JSON.stringify({ engines: { node: "22" } }), /unsupported Node version/i],
    ["22.11", JSON.stringify({ engines: { node: ">=22.12.0" } }), /conflicts with package\.json/i],
    [undefined, JSON.stringify({ engines: { node: ">=22.11.0 <23" } }), /exact pin in \.nvmrc/i],
    [undefined, JSON.stringify({ engines: { node: 22 } }), /engines\.node must be a string/i],
    [undefined, "{", /valid JSON/i],
    [undefined, JSON.stringify({}), /no Node constraint/i],
    [undefined, undefined, /Add \.nvmrc or package\.json/i],
  ] satisfies ReadonlyArray<readonly [string | undefined, string | undefined, RegExp]>)(
    "rejects invalid or unprovable constraints",
    (nvmrc, packageJson, pattern) => {
      expect(() => resolve(nvmrc, packageJson)).toThrow(pattern);
    },
  );

  test("declares project files under the configured package root", () => {
    const service = { type: "node", packageRoot: "apps/web" } satisfies ServiceConfig;
    expect(nodeServiceType.projectFiles?.(service)).toEqual([
      { path: "apps/web/.nvmrc", maxBytes: 1_048_576 },
      { path: "apps/web/package.json", maxBytes: 1_048_576 },
    ]);
  });

  test.each(["apps/web", "apps\\web"])("preserves nested pins with %s paths", (root) => {
    const separator = root.includes("\\") ? "\\" : "/";
    const path = `${root}${separator}.nvmrc`;
    const inputs = [
      projectFile(path, "22.11.0"),
      projectFile(`${root}${separator}package.json`, JSON.stringify({ engines: { node: "22" } })),
    ];

    expect(resolveNodeInference(inputs)).toMatchObject({ artifact: "node:22.11.0", sourcePath: path });
  });

  test("accepts floating LTS only with unrestricted engines", () => {
    expect(resolve("lts/*", JSON.stringify({ engines: { node: "*" } }))).toMatchObject({
      artifact: "node:lts",
    });
  });

  test("returns file-only provenance without package contents", async () => {
    const projectFiles = [
      projectFile("apps/web/.nvmrc", "22.11.0\n"),
      projectFile("apps/web/package.json", JSON.stringify({ engines: { node: "22.11.0" } })),
    ];
    const resolution = await Effect.runPromise(
      nodeServiceType.resolve({
        name: "web",
        service: { type: "node", packageRoot: "apps/web" },
        appRoot: "/app",
        metadata: { resolvedAt: "2026-09-11T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
        projectFiles,
      }),
    );

    expect(resolution.normalizedConfig).toMatchObject({ type: "node:22.11.0", packageRoot: "apps/web" });
    expect(resolution.metadata).toEqual({
      node: {
        sourcePath: "apps/web/.nvmrc",
        normalizedConstraint: "22.11.0",
        artifact: "node:22.11.0",
        files: projectFiles.map((file) => ({
          path: file.path,
          present: file.present,
          ...(file.present ? { sha256: file.sha256 } : {}),
        })),
      },
    });
    expect(JSON.stringify(resolution.metadata)).not.toContain("engines");
  });
});
