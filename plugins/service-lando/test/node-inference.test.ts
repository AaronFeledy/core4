import { describe, expect, test } from "bun:test";
import type { ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { Effect } from "effect";

import { node22ServiceType, nodeServiceType } from "../src/services/node.ts";
import { NodeInferenceError, resolveNodeInference } from "../src/services/node-inference.ts";

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

const failure = (nvmrc: string | undefined, packageJson: string | undefined): NodeInferenceError => {
  try {
    resolve(nvmrc, packageJson);
  } catch (cause) {
    if (cause instanceof NodeInferenceError) return cause;
    throw cause;
  }
  throw new Error("Expected Node inference to fail.");
};

describe("bare node version inference", () => {
  test.each([
    ["22.11.0", "node:22.11.0", "22.11.0"],
    ["22.11", "node:22.11", "22.11"],
    ["22", "node:22", "22"],
    ["v22", "node:22", "22"],
    ["jod", "node:22", "22"],
    ["lts/jod", "node:22", "22"],
    ["24", "node:24", "24"],
    ["v24", "node:24", "24"],
    ["24.11", "node:24.11", "24.11"],
    ["24.11.0", "node:24.11.0", "24.11.0"],
    ["krypton", "node:24", "24"],
    ["lts/krypton", "node:24", "24"],
    ["26", "node:26", "26"],
    ["v26.1.0", "node:26.1.0", "26.1.0"],
    ["lithium", "node:26", "26"],
    ["lts/lithium", "node:26", "26"],
    ["lts/-1", "node:24", "lts/-1"],
    ["lts/-2", "node:22", "lts/-2"],
    ["lts", "node:26", "lts"],
    ["lts/*", "node:26", "lts/*"],
    ["22.11.0 # pin", "node:22.11.0", "22.11.0"],
    ["# comment\n22", "node:22", "22"],
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
    ["lts/-1", "^24.0.0", "node:24"],
    ["lts/-2", ">=22 <23", "node:22"],
  ] satisfies ReadonlyArray<readonly [string, string, string]>)(
    "accepts compatible package engines for %s",
    (nvmrc, engines, artifact) => {
      expect(resolve(nvmrc, JSON.stringify({ engines: { node: engines } }))).toMatchObject({ artifact });
    },
  );

  test("uses package engines only when they contain a complete supported major", () => {
    expect(resolve(undefined, JSON.stringify({ engines: { node: ">=22.0.0 <23.0.0" } }))).toMatchObject({
      artifact: "node:22",
      normalizedConstraint: ">=22.0.0 <23.0.0",
      sourcePath: "package.json",
    });
  });

  test.each([
    [">=20", "node:26"],
    ["*", "node:26"],
    [">=22", "node:26"],
    [">=24", "node:26"],
    [">=26", "node:26"],
    ["22 || 26", "node:26"],
    ["^24", "node:24"],
    ["22 || 24", "node:24"],
  ] satisfies ReadonlyArray<readonly [string, string]>)(
    "prefers the LTS major when engines.node %s allows it, else the highest compatible major",
    (engines, artifact) => {
      expect(resolve(undefined, JSON.stringify({ engines: { node: engines } }))).toMatchObject({ artifact });
    },
  );

  test("keeps the fix in the suggestion and lists supported majors", () => {
    expect(failure("18", undefined)).toMatchObject({
      path: [],
      message: 'Unsupported Node version "18".',
      suggestion: expect.stringMatching(
        /supported Node major \(22, 24, 26\), an LTS codename \(jod, krypton, lithium\)/,
      ),
    });
    expect(failure("lts/-3", undefined).suggestion).toMatch(/lts\/-1/u);
    expect(failure(undefined, JSON.stringify({ engines: { node: ">=22.11.0 <23" } }))).toMatchObject({
      message: expect.stringMatching(/complete supported Node image channel \(22, 24, 26\)/),
      suggestion: expect.stringMatching(/exact pin in \.nvmrc/),
    });
    expect(failure(undefined, undefined).suggestion).toMatch(/Add \.nvmrc or package\.json/);
  });

  test.each([
    ["18", undefined, /unsupported Node version/i],
    ["# comment only", undefined, /unsupported Node version/i],
    ["22.011", undefined, /unsupported Node version/i],
    ["22.9007199254740992", undefined, /unsupported Node version/i],
    ["lts/-3", undefined, /unsupported Node version/i],
    ["lts/-", undefined, /unsupported Node version/i],
    ["22", JSON.stringify({ engines: { node: ">=22.0.0 <22.12.0" } }), /conflicts with package\.json/i],
    ["22.11", JSON.stringify({ engines: { node: ">=22.11.0 <22.11.5" } }), /conflicts with package\.json/i],
    ["lts/*", JSON.stringify({ engines: { node: "22" } }), /conflicts with package\.json/i],
    ["lts/*", JSON.stringify({ engines: { node: "^24" } }), /conflicts with package\.json/i],
    ["22.11.0", "{", /valid JSON/i],
    ["18", JSON.stringify({ engines: { node: "22" } }), /unsupported Node version/i],
    ["22.11", JSON.stringify({ engines: { node: ">=22.12.0" } }), /conflicts with package\.json/i],
    [undefined, JSON.stringify({ engines: { node: ">=22.11.0 <23" } }), /does not prove/i],
    [undefined, JSON.stringify({ engines: { node: 22 } }), /^Expected a Node version range as a string\.$/u],
    [undefined, "{", /valid JSON/i],
    [undefined, JSON.stringify({}), /declares no engines\.node/i],
    [undefined, undefined, /found neither \.nvmrc nor package\.json/i],
  ] satisfies ReadonlyArray<readonly [string | undefined, string | undefined, RegExp]>)(
    "rejects invalid or unprovable constraints",
    (nvmrc, packageJson, pattern) => {
      expect(() => resolve(nvmrc, packageJson)).toThrow(pattern);
    },
  );

  test.each(["apps/web", "apps\\web"])("preserves nested pins with %s paths", (root) => {
    const separator = root.includes("\\") ? "\\" : "/";
    const path = `${root}${separator}.nvmrc`;
    const inputs = [
      projectFile(path, "22.11.0"),
      projectFile(`${root}${separator}package.json`, JSON.stringify({ engines: { node: "22" } })),
    ];

    expect(resolveNodeInference(inputs)).toMatchObject({ artifact: "node:22.11.0", sourcePath: path });
  });

  test("resolves floating LTS through the table to the current LTS major", () => {
    expect(resolve("lts/*", JSON.stringify({ engines: { node: "*" } }))).toMatchObject({
      artifact: "node:26",
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
        packageManager: null,
        files: projectFiles.map((file) => ({
          path: file.path,
          present: file.present,
          ...(file.present ? { sha256: file.sha256 } : {}),
        })),
      },
    });
    expect(JSON.stringify(resolution.metadata)).not.toContain("engines");
  });

  test("declares the same image identity as versioned Node types", () => {
    expect(nodeServiceType.identity).toEqual(node22ServiceType.identity);
  });

  test("rejects invalid globals during bare type resolution", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        nodeServiceType.resolve({
          name: "web",
          service: { type: "node", globals: { "../escape": "1.0.0" } },
          appRoot: "/app",
          metadata: { resolvedAt: "2026-09-11T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
          projectFiles: [projectFile(".nvmrc", "22.11.0"), absentProjectFile("package.json")],
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.failure)).toMatch(/Unsupported npm package "\.\.\/escape"/);
    }
  });

  test("reports an inference conflict with its own remediation", async () => {
    const remediation = "Make both project files describe compatible Node versions.";
    const result = await Effect.runPromise(
      Effect.result(
        nodeServiceType.resolve({
          name: "web",
          service: { type: "node" },
          appRoot: "/app",
          metadata: { resolvedAt: "2026-09-11T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
          projectFiles: [
            projectFile(".nvmrc", "lts/*"),
            projectFile("package.json", JSON.stringify({ engines: { node: "^24" } })),
          ],
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        remediation,
        issues: [
          {
            path: [],
            message: 'Node constraint "lts/*" conflicts with package.json engines.node "^24".',
            suggestion: remediation,
            source: { layer: "project-file", file: ".nvmrc", path: [] },
          },
        ],
      });
    }
  });

  test.each([
    ["# comment only", undefined, ".nvmrc"],
    ["18", undefined, ".nvmrc"],
    ["lts/-3", undefined, ".nvmrc"],
    [undefined, JSON.stringify({ engines: { node: "18" }, packageManager: "bun@1.2.0" }), "package.json"],
    [undefined, JSON.stringify({ engines: { node: "^22" }, packageManager: "yarn" }), "package.json"],
    [undefined, "{", "package.json"],
  ] satisfies ReadonlyArray<readonly [string | undefined, string | undefined, string]>)(
    "attributes an inference failure to the project file that caused it",
    async (nvmrc, packageJson, expected) => {
      const result = await Effect.runPromise(
        Effect.result(
          nodeServiceType.resolve({
            name: "web",
            service: { type: "node" },
            appRoot: "/app",
            metadata: { resolvedAt: "2026-09-11T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
            projectFiles: [
              nvmrc === undefined ? absentProjectFile(".nvmrc") : projectFile(".nvmrc", nvmrc),
              packageJson === undefined
                ? absentProjectFile("package.json")
                : projectFile("package.json", packageJson),
            ],
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.issues?.[0]?.source).toMatchObject({
          layer: "project-file",
          file: expected,
        });
      }
    },
  );

  test("attributes a present manifest with no version input to the service declaration", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        nodeServiceType.resolve({
          name: "web",
          service: { type: "node" },
          appRoot: "/app",
          metadata: { resolvedAt: "2026-09-11T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
          projectFiles: [
            absentProjectFile(".nvmrc"),
            projectFile("package.json", JSON.stringify({ packageManager: "pnpm@9.15.0" })),
          ],
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.issues?.[0]?.source).toBeUndefined();
  });

  test("keeps a nested packageRoot in the attributed project-file path", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        nodeServiceType.resolve({
          name: "web",
          service: { type: "node", packageRoot: "apps/web" },
          appRoot: "/app",
          metadata: { resolvedAt: "2026-09-11T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
          projectFiles: [
            projectFile("apps/web/.nvmrc", "lts/*"),
            projectFile("apps/web/package.json", JSON.stringify({ engines: { node: "^24" } })),
          ],
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.issues?.[0]?.source).toEqual({
        layer: "project-file",
        file: "apps/web/.nvmrc",
        path: [],
      });
    }
  });
});
