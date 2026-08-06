import { cp, rename, rm, stat } from "node:fs/promises";

import type { LandofileRuntimePorts } from "../src/ports.ts";

const exists = async (path: string): Promise<boolean> =>
  stat(path)
    .then(() => true)
    .catch(() => false);

const hasErrorCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === code;

const publish = async (stagingDir: string, publishedDir: string): Promise<void> => {
  try {
    await rename(stagingDir, publishedDir);
  } catch (cause) {
    if (await exists(publishedDir)) {
      await rm(stagingDir, { recursive: true, force: true });
      return;
    }
    if (hasErrorCode(cause, "EXDEV")) {
      try {
        await cp(stagingDir, publishedDir, { recursive: true, errorOnExist: true, force: false });
      } catch (copyCause) {
        if (await exists(publishedDir)) {
          await rm(stagingDir, { recursive: true, force: true });
          return;
        }
        throw copyCause;
      }
      await rm(stagingDir, { recursive: true, force: true });
      return;
    }
    throw cause;
  }
};

export const makeTestPublicationPort = (): LandofileRuntimePorts["publication"] => ({ publish });

export const makeTestLandofilePorts = (cacheRoot: string): LandofileRuntimePorts => ({
  resolveUserCacheRoot: () => cacheRoot,
  npmRecipeSource: {
    resolve: async () => {
      throw new Error("Unexpected npm recipe source port call in test");
    },
  },
  git: {
    clone: async () => {
      throw new Error("Unexpected git include port call in test");
    },
  },
  tarball: {
    fetch: async () => {
      throw new Error("Unexpected tarball fetch in test");
    },
    extract: async () => {
      throw new Error("Unexpected tarball extract in test");
    },
  },
  publication: {
    publish,
  },
});
