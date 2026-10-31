import { expect, test } from "bun:test";
import type {
  GraphCommandCandidate,
  PluginContributionGraphShape,
} from "@lando/engine/plugins/contribution-graph";
import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Context, Effect, Schema } from "effect";
import { suggestCommandForSuffix } from "../../src/cli/built-in-command-registry";
import { createPluginCommandCatalog } from "../../src/cli/plugin-command-catalog";
import { withEnvVar } from "../_support/temp-cwd";

const spec = (id: string): ExecutableCommandSpec => ({
  id,
  namespace: id.split(":")[0] ?? "fixture",
  summary: `Run ${id}.`,
  bootstrap: "plugins",
  resultSchema: Schema.Void,
  run: () => Effect.void,
});
const candidate = (id: string, load = async () => spec(id)): GraphCommandCandidate => ({
  id,
  load,
  pluginName: "@example/catalog",
  source: "explicit",
});
const graph = (commands: readonly GraphCommandCandidate[]): PluginContributionGraphShape => ({
  commands,
  plugins: [],
  globalPlugins: [],
  certificateAuthorities: [],
  hostContext: Context.empty(),
});

test("catalog excludes built-in canonical and alias winners before loading", async () => {
  // Given
  let shadowLoads = 0;
  const commands = ["app:start", "config:explain"].map((id) =>
    candidate(id, async () => {
      shadowLoads += 1;
      return spec(id);
    }),
  );
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.succeed(graph([...commands, candidate("fixture:inspect")])),
  );
  // When
  const listing = await catalog.list();
  // Then
  expect(listing.rows.map((row) => row.id)).toEqual(["fixture:inspect"]);
  expect(await catalog.resolve("app:start")).toBeUndefined();
  expect(await catalog.resolve("config:explain")).toBeUndefined();
  expect(await catalog.topic("config")).toBeUndefined();
  expect(await catalog.remediation("explain")).toBeUndefined();
  expect(shadowLoads).toBe(0);
});

test("suffix suggestions deduplicate canonical destinations", () => {
  // Given / When / Then
  expect(suggestCommandForSuffix("inspect", ["fixture:inspect", "fixture:inspect"])).toBe("fixture:inspect");
  expect(suggestCommandForSuffix("start", ["app:start"])).toBe("app:start");
});

test("catalog acquires once, matches ids without loading, and loads only a selected namespace", async () => {
  let acquisitions = 0;
  const loaded: string[] = [];
  const commands = ["z:run", "fixture:second", "fixture:first"].map((id) =>
    candidate(id, async () => {
      loaded.push(id);
      return spec(id);
    }),
  );
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.sync(() => {
      acquisitions += 1;
      return graph(commands);
    }),
  );
  expect(await catalog.remediation("first")).toContain("lando fixture:first");
  expect(await catalog.topic("fixture")).toBeDefined();
  expect(loaded).toEqual([]);
  const listing = await catalog.list("fixture");
  expect(listing.rows.map((row) => row.id)).toEqual(["fixture:first", "fixture:second"]);
  expect(loaded.toSorted()).toEqual(["fixture:first", "fixture:second"]);
  await catalog.resolve("fixture:first");
  expect(loaded).toHaveLength(2);
  expect(acquisitions).toBe(1);
});

test("catalog isolates loader rejection without hiding healthy commands", async () => {
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.succeed(
      graph([
        candidate("fixture:broken", () => Promise.reject(new Error("rejected"))),
        candidate("fixture:healthy"),
      ]),
    ),
  );
  const listing = await catalog.list();
  expect(listing.metadata).toEqual({ status: "available" });
  expect(listing.rows[0]).toMatchObject({
    id: "fixture:broken",
    summary: "unavailable",
    loadError: { _tag: "PluginLoadError" },
  });
  expect(listing.rows[1]?.spec?.id).toBe("fixture:healthy");
});

