import { describe, expect, test } from "bun:test";
import { isAbsolute, relative, resolve } from "node:path";
import { Effect } from "effect";

import {
  ContractFailure,
  type PluginSourceContractHarness,
  type PluginSourceTaggedError,
  makePluginSourceContractSuite,
  runPluginSourceContractSuite,
} from "@lando/sdk/test";

// A tagged error modeling the containment failure the registry raises today
// (a spec that resolves outside the managed store). Future source adapters will
// surface their own tagged error with the same shape.
class TestPluginSourceError extends Error implements PluginSourceTaggedError {
  readonly _tag = "TestPluginSourceError" as const;
  readonly remediation?: string;
  constructor(message: string, remediation?: string) {
    super(message);
    this.remediation = remediation;
  }
}

interface SourceSpec {
  readonly relativePath: string;
}

// Models the registry containment guarantee: resolve a spec relative to the
// managed store root, then reject anything that escapes it (mirrors
// `resolvePluginModulePath` in core/src/plugins/registry.ts).
const makeContainmentResolver =
  (managedStoreRoot: string) =>
  (spec: SourceSpec): Effect.Effect<string, PluginSourceTaggedError> =>
    Effect.suspend(() => {
      const resolved = resolve(managedStoreRoot, spec.relativePath);
      const relativePath = relative(managedStoreRoot, resolved);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        return Effect.fail(
          new TestPluginSourceError(
            `Plugin source ${spec.relativePath} resolves outside the managed store ${managedStoreRoot}.`,
            "Point the source at a path inside the Lando-managed plugin store.",
          ),
        );
      }
      return Effect.succeed(resolved);
    });

const managedStoreRoot = resolve("/tmp/lando-managed-plugins");

const makeHarness = (): PluginSourceContractHarness<SourceSpec> => ({
  name: "registry-containment",
  source: { id: "registry" },
  resolve: makeContainmentResolver(managedStoreRoot),
  managedStoreRoot,
  containedSpec: { relativePath: "drupal/php" },
  escapingSpec: { relativePath: "../../etc/passwd" },
});

describe("PluginSource contract", () => {
  test("a containment resolver modeling the registry guarantee passes the contract", async () => {
    const exit = await Effect.runPromiseExit(runPluginSourceContractSuite(makeHarness()));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("optional network-trust, auth-redaction, and offline-locked probes pass when supplied", async () => {
    const fetchCount = 0;
    const exit = await Effect.runPromiseExit(
      runPluginSourceContractSuite({
        ...makeHarness(),
        networkTrustProbe: {
          resolve: Effect.succeed("ok"),
          observed: Effect.succeed({ proxy: "http://proxy.test:8080", ca: "/etc/lando/ca.pem" }),
          expected: { proxy: "http://proxy.test:8080", ca: "/etc/lando/ca.pem" },
        },
        authRedactionProbe: {
          token: "npm_secrettoken",
          // The rendered log already routes the token through redaction.
          renderedOutput: Effect.succeed("Authorization: Bearer [redacted]"),
        },
        offlineLockedProbe: {
          spec: { relativePath: "drupal/php" },
          // A locked source resolves from cache without contacting the network.
          resolve: (spec) => makeContainmentResolver(managedStoreRoot)(spec),
          fetchCount: Effect.sync(() => fetchCount),
        },
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
    expect(fetchCount).toBe(0);
  });

  test("a resolver that lets a spec escape the store fails the contract", async () => {
    // This resolver ignores containment and returns the escaping path verbatim.
    const leakyResolve = (spec: SourceSpec): Effect.Effect<string, PluginSourceTaggedError> =>
      Effect.succeed(resolve(managedStoreRoot, spec.relativePath));
    const exit = await Effect.runPromiseExit(
      runPluginSourceContractSuite({
        ...makeHarness(),
        resolve: leakyResolve,
      }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("an escape failure missing remediation fails the contract", async () => {
    const noRemediation = (spec: SourceSpec): Effect.Effect<string, PluginSourceTaggedError> =>
      Effect.suspend(() => {
        const resolved = resolve(managedStoreRoot, spec.relativePath);
        const relativePath = relative(managedStoreRoot, resolved);
        if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
          // Tagged but missing remediation → must fail the contract.
          return Effect.fail(new TestPluginSourceError("escapes the store"));
        }
        return Effect.succeed(resolved);
      });
    const exit = await Effect.runPromiseExit(
      runPluginSourceContractSuite({
        ...makeHarness(),
        resolve: noRemediation,
      }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("makePluginSourceContractSuite is an alias", () => {
    expect(makePluginSourceContractSuite).toBe(runPluginSourceContractSuite);
  });

  test("ContractFailure is exported", () => {
    expect(ContractFailure).toBeDefined();
  });
});
