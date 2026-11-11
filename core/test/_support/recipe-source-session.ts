/**
 * Recipe-test helpers: build a SourceStore/SourceSession over fake or real transports.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateStoreShape } from "@lando/sdk/services";
import type {
  ArchiveTransport,
  GitTransport,
  NpmPackument,
  NpmRegistryTransport,
  SourceSession,
  SourceStore,
} from "@lando/source-acquisition";
import { makeGitTransport } from "@lando/source-acquisition/git";
import {
  type TestSourceStore,
  type TestSourceStoreOptions,
  disposeTestSourceStore,
  makeTestProcessRunner,
  makeTestSourceStore,
  withTestSession,
} from "@lando/source-acquisition/testing";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect } from "effect";

export type {
  ArchiveTransport,
  GitTransport,
  NpmRegistryTransport,
  SourceSession,
  SourceStore,
  TestSourceStore,
};
export { makeTestProcessRunner };

export const makeRecipeTestStateStore = (): StateStoreShape => makeTestStateStore().service;

export const withRecipeSources = async <A>(
  options: TestSourceStoreOptions,
  body: (input: {
    readonly store: SourceStore;
    readonly root: string;
    readonly session: SourceSession;
    readonly stateStore: StateStoreShape;
  }) => Promise<A>,
): Promise<A> => {
  const fixture = await makeTestSourceStore({
    ...options,
    git: options.git ?? options.transports?.git ?? makeGitTransport(makeTestProcessRunner()),
  });
  try {
    return await Effect.runPromise(
      withTestSession(fixture.store, (session) =>
        Effect.tryPromise({
          try: () =>
            body({
              store: fixture.store,
              root: fixture.root,
              session,
              stateStore: fixture.stateStore,
            }),
          catch: (cause) => cause,
        }),
      ),
    );
  } finally {
    await disposeTestSourceStore(fixture);
  }
};

export const makeGitRecipeTransport = (
  options: {
    readonly commitSha?: string;
    readonly subpath?: string;
    readonly manifest?: string;
    readonly fail?: unknown;
    readonly calls?: Array<{ readonly url?: string; readonly dest?: string; readonly ref?: string }>;
  } = {},
): GitTransport => ({
  fetch: async ({ url, dest, ref }) => {
    options.calls?.push({ url, dest, ...(ref === undefined ? {} : { ref }) });
    if (options.fail !== undefined) throw options.fail;
    const recipeRoot = options.subpath === undefined ? dest : join(dest, options.subpath);
    await mkdir(recipeRoot, { recursive: true });
    if (options.manifest !== undefined) await writeFile(join(recipeRoot, "recipe.yml"), options.manifest);
    return { commit: options.commitSha ?? "a".repeat(40) };
  },
});

export const makeArchiveTransportForBytes = (bytes: Uint8Array, calls?: Array<string>): ArchiveTransport => ({
  fetch: async (url) => {
    calls?.push(url);
    return bytes;
  },
});

export const makeNpmRegistryTransport = (input: {
  readonly packument?: NpmPackument | ((name: string) => Promise<NpmPackument | undefined>);
  readonly tarball?: Uint8Array | ((dist: { tarball: string }) => Promise<Uint8Array>);
  readonly registry?: string;
}): NpmRegistryTransport => ({
  registryFor: async () => input.registry ?? "https://registry.npmjs.org/",
  packument: async (name) => {
    if (typeof input.packument === "function") return input.packument(name);
    return input.packument;
  },
  tarball: async ({ dist }) => {
    if (typeof input.tarball === "function") return input.tarball(dist);
    if (input.tarball === undefined) throw new Error("no tarball bytes");
    return input.tarball;
  },
});

export const tempDataRoot = async (): Promise<{
  readonly dir: string;
  readonly dispose: () => Promise<void>;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-recipe-src-"));
  return {
    dir,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
};
