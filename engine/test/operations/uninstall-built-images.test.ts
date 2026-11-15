import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";
import { makeCleanupDiscoveredApps } from "../../src/install/uninstall-discovery.ts";
import type { RuntimeExec } from "../../src/install/uninstall-runtime.ts";
import { UninstallResultSchema, uninstall } from "../../src/operations/uninstall.ts";
import { artifactBuildStoreKey } from "../../src/services/build-artifact-name.ts";
import { makeUninstallRoots, sandboxUninstallOptions } from "./uninstall-support.ts";

const fixture = async (runtime: "docker" | "podman", scenario: string) => {
  const roots = makeUninstallRoots("lando-uninstall-images-");
  mkdirSync(roots.userCacheRoot);
  writeFileSync(join(roots.userCacheRoot, "artifact-build-results.bin"), "recovery index");
  const store = await Effect.runPromise(artifactBuildStoreKey(roots.userCacheRoot));
  // Podman tags compat-API builds under docker.io/library/.
  const own = `${runtime === "podman" ? "docker.io/library/" : ""}lando-build-${store}-${runtime}-web-key:latest`;
  // Both engines list `sha256:<hex>` IDs; Podman's inspect reports the bare hex.
  const bare = (id: string) => id.replace(/^sha256:/u, "");
  const images = new Map<string, { readonly store: string; tags: string[] }>([
    ["owned", { store, tags: [own] }],
    ["dangling", { store, tags: [] }],
    ["other-store", { store: "other", tags: ["lando-build-other-web-key:latest"] }],
  ]);
  if (scenario === "foreign") images.set("foreign", { store, tags: [`${own}-second`, "user/app:latest"] });
  const calls: string[] = [];
  const container = { present: true };
  const exec: RuntimeExec = async (file, args) => {
    if (file !== runtime || scenario === "missing")
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    calls.push(args.join(" "));
    if (args.includes("--version")) return { stdout: runtime };
    if (args[0] === "ps") return { stdout: args.includes("-a") && container.present ? "container" : "" };
    if (args[0] === "container" && args[1] === "inspect")
      return {
        stdout: JSON.stringify({
          Id: "container",
          Config: {
            Labels: {
              "dev.lando.app": "app",
              "dev.lando.app-root": roots.root,
              "dev.lando.provider": runtime,
              "dev.lando.service": "web",
            },
          },
        }),
      };
    if (args[0] === "rm") {
      container.present = false;
      return { stdout: "" };
    }
    if (args[0] === "images") {
      expect(container.present).toBe(false);
      expect(existsSync(roots.userCacheRoot)).toBe(true);
      if (scenario === "listing-failed") throw new Error("image listing failed");
      const filter = args[args.indexOf("--filter") + 1];
      return {
        stdout: [...images]
          .filter(([, image]) => filter === `label=dev.lando.build-store=${image.store}`)
          .map(([id]) => `sha256:${id}`)
          .join("\n"),
      };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const id = bare(args[2] ?? "");
      const image = images.get(id);
      if (image === undefined) throw new Error("image missing");
      return {
        stdout: JSON.stringify([
          {
            Id: runtime === "podman" ? id : `sha256:${id}`,
            RepoTags: image.tags,
            Config: { Labels: { "dev.lando.build-store": image.store } },
          },
        ]),
      };
    }
    if (args[0] === "image" && args[1] === "rm") {
      expect(args).toHaveLength(3);
      const ref = args[2];
      // The engines' own non-forced removal conflicts.
      if (scenario === "in-use")
        throw new Error(
          runtime === "docker"
            ? `Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container user-container-123 is using its referenced image 4f0c`
            : "Error: image used by user-container-123: image is in use by a container: consider listing external containers and force-removing image",
        );
      if (scenario === "failed") throw new Error("storage write failed");
      for (const [id, image] of images) {
        if (bare(ref ?? "") === id || image.tags.includes(ref ?? "")) {
          image.tags = image.tags.filter((tag) => tag !== ref);
          if (image.tags.length === 0) images.delete(id);
          return { stdout: "" };
        }
      }
      throw new Error("unexpected removal target");
    }
    return { stdout: "" };
  };
  return {
    roots,
    images,
    calls,
    container,
    run: (purge = true, dryRun = false) =>
      Effect.runPromise(
        uninstall({
          ...sandboxUninstallOptions(roots),
          yes: true,
          purge,
          dryRun,
          cleanupDiscoveredApps: makeCleanupDiscoveredApps(roots.userDataRoot, exec, "linux"),
        }).pipe(Effect.provide(PrivateFileAccessService.layer)),
      ),
    [Symbol.dispose]: () => rmSync(roots.root, { recursive: true, force: true }),
  };
};

for (const runtime of ["docker", "podman"] as const) {
  test(`#2379 purge removes ${runtime} store images after containers and before caches`, async () => {
    using f = await fixture(runtime, "clean");
    const result = await f.run();
    expect(result.failed).toBe(false);
    expect([...f.images.keys()]).toEqual(["other-store"]);
    expect(existsSync(f.roots.userCacheRoot)).toBe(false);
    expect(Schema.decodeUnknownSync(UninstallResultSchema)(result).steps[0]).toMatchObject({
      id: "running-apps",
      outcome: "completed",
      detail: expect.stringContaining(`Built images on ${runtime}. Removed: 2`),
    });
  });
}

test.each([
  ["foreign", "docker"],
  ["in-use", "docker"],
  ["in-use", "podman"],
] as const)("#2379 %s images on %s are reported without aborting purge", async (scenario, runtime) => {
  using f = await fixture(runtime, scenario);
  const own = f.images.get("owned")?.tags[0];
  const result = await f.run();
  expect(result.failed).toBe(false);
  expect(existsSync(f.roots.userCacheRoot)).toBe(false);
  expect(result.steps[0]).toMatchObject({ id: "running-apps", outcome: "completed" });
  const detail = result.steps[0]?.detail;
  if (scenario === "foreign") {
    expect(f.images.get("foreign")?.tags).toEqual(["user/app:latest"]);
    expect(detail).toContain("docker image sha256:foreign: foreign tags user/app:latest");
  } else {
    expect([...f.images.keys()]).toEqual(["owned", "dangling", "other-store"]);
    expect(detail).toContain(`${runtime} image ${own}: in use:`);
    expect(detail).toContain("user-container-123");
  }
});

test.each(["failed", "listing-failed"])(
  "#2379 %s images retain recovery state and report incomplete cleanup",
  async (scenario) => {
    using f = await fixture("docker", scenario);
    const result = await f.run();
    expect(result.failed).toBe(true);
    expect(existsSync(join(f.roots.userCacheRoot, "artifact-build-results.bin"))).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      id: "running-apps",
      outcome: "failed",
      error: expect.stringContaining(scenario === "failed" ? "storage write failed" : "image listing failed"),
    });
    expect([...f.images.keys()]).toEqual(["owned", "dangling", "other-store"]);
  },
);

test.each(["keep-data", "dry-run", "missing"])("#2379 %s skips host image cleanup", async (mode) => {
  using f = await fixture("podman", mode);
  const result = await f.run(mode !== "keep-data", mode === "dry-run");
  expect(result.failed).toBe(false);
  expect([...f.images.keys()]).toEqual(["owned", "dangling", "other-store"]);
  expect(f.calls).toEqual([]);
});
