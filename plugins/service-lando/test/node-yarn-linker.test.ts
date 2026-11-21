import { expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import type { ServiceConfig } from "@lando/sdk/schema";
import type { ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { Effect } from "effect";
import { node22ServiceType } from "../src/services/node.ts";

const file = (path: string, text: string): ServiceTypeProjectFileInput => ({
  path,
  text,
  present: true,
  sha256: sha256Hex(text),
});

const resolveNode = (
  packageManager: string,
  rcFiles: readonly ServiceTypeProjectFileInput[],
  packageRoot?: ServiceConfig["packageRoot"],
) =>
  node22ServiceType.resolve({
    service: { type: "node:22", ...(packageRoot === undefined ? {} : { packageRoot }) },
    name: "web",
    appRoot: "/app",
    metadata: { resolvedAt: "2026-09-11T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
    projectFiles: [file("package.json", JSON.stringify({ packageManager })), ...rcFiles],
  });

test.each([
  ["yarn@4.5.3", undefined, true],
  ["yarn@4.5.3", "# no linker\nenableGlobalCache: false", true],
  ["yarn@4.5.3", "# comments only", true],
  ["yarn@4.5.3", '{ "nodeLinker": "pnp" }', true],
  ["yarn@4.5.3", "nodeLinker: node-modules", false],
  ["yarn@4.5.3", "nodeLinker: pnpm", false],
  ["yarn@1.22.22", "nodeLinker: pnp", false],
  ["npm@11.0.0", "nodeLinker: pnp", false],
  ["pnpm@9.15.0", "nodeLinker: pnp", false],
] as const)("%s with rc %j sets the PnP include: %s", async (pin, rc, pnp) => {
  const result = await Effect.runPromise(
    resolveNode(pin, [rc === undefined ? { path: ".yarnrc.yml", present: false } : file(".yarnrc.yml", rc)]),
  );
  expect(result.features?.find((feature) => feature.id === "lando.app-mount")?.config).toMatchObject({
    includes: pnp ? ["node_modules"] : [],
  });
});

test.each([
  ["nodeLinker: pnp", ["node_modules"]],
  ["enableGlobalCache: false", []],
] as const)("uses the nearest declared linker when the nested rc is %s", async (nestedRc, includes) => {
  const result = await Effect.runPromise(
    resolveNode(
      "yarn@4.5.3",
      [file("apps/web/.yarnrc.yml", nestedRc), file(".yarnrc.yml", "nodeLinker: node-modules")],
      "apps/web",
    ),
  );
  expect(result.features?.find((feature) => feature.id === "lando.app-mount")?.config).toMatchObject({
    includes,
  });
});

test.each([
  ["nodeLinker: [", "Expected valid YAML."],
  ["- pnp", "Expected a YAML mapping."],
  ["nodeLinker: false", "Expected nodeLinker to be a string."],
  ["nodeLinker: null", "Expected nodeLinker to be a string."],
] as const)("attributes invalid Yarn rc %j to its project file and field", async (rc, message) => {
  const result = await Effect.runPromise(
    Effect.result(resolveNode("yarn@4.5.3", [file("apps/web/.yarnrc.yml", rc)], "apps/web")),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ServiceTypeError",
      issues: [
        { message, source: { layer: "project-file", file: "apps/web/.yarnrc.yml", path: ["nodeLinker"] } },
      ],
    },
  });
});
