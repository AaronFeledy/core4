import { expect, test } from "bun:test";
import { makeCleanupDiscoveredApps } from "@lando/engine/install/uninstall-discovery";
import { LANDO_SHARED_CROSS_APP_NETWORK, appIdentityKey } from "@lando/sdk/schema";

const root = "/apps/owned";
const owner = appIdentityKey("owner", root);
const network = {
  "dev.lando.app": "app",
  "dev.lando.app-root": root,
  "dev.lando.owner": owner,
  "dev.lando.provider": "docker",
};
const volume = {
  "dev.lando.app": "app",
  "dev.lando.volume-owner": root,
  "dev.lando.volume-selector": `docker:app:${owner}:data`,
  "dev.lando.scope": "app",
  "dev.lando.store": "database",
  "dev.lando.volume-instance": "generation-one",
};
const fixture = (
  overrides: {
    readonly container?: Record<string, string>;
    readonly networkName?: string;
    readonly network?: Record<string, string>;
    readonly volume?: Record<string, string>;
    readonly fail?: string;
    readonly fresh?: Record<string, string>;
    readonly legacyDiscovery?: boolean;
  } = {},
) => {
  const calls: string[][] = [];
  let volumeInspects = 0;
  const exec = async (file: string, args: readonly string[]) => {
    if (file !== "docker") throw Object.assign(new Error("not installed"), { code: "ENOENT" });
    calls.push([...args]);
    if (args.includes("--version")) return { stdout: "docker" };
    if (args.includes("inspect")) {
      if (overrides.fail === "inspect") throw new Error("inspection failed");
      if (args[0] === "container")
        return {
          stdout: JSON.stringify([
            {
              Id: "exact-container",
              Config: { Labels: overrides.container ?? { "com.lando.app": "legacy" } },
            },
          ]),
        };
      if (args[0] === "network")
        return {
          stdout: JSON.stringify([
            {
              Id: "exact-network",
              Name: overrides.networkName ?? "private",
              Labels: overrides.network ?? network,
            },
          ]),
        };
      volumeInspects++;
      return {
        stdout: JSON.stringify([
          {
            Name: "named-data",
            Labels:
              volumeInspects > 1
                ? (overrides.fresh ?? overrides.volume ?? volume)
                : (overrides.volume ?? volume),
          },
        ]),
      };
    }
    if (args.includes("rm")) {
      if (overrides.fail === "remove") throw new Error("removal failed");
      return { stdout: "" };
    }
    if (args.includes("ps"))
      return { stdout: overrides.legacyDiscovery ? "" : "candidate-container\ncandidate-container\n" };
    if (args[0] === "network" && args.includes("ls"))
      return {
        stdout:
          !overrides.legacyDiscovery || args.includes("label=dev.lando.network") ? "candidate-network\n" : "",
      };
    if (args[0] === "volume" && args.includes("ls"))
      return {
        stdout: !overrides.legacyDiscovery || args.includes("label=dev.lando.volume") ? "named-data\n" : "",
      };
    return { stdout: "" };
  };
  return { calls, run: makeCleanupDiscoveredApps("/nonexistent-uninstall-owned-fixture", exec, "linux") };
};

test("purge inspects and deduplicates exact containers, private networks and owned volumes", async () => {
  const f = fixture();
  await f.run([]);
  expect(f.calls.filter((args) => args.includes("rm"))).toEqual([
    ["rm", "-f", "--volumes", "exact-container"],
    ["network", "rm", "exact-network"],
    ["volume", "rm", "named-data"],
  ]);
  expect(f.calls.some((args) => args.includes("prune"))).toBe(false);
});

for (const overrides of [
  { volume: { ...volume, "dev.lando.volume-owner": "/other/root" } },
  { volume: { ...volume, "dev.lando.volume-selector": "docker:app:wrong:data" } },
  { volume: { "dev.lando.app": "legacy" } },
  { volume: { ...volume, "com.lando.app": "contradictory" } },
  { volume: { ...volume, "dev.lando.app-root": "/contradictory" } },
  { network: { ...network, "dev.lando.owner": "wrong" } },
  { network: { "dev.lando.app": "legacy" } },
  { fresh: { ...volume, "dev.lando.volume-instance": "generation-two" } },
  { fail: "inspect" },
  { fail: "remove" },
  { container: { "com.lando.app": "legacy", "dev.lando.app": "contradictory" } },
  { container: { "com.lando.app": "legacy", "dev.lando.app-root": "/contradiction" } },
  { container: { "dev.lando.app": "app", "dev.lando.app-root": "relative", "dev.lando.service": "web" } },
  { container: { foreign: "true" } },
  { networkName: LANDO_SHARED_CROSS_APP_NETWORK },
]) {
  test(`purge reports incomplete cleanup for ${JSON.stringify(overrides)}`, async () => {
    const f = fixture(overrides);
    await expect(f.run([])).rejects.toThrow();
    if (overrides.volume || overrides.fresh)
      expect(f.calls.some((args) => args[0] === "volume" && args.includes("rm"))).toBe(false);
    if (overrides.network)
      expect(f.calls.some((args) => args[0] === "network" && args.includes("rm"))).toBe(false);
    if (overrides.networkName)
      expect(f.calls.some((args) => args[0] === "network" && args.includes("rm"))).toBe(false);
    if (overrides.container) expect(f.calls.some((args) => args[0] === "rm")).toBe(false);
  });
}

test("installed but unqueryable runtime is not treated as absent", async () => {
  const exec = async () => {
    throw new Error("version process timed out");
  };
  await expect(
    makeCleanupDiscoveredApps("/nonexistent-uninstall-owned-fixture", exec, "linux")([]),
  ).rejects.toThrow();
});

test("explicit all-Lando purge is not narrowed to the discovery app root", async () => {
  const f = fixture({
    container: {
      "dev.lando.app": "app",
      "dev.lando.app-root": "/another/canonical/root",
      "dev.lando.service": "web",
    },
  });
  await f.run([{ appId: "app", appName: "app", appRoot: root, providerId: "docker", services: ["web"] }]);
  expect(f.calls).toContainEqual(["rm", "-f", "--volumes", "exact-container"]);
});

test("old volume and network labels discover retention candidates without authorizing deletion", async () => {
  const f = fixture({
    legacyDiscovery: true,
    network: { "dev.lando.network": "true" },
    volume: { "dev.lando.volume": "true" },
  });
  await expect(f.run([])).rejects.toMatchObject({
    _tag: "UninstallResourceCleanupError",
    retained: expect.arrayContaining([expect.stringContaining("network"), expect.stringContaining("volume")]),
  });
  expect(f.calls.some((args) => args.includes("rm") || args.includes("prune"))).toBe(false);
});