test.each([
  { summary: "" },
  { run: undefined },
  { flags: { bad: { type: "string", multiple: "yes" } } },
  { args: { bad: { type: "number" } } },
])("catalog isolates malformed metadata %j", async (invalid) => {
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.succeed(
      graph([candidate("fixture:invalid", async () => Object.assign(spec("fixture:invalid"), invalid))]),
    ),
  );
  const listing = await catalog.list();
  expect(listing.rows[0]?.loadError?._tag).toBe("PluginDescriptorMismatchError");
});

test("graph failure becomes bounded redacted discovery metadata", async () => {
  const secret = "catalog-secret-value-123456789";
  await withEnvVar("LANDO_TEST_API_TOKEN", secret, async () => {
    const catalog = createPluginCommandCatalog(undefined, () =>
      Effect.fail(
        new LandoRuntimeBootstrapError({
          stage: "plugins",
          message: `Discovery ${secret} ${"x".repeat(3000)}`,
          remediation: `Repair ${secret}`,
        }),
      ),
    );
    const listing = await catalog.list();
    expect(listing.rows).toEqual([]);
    expect(listing.metadata.status).toBe("unavailable");
    expect(JSON.stringify(listing.metadata)).not.toContain(secret);
    if (listing.metadata.status === "unavailable")
      expect(listing.metadata.message.length).toBeLessThanOrEqual(2048);
  });
});

test("row diagnostics use the redaction service before projection", async () => {
  const secret = "row-secret-value-123456789";
  await withEnvVar("LANDO_TEST_API_TOKEN", secret, async () => {
    const catalog = createPluginCommandCatalog(undefined, () =>
      Effect.succeed(
        graph([
          { ...candidate("fixture:bad"), pluginName: secret, load: () => Promise.reject(new Error(secret)) },
        ]),
      ),
    );
    const listing = await catalog.list();
    expect(listing.rows[0]?.loadError?._tag).toBe("PluginLoadError");
    expect(JSON.stringify(listing.rows[0]?.loadError)).not.toContain(secret);
  });
});

test("cancellation interrupts loader work rather than marking metadata unavailable", async () => {
  const controller = new AbortController();
  const catalog = createPluginCommandCatalog(controller.signal, () =>
    Effect.succeed(
      graph([
        candidate("fixture:pending", () => {
          controller.abort();
          return new Promise<ExecutableCommandSpec>(() => undefined);
        }),
      ]),
    ),
  );
  await expect(catalog.list()).rejects.toBeDefined();
});

test("suffix ambiguity includes built-ins and plugins without loading modules", async () => {
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.succeed(
      graph([candidate("fixture:export"), candidate("other:export"), candidate("fixture:start")]),
    ),
  );
  expect(await catalog.remediation("export")).toBeUndefined();
  expect(await catalog.remediation("start")).toBeUndefined();
  expect(await catalog.remediation("fixture:exprt")).toContain("lando help fixture");
});

test("plugin contributions cannot turn a core namespace into a plugin topic", async () => {
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.succeed(graph([candidate("meta:example")])),
  );
  expect(await catalog.topic("meta")).toBeUndefined();
  expect(await catalog.remediation("meta")).toBeUndefined();
});

test("unavailable discovery is explained by colon resolution and unknown-command remediation", async () => {
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.fail(
      new LandoRuntimeBootstrapError({
        stage: "plugins",
        message: "Discovery broke.",
        remediation: "Fix it.",
      }),
    ),
  );
  expect(await catalog.resolve("fixture:first")).toEqual({
    unavailable: { _tag: "LandoRuntimeBootstrapError", message: "Discovery broke.", remediation: "Fix it." },
  });
  expect(await catalog.remediation("snapshot")).toBeUndefined();
  expect(await catalog.unknownCommandRemediation("snapshot")).toBe(
    "Plugin commands could not be listed: Discovery broke. Fix it.",
  );
  expect(await catalog.unknownCommandRemediation("app")).toBe("Run `lando help app` to list commands.");
});
