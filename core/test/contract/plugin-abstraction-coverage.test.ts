import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

import * as sdkTest from "@lando/sdk/test";

/**
 * Plugin contract-kit layer-coverage gate.
 *
 * Each plugin abstraction that publishes a shared contract suite in
 * `@lando/sdk/test` must have at least one built-in invocation — a `core/test/**`
 * file that runs that suite against the shipped built-in implementation(s).
 *
 * This gate fails when:
 *   - a published `make*ContractSuite` / `run*ContractSuite` export goes missing
 *     or is renamed (the manifest entry no longer resolves to a real export);
 *   - a manifest entry that is supposed to have a built-in invocation loses it
 *     (the invocation file is deleted, or stops calling the suite);
 *   - someone tries to satisfy coverage with an `sdk/test/**` self-test instead
 *     of a real core built-in invocation.
 *
 * `defaultPolicy: "none-bundled"` is a principled exception, not a loophole:
 * core ships no bundled implementation for that abstraction (e.g. `ConfigTranslator`),
 * so the SDK self-test is the only coverage that can exist until a plugin ships one.
 * The gate still requires its suite exports.
 */

type DefaultPolicy =
  /** A concrete built-in implementation ships in core and is run through the suite. */
  | "built-in"
  /**
   * The abstraction is schema-only in core today (no concrete pluggable class),
   * so the built-in invocation runs the suite over documented reference
   * transforms. Still a real `core/test/**` invocation.
   */
  | "reference-mirror"
  /** No bundled built-in in core; only the SDK self-test can exist until a plugin contributes. */
  | "none-bundled";

