import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StateStoreShape } from "@lando/sdk/services";
import {
  type GitTransport,
  type NpmRegistryTransport,
  type SourceTransports,
  makeSourceStore,
} from "@lando/source-acquisition";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";
import type { LandofileIncludeDeps } from "../src/include-context.ts";
import type { LandofileRuntimePorts } from "../src/ports.ts";
import { loadLandofileFile, loadLandofileLayers } from "../src/service.ts";

export const loadTestLandofileLayers = (...args: Parameters<typeof loadLandofileLayers>) =>
  loadLandofileLayers(...args).pipe(Effect.map((compiled) => compiled.document));
export const loadTestLandofileFile = (...args: Parameters<typeof loadLandofileFile>) =>
  loadLandofileFile(...args).pipe(Effect.map((compiled) => compiled.document));

export const makeTestLandofileStateStore = (cacheRoot?: string): StateStoreShape =>
  makeStateStore({
    privateFileAccess: {
      enforce: async () => undefined,
      verify: async () => undefined,
    },
    ...(cacheRoot === undefined
      ? {}
      : {
          roots: {
            userConfRoot: cacheRoot,
            userCacheRoot: cacheRoot,
            userDataRoot: cacheRoot,
            systemPluginRoot: cacheRoot,
          },
        }),
  });

const unused = async (): Promise<never> => {
  throw new Error("Unexpected source transport call in test");
};

export const makeTestLandofilePorts = (
  cacheRoot: string,
  userIncludesDir = cacheRoot,
  sources: SourceTransports = {},
): LandofileRuntimePorts => ({
  resolveUserCacheRoot: () => cacheRoot,
  resolveUserIncludesDir: () => userIncludesDir,
  sources: {
    git: sources.git ?? { fetch: unused },
    archive: sources.archive ?? { fetch: unused },
    ...(sources.npmRegistry === undefined ? {} : { npmRegistry: sources.npmRegistry }),
  },
});

export const seedGitSourceEntry = async (
  cacheRoot: string,
  commit: string,
  files: Record<string, string>,
): Promise<void> => {
  const tree = join(cacheRoot, "sources", "git", commit, "tree");
  await mkdir(tree, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = join(tree, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(
    join(cacheRoot, "sources", "git", commit, "entry.json"),
    JSON.stringify({
      version: 1,
      format: 1,
      kind: "git",
      id: commit,
      treeDigest: "0".repeat(64),
      provenance: { source: "test" },
    }),
  );
};

export const makeNpmPackageTarball = (files: Record<string, string>): Uint8Array => {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const put = (name: string, body: Uint8Array) => {
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(name);
    header.set(nameBytes.subarray(0, Math.min(100, nameBytes.length)));
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode(`${body.length.toString(8).padStart(11, "0")}\0`), 124);
    header[156] = "0".charCodeAt(0);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    chunks.push(header, body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad > 0) chunks.push(new Uint8Array(pad));
  };
  for (const [rel, content] of Object.entries(files)) {
    put(rel.startsWith("package/") ? rel : `package/${rel}`, encoder.encode(content));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

export const gitDeps = (git: GitTransport): LandofileIncludeDeps => ({ git });

export const makeTestNpmRegistry = (input: {
  readonly name: string;
  readonly version: string;
  readonly tarball: Uint8Array;
  readonly tags?: Record<string, string>;
  readonly extraVersions?: ReadonlyArray<string>;
  readonly onPackument?: (name: string) => void;
  readonly onTarball?: (input: { readonly packageName: string }) => void;
  readonly integrity?: string;
  readonly shasum?: string;
  readonly distOverride?: { readonly integrity?: string; readonly shasum?: string };
}): NpmRegistryTransport => {
  const shasum = input.shasum ?? createHash("sha1").update(input.tarball).digest("hex");
  const dist = {
    tarball: "https://registry.example/pkg.tgz",
    shasum: input.distOverride?.shasum ?? shasum,
    ...(input.integrity === undefined && input.distOverride?.integrity === undefined
      ? {}
      : { integrity: input.distOverride?.integrity ?? input.integrity }),
  };
  const versions: Record<string, { dist: typeof dist }> = { [input.version]: { dist } };
  for (const v of input.extraVersions ?? []) versions[v] = { dist };
  return {
    registryFor: () => "https://registry.npmjs.org",
    packument: async (name) => {
      input.onPackument?.(name);
      return {
        "dist-tags": {
          latest: input.version,
          main: input.version,
          next: input.version,
          ...(input.tags ?? {}),
        },
        versions,
      };
    },
    tarball: async (req) => {
      input.onTarball?.(req);
      return input.tarball;
    },
  };
};

export const npmDeps = (input: Parameters<typeof makeTestNpmRegistry>[0]): LandofileIncludeDeps => ({
  npmRegistry: makeTestNpmRegistry(input),
});

/** Offline-friendly registry that only answers registryFor (packument/tarball throw). */
export const registryForOnly = (registry = "https://registry.npmjs.org"): NpmRegistryTransport => ({
  registryFor: () => registry,
  packument: async () => {
    throw new Error("Unexpected packument call in offline test");
  },
  tarball: async () => {
    throw new Error("Unexpected tarball call in offline test");
  },
});

/**
 * Seed an npm package into the content-addressed archive cache + StateStore index
 * via a real SourceSession.acquireNpm with fake transports.
 */
export const seedNpmSourceEntry = async (input: {
  readonly cacheRoot: string;
  readonly stateStore: StateStoreShape;
  readonly name: string;
  readonly version: string;
  readonly files: Record<string, string>;
  readonly tags?: Record<string, string>;
}): Promise<{ readonly sha256: string; readonly tarball: Uint8Array }> => {
  const tarball = makeNpmPackageTarball(input.files);
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const npmRegistry = makeTestNpmRegistry({
    name: input.name,
    version: input.version,
    tarball,
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  });
  const store = makeSourceStore({
    stateStore: input.stateStore,
    transports: { npmRegistry },
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* store.session;
        yield* session.acquireNpm({ name: input.name, selector: input.version });
      }),
    ),
  );
  return { sha256, tarball };
};

/** Filter lock publication keys to the include lockfile operation only. */
export const isIncludeLockKey = (key: string): boolean => key.startsWith("landofile-include-lock:");
