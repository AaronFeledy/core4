import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { makePluginTrustStore } from "../../src/plugins/trust-store.ts";

test("concurrent trust changes from separate store handles all persist", async () => {
  // Given two plugin commands that each hold their own handle to one trust file
  const root = await mkdtemp(join(tmpdir(), "lando-trust-concurrent-"));
  const path = join(root, "plugin-trust.yml");
  const first = makePluginTrustStore(path);
  const second = makePluginTrustStore(path);
  try {
    // When they trust different plugins and an authoring root at the same time
    await Effect.runPromise(
      Effect.all(
        [
          first.trustPlugin("@acme/one"),
          second.trustPlugin("@acme/two"),
          first.trustPlugin("@acme/three"),
          second.trustAuthoringRoot(join(root, "authoring")),
        ],
        { concurrency: "unbounded" },
      ),
    );
    // Then no change overwrote another
    const state = await Effect.runPromise(first.read);
    expect(state.trustedPlugins).toEqual(["@acme/one", "@acme/three", "@acme/two"]);
    expect(state.trustedAuthoringRoots).toEqual([join(root, "authoring")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
