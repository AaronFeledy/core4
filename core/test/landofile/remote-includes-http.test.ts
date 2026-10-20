import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLandofileLoadScope } from "@lando/landofile/compile";
import { resolveLandofileIncludes } from "@lando/landofile/includes";
import type { LandofileRuntimePorts } from "@lando/landofile/ports";
import { type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Schema } from "effect";

import { type GitRecipeCloneInput, defaultGitRecipeCloner, publish } from "../../src/recipes/git-source.ts";
import { startGitHttpServer } from "../_support/git-http-server.ts";
import { createGitRepository } from "../_support/git-repository.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

const Lock = Schema.Struct({
  includes: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      version: Schema.optionalKey(Schema.String),
      resolved: Schema.String,
      checksum: Schema.String,
    }),
  ),
});
type Include = { readonly source: string; readonly path: string; readonly version?: string };
const FIRST = "services:\n  web:\n    type: php\n";
const SECOND = "services:\n  web:\n    type: node\n";
const checksum = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const withRepository = async (
  body: (fixture: {
    readonly root: string;
    readonly url: string;
    readonly server: ReturnType<typeof startGitHttpServer>;
    readonly repository: Awaited<ReturnType<typeof createGitRepository>>;
    readonly acquisitions: readonly GitRecipeCloneInput[];
    readonly load: (includes: readonly Include[], cacheRoot?: string) => Promise<LandofileShape>;
    readonly lock: () => Promise<typeof Lock.Type>;
  }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-includes-http-"));
  const server = startGitHttpServer(root);
  try {
    const appRoot = join(root, "app");
    await mkdir(appRoot);
    const repository = await createGitRepository(root, "remote.git", [
      {
        kind: "commit",
        message: "v1",
        files: {
          "fragment.yml": FIRST,
          "other.yml": "services:\n  db:\n    type: mariadb\n",
          "parent.yml": "includes:\n  - ./extra.yml\n",
          "extra.yml": FIRST,
        },
      },
      { kind: "git", args: ["tag", "-a", "v1", "-m", "v1"] },
      { kind: "commit", message: "v2", files: { "fragment.yml": SECOND, "extra.yml": SECOND } },
      { kind: "git", args: ["tag", "v2"] },
    ]);
    const acquisitions: GitRecipeCloneInput[] = [];
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected non-git acquisition");
    };
    const ports: LandofileRuntimePorts = {
      resolveUserCacheRoot: () => join(root, "cache"),
      resolveUserIncludesDir: () => join(root, "user-includes"),
      git: {
        clone: (input) => {
          acquisitions.push(input);
          return defaultGitRecipeCloner.clone(input);
        },
      },
      npmRecipeSource: { resolve: unused },
      tarball: { fetch: unused, extract: unused },
      publication: { publish },
    };
    const stateStore = makeStateStore({
      privateFileAccess: {
        enforce: async () => undefined,
        verify: async () => undefined,
      },
    });
    const load = (includes: readonly Include[], cacheRoot = join(root, "cache")) => {
      const landofile = { includes: [...includes] };
      return Effect.runPromise(
        buildLandofileLoadScope([{ file: join(appRoot, ".lando.yml"), value: landofile }]).pipe(
          Effect.flatMap((loadScope) =>
            resolveLandofileIncludes({ loadScope, landofile, appRoot, cacheRoot, ports, stateStore }),
          ),
        ),
      );
    };
    const lock = async () =>
      Schema.decodeUnknownSync(Lock)(Bun.YAML.parse(await Bun.file(join(appRoot, ".lando.lock.yml")).text()));
    const config = join(root, "gitconfig");
    await writeFile(config, "[protocol]\n version = 2\n[http]\n proxy =\n");
    await withEnvVar("GIT_CONFIG_NOSYSTEM", "1", () =>
      withEnvVar("GIT_CONFIG_COUNT", "0", () =>
        withEnvVar("GIT_CONFIG_GLOBAL", config, () =>
          body({ root, server, repository, acquisitions, load, lock, url: server.url("remote.git") }),
        ),
      ),
    );
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
};

describe.skipIf(Bun.which("git") === null)("Landofile Git HTTP includes (requires git on PATH)", () => {
  test("a tag pin writes its version and peeled commit to the lock", async () => {
    // Given
    await withRepository(async ({ url, load, lock, repository, acquisitions }) => {
      const sha = repository.commits[0];
      if (sha === undefined) throw new Error("Missing v1 fixture commit");
      // When
      const loaded = await load([{ source: url, path: "fragment.yml", version: "v1" }]);

      // Then
      expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
      expect(acquisitions.map((input) => input.ref)).toEqual(["v1"]);
      expect(await lock()).toEqual({
        includes: [
          {
            source: `${url}/fragment.yml`,
            version: "v1",
            resolved: sha,
            checksum: checksum(FIRST),
          },
        ],
      });
    });
  });

  test("a floating include stays locked after upstream HEAD moves with zero new requests", async () => {
    // Given
    await withRepository(async ({ url, load, server, repository }) => {
      const includes = [{ source: url, path: "fragment.yml" }];
      await load(includes);
      await repository.advance([
        {
          kind: "commit",
          message: "move HEAD",
          files: { "fragment.yml": "services:\n  web:\n    type: python\n" },
        },
      ]);
      const requests = server.requests.length;

      // When
      const loaded = await load(includes);

      // Then
      expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("node");
      expect(server.requests).toHaveLength(requests);
    });
  });

  test("a warm load succeeds with the server stopped", async () => {
    // Given
    await withRepository(async ({ url, load, server, acquisitions }) => {
      const includes = [{ source: url, path: "fragment.yml", version: "v1" }];
      await load(includes);
      await server.stop();

      // When
      const loaded = await load(includes);

      // Then
      expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
      expect(acquisitions).toHaveLength(1);
    });
  });

  test("a cold cache fetches the locked commit once rather than the moved branch", async () => {
    // Given
    await withRepository(async ({ root, url, load, server, acquisitions, repository }) => {
      const includes = [{ source: url, path: "fragment.yml" }];
      await load(includes);
      await repository.advance([
        {
          kind: "commit",
          message: "move HEAD",
          files: { "fragment.yml": "services:\n  web:\n    type: python\n" },
        },
      ]);
      const count = acquisitions.length;
      const requests = server.requests.length;

      // When
      const loaded = await load(includes, join(root, "fresh-cache"));

      // Then
      expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("node");
      expect(acquisitions.slice(count).map((input) => input.ref)).toEqual([repository.commits[1]]);
      expect(
        server.requests
          .slice(requests)
          .filter((request) => request.method === "GET" && request.path.endsWith("/info/refs")),
      ).toHaveLength(1);
    });
  });

  test("changing version from v1 to v2 replaces only that include lock entry", async () => {
    // Given
    await withRepository(async ({ url, load, lock, repository }) => {
      const other = { source: url, path: "other.yml", version: "v1" };
      await load([{ source: url, path: "fragment.yml", version: "v1" }, other]);
      const before = await lock();

      // When
      const loaded = await load([{ source: url, path: "fragment.yml", version: "v2" }, other]);

      // Then
      expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("node");
      const unchanged = before.includes.find((entry) => entry.source === `${url}/other.yml`);
      const after = await lock();
      expect(after).toEqual({
        includes: expect.arrayContaining([
          unchanged,
          {
            source: `${url}/fragment.yml`,
            version: "v2",
            resolved: repository.commits[1],
            checksum: checksum(SECOND),
          },
        ]),
      });
      expect(after.includes).toHaveLength(2);
    });
  });

  test("a relative remote child loads at its parent commit and locks that commit as its version", async () => {
    // Given
    await withRepository(async ({ url, load, lock, repository }) => {
      // When
      const loaded = await load([{ source: url, path: "parent.yml", version: "v1" }]);

      // Then
      expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
      const sha = repository.commits[0];
      if (sha === undefined) throw new Error("Missing v1 fixture commit");
      expect((await lock()).includes).toContainEqual({
        source: `${url}/extra.yml`,
        version: sha,
        resolved: sha,
        checksum: checksum(FIRST),
      });
    });
  });
});