interface CoverageEntry {
  /** Plugin-abstraction name (matches the contract-kit manifest row). */
  readonly abstraction: string;
  /** The `make*ContractSuite` export from `@lando/sdk/test`. */
  readonly makeExport: string;
  /** The `run*ContractSuite` export from `@lando/sdk/test`. */
  readonly runExport: string;
  /** How the built-in coverage is provided. */
  readonly defaultPolicy: DefaultPolicy;
  /**
   * The `core/test/**` files (repo-relative) that invoke the suite against the
   * built-in(s). Empty only for `none-bundled`.
   */
  readonly invocationFiles: ReadonlyArray<string>;
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/**
 * Canonical plugin-abstraction contract-kit manifest. Adding a new abstraction
 * with a published suite means adding a row here AND a built-in invocation
 * (unless core ships none bundled by default).
 */
const COVERAGE_MANIFEST: ReadonlyArray<CoverageEntry> = [
  {
    abstraction: "ToolingEngine",
    makeExport: "makeToolingEngineContractSuite",
    runExport: "runToolingEngineContractSuite",
    defaultPolicy: "built-in",
    invocationFiles: ["core/test/services/tooling-engine-contract.test.ts"],
  },
  {
    abstraction: "RouteFilter",
    makeExport: "makeRouteFilterContractSuite",
    runExport: "runRouteFilterContractSuite",
    defaultPolicy: "reference-mirror",
    invocationFiles: ["core/test/subsystems/proxy/route-filter-contract.test.ts"],
  },
  {
    abstraction: "ProxyService",
    makeExport: "makeProxyServiceContractSuite",
    runExport: "runProxyServiceContractSuite",
    defaultPolicy: "built-in",
    invocationFiles: ["core/test/subsystems/proxy/traefik-contract.test.ts"],
  },
  {
    abstraction: "SecretStore",
    makeExport: "makeSecretStoreContractSuite",
    runExport: "runSecretStoreContractSuite",
    defaultPolicy: "built-in",
    invocationFiles: ["core/test/services/secret-store-contract.test.ts"],
  },
  {
    abstraction: "ConfigTranslator",
    makeExport: "makeConfigTranslatorContractSuite",
    runExport: "runConfigTranslatorContractSuite",
    // None bundled by default — core ships no ConfigTranslator; the SDK self-test
    // is the only coverage until a plugin contributes one.
    defaultPolicy: "none-bundled",
    invocationFiles: [],
  },
  {
    abstraction: "PluginSource",
    makeExport: "makePluginSourceContractSuite",
    runExport: "runPluginSourceContractSuite",
    defaultPolicy: "reference-mirror",
    invocationFiles: ["core/test/services/plugin-source-contract.test.ts"],
  },
  {
    abstraction: "DoctorCheck",
    makeExport: "makeDoctorCheckContractSuite",
    runExport: "runDoctorCheckContractSuite",
    defaultPolicy: "built-in",
    invocationFiles: ["core/test/cli/doctor-check-contract.test.ts"],
  },
  {
    abstraction: "TunnelService",
    makeExport: "makeTunnelServiceContractSuite",
    runExport: "runTunnelServiceContract",
    defaultPolicy: "reference-mirror",
    invocationFiles: ["core/test/tunnel/contract.test.ts"],
  },
  {
    abstraction: "RemoteSource",
    makeExport: "makeRemoteSourceContractSuite",
    runExport: "runRemoteSourceContract",
    defaultPolicy: "reference-mirror",
    invocationFiles: ["core/test/remote-sync/contract.test.ts"],
  },
  {
    abstraction: "Dataset",
    makeExport: "makeDatasetContractSuite",
    runExport: "runDatasetContract",
    defaultPolicy: "reference-mirror",
    invocationFiles: ["core/test/remote-sync/contract.test.ts"],
  },
];

/**
 * Standalone contract suites that ship from `@lando/sdk/test` but are not part of
 * the six-abstraction plugin-abstraction kit (or its freeze-surface siblings).
 * They must remain published without requiring a core built-in kit invocation.
 */
const STANDALONE_MAKE_SUITE_EXPORTS = new Set(["makeRendererPanelContractSuite"]);

/** Kit-facing `make*ContractSuite` exports published on `@lando/sdk/test`. */
const publishedMakeSuiteExports = (): ReadonlyArray<string> =>
  Object.keys(sdkTest as Record<string, unknown>).filter(
    (name) =>
      name.startsWith("make") && name.endsWith("ContractSuite") && !STANDALONE_MAKE_SUITE_EXPORTS.has(name),
  );

const kitMakeSuiteExports = (): ReadonlySet<string> =>
  new Set(COVERAGE_MANIFEST.map((entry) => entry.makeExport));

const readInvocationSource = (repoRelative: string): string =>
  readFileSync(resolve(REPO_ROOT, repoRelative), "utf8");

const fileCallsExport = (repoRelative: string, exportName: string): boolean => {
  const file = resolve(REPO_ROOT, repoRelative);
  const source = ts.createSourceFile(file, readInvocationSource(repoRelative), ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === exportName
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
};

describe("plugin-abstraction contract-kit layer coverage", () => {
  test("every manifest suite export exists on @lando/sdk/test", () => {
    const surface = sdkTest as Record<string, unknown>;
    for (const entry of COVERAGE_MANIFEST) {
      expect(typeof surface[entry.makeExport]).toBe("function");
      expect(typeof surface[entry.runExport]).toBe("function");
    }
  });

  test("every published make*ContractSuite export is enumerated in the manifest", () => {
    const manifestMakeExports = new Set(COVERAGE_MANIFEST.map((entry) => entry.makeExport));
    const KIT_MAKE_EXPORTS = kitMakeSuiteExports();
    const published = publishedMakeSuiteExports();
    for (const exportName of published) {
      expect(manifestMakeExports.has(exportName)).toBe(true);
    }
    // And every kit export the manifest claims must actually be published.
    for (const exportName of KIT_MAKE_EXPORTS) {
      expect(published.includes(exportName)).toBe(true);
    }
  });

  test("manifest abstraction names and exports are unique", () => {
    const abstractions = COVERAGE_MANIFEST.map((entry) => entry.abstraction);
    const makeExports = COVERAGE_MANIFEST.map((entry) => entry.makeExport);
    const runExports = COVERAGE_MANIFEST.map((entry) => entry.runExport);
    expect(new Set(abstractions).size).toBe(abstractions.length);
    expect(new Set(makeExports).size).toBe(makeExports.length);
    expect(new Set(runExports).size).toBe(runExports.length);
  });

  test("every non-none-bundled abstraction has a real core built-in invocation", () => {
    for (const entry of COVERAGE_MANIFEST) {
      if (entry.defaultPolicy === "none-bundled") {
        expect(entry.invocationFiles.length).toBe(0);
        continue;
      }
      expect(entry.invocationFiles.length).toBeGreaterThan(0);
      for (const file of entry.invocationFiles) {
        // The invocation must live in core/test (a real built-in invocation),
        // never sdk/test (a suite self-test).
        expect(file.startsWith("core/test/")).toBe(true);
        expect(file.startsWith("sdk/test/")).toBe(false);
        expect(existsSync(resolve(REPO_ROOT, file))).toBe(true);
        // The file must actually call the suite (make or run form), so a
        // comment/string containing the name does not satisfy the gate.
        const callsSuite = fileCallsExport(file, entry.makeExport) || fileCallsExport(file, entry.runExport);
        expect(callsSuite).toBe(true);
      }
    }
  });

  test("none-bundled abstractions still publish their suite exports", () => {
    const surface = sdkTest as Record<string, unknown>;
    for (const entry of COVERAGE_MANIFEST) {
      if (entry.defaultPolicy !== "none-bundled") continue;
      expect(typeof surface[entry.makeExport]).toBe("function");
      expect(typeof surface[entry.runExport]).toBe("function");
    }
  });
});
