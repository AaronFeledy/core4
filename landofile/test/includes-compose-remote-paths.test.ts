import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { LandofileIncludeDeps } from "../src/include-context.ts";
import { resolveAuthoredIncludes } from "./include-pipeline.ts";
import {
  makeNpmPackageTarball,
  makeTestLandofilePorts,
  makeTestLandofileStateStore,
  makeTestNpmRegistry,
} from "./support.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-compose-remote-paths-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

test.each(["git", "npm"] as const)(
  "leaves %s Compose paths unchanged, including relative child fragments",
  async (kind) => {
    // Given
    const populate = async (dest: string) => {
      await mkdir(join(dest, "nested"), { recursive: true });
      await Bun.write(
        join(dest, "compose.yaml"),
        "include: [nested/compose.yaml]\nservices:\n  parent:\n    image: alpine\n    env_file: [.env.parent]\n    build:\n      dockerfile: Dockerfile\n",
      );
      await Bun.write(
        join(dest, "nested/compose.yaml"),
        "services:\n  child:\n    image: alpine\n    volumes: ['./data:/data']\nconfigs:\n  config:\n    file: ./config\nsecrets:\n  secret:\n    file: ./secret\n",
      );
    };
    const cacheRoot = join(root, "cache");
    const tarball = makeNpmPackageTarball({
      "compose.yaml":
        "include: [nested/compose.yaml]\nservices:\n  parent:\n    image: alpine\n    env_file: [.env.parent]\n    build:\n      dockerfile: Dockerfile\n",
      "nested/compose.yaml":
        "services:\n  child:\n    image: alpine\n    volumes: ['./data:/data']\nconfigs:\n  config:\n    file: ./config\nsecrets:\n  secret:\n    file: ./secret\n",
    });
    const deps: LandofileIncludeDeps =
      kind === "git"
        ? {
            git: {
              fetch: async ({ dest }) => {
                await populate(dest);
                return { commit: "a".repeat(40) };
              },
            },
          }
        : { npmRegistry: makeTestNpmRegistry({ name: "@acme/shared", version: "1.2.3", tarball }) };
    // When
    const document = await Effect.runPromise(
      resolveAuthoredIncludes({
        appRoot: root,
        cacheRoot,
        ports: makeTestLandofilePorts(cacheRoot, cacheRoot, deps),
        stateStore: makeTestLandofileStateStore(cacheRoot),
        deps,
        landofile: {
          includes: [
            {
              source: kind === "git" ? "github:acme/shared" : "npm:@acme/shared",
              path: "compose.yaml",
              kind: "compose",
            },
          ],
        },
      }),
    );
    // Then
    expect(document.services?.[ServiceName.make("parent")]).toMatchObject({
      type: "compose",
      envFile: [".env.parent"],
      build: { context: ".", dockerfile: "Dockerfile" },
    });
    expect(document.services?.[ServiceName.make("child")]?.volumes).toMatchObject([{ source: "./data" }]);
    expect(document.configs).toMatchObject({ config: { file: "./config" } });
    expect(document.secrets).toMatchObject({ secret: { file: "./secret" } });
  },
);
