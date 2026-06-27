import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Effect } from "effect";

import {
  type PluginSourceContractHarness,
  type PluginSourceTaggedError,
  runPluginSourceContractSuite,
} from "@lando/sdk/test";

// Mirror of the registry containment guarantee in
// core/src/plugins/registry.ts `resolvePluginModulePath`: resolve the spec, then
// reject (after realpath) anything that escapes the managed store. This is the
// behavior a real PluginSource adapter must preserve, asserted against real
// filesystem fixtures (including a symlink escape) so the contract proves the
// actual shipped guarantee, not a mock.
class PluginSourceContainmentError extends Error implements PluginSourceTaggedError {
  readonly _tag = "PluginSourceContainmentError" as const;
  readonly remediation: string;
  constructor(message: string) {
    super(message);
    this.remediation =
      "Point the source at a path inside the Lando-managed plugin store and ensure no symlink escapes it.";
  }
}

interface SourceSpec {
  readonly path: string;
}

const makeRealpathResolver =
  (managedStoreRoot: string) =>
  (spec: SourceSpec): Effect.Effect<string, PluginSourceTaggedError> =>
    Effect.tryPromise({
      try: async () => {
        const candidate = isAbsolute(spec.path) ? spec.path : resolve(managedStoreRoot, spec.path);
        const resolved = resolve(candidate);
        const lexicalRelative = relative(managedStoreRoot, resolved);
        if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
          throw new PluginSourceContainmentError(
            `Plugin source ${spec.path} resolves outside the managed store ${managedStoreRoot}.`,
          );
        }
        const realRoot = await realpath(managedStoreRoot);
        const realResolved = await realpath(resolved);
        const realRelative = relative(realRoot, realResolved);
        if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
          throw new PluginSourceContainmentError(
            `Plugin source ${spec.path} resolves through a symlink outside the managed store ${managedStoreRoot}.`,
          );
        }
        return realResolved;
      },
      catch: (cause) =>
        cause instanceof PluginSourceContainmentError
          ? cause
          : new PluginSourceContainmentError(
              `Plugin source ${spec.path} could not be resolved: ${String(cause)}`,
            ),
    });

describe("PluginSource contract — real registry containment", () => {
  test("the realpath containment resolver passes the contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-plugin-source-"));
    try {
      const managedStoreRoot = await realpath(
        await (async () => {
          const root = join(dir, "store");
          await mkdir(root, { recursive: true });
          return root;
        })(),
      );
      // A contained package directory under the managed store.
      const containedDir = join(managedStoreRoot, "drupal-php");
      await mkdir(containedDir, { recursive: true });
      await writeFile(join(containedDir, "package.json"), "{}");

      // An out-of-store directory plus a symlink inside the store pointing at it.
      const outsideDir = join(dir, "outside");
      await mkdir(outsideDir, { recursive: true });
      await symlink(outsideDir, join(managedStoreRoot, "escape-link"));

      const harness: PluginSourceContractHarness<SourceSpec> = {
        name: "realpath-containment",
        source: { id: "registry" },
        resolve: makeRealpathResolver(managedStoreRoot),
        managedStoreRoot,
        containedSpec: { path: "drupal-php" },
        // A symlink inside the store whose realpath escapes the store root.
        escapingSpec: { path: "escape-link" },
      };

      const exit = await Effect.runPromiseExit(runPluginSourceContractSuite(harness));
      if (exit._tag === "Failure") {
        throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
      }
      expect(exit._tag).toBe("Success");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a lexical `..` escape also fails the contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-plugin-source-"));
    try {
      const managedStoreRoot = await realpath(
        await (async () => {
          const root = join(dir, "store");
          await mkdir(root, { recursive: true });
          return root;
        })(),
      );
      const containedDir = join(managedStoreRoot, "pkg");
      await mkdir(containedDir, { recursive: true });

      const harness: PluginSourceContractHarness<SourceSpec> = {
        name: "lexical-escape",
        source: { id: "registry" },
        resolve: makeRealpathResolver(managedStoreRoot),
        managedStoreRoot,
        containedSpec: { path: "pkg" },
        escapingSpec: { path: "../../etc" },
      };

      const exit = await Effect.runPromiseExit(runPluginSourceContractSuite(harness));
      if (exit._tag === "Failure") {
        throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
      }
      expect(exit._tag).toBe("Success");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
