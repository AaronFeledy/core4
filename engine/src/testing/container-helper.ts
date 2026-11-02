import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "@lando/sdk/digest";
import { AbsolutePath, type ContainerHelperArtifact } from "@lando/sdk/schema";
import { ContainerHelperAssets } from "@lando/sdk/services";
import { Effect, Layer } from "effect";

const STUB = "#!/bin/sh\nexit 0\n";

/** Writes a stub helper executable under `directory` for tests that never run it in a container. */
export const makeTestContainerHelper = async (directory: string): Promise<ContainerHelperArtifact> => {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "lando-container-helper");
  await Bun.write(path, STUB);
  await chmod(path, 0o755);
  return {
    target: { os: "linux", arch: "x64" },
    digest: sha256Hex(new TextEncoder().encode(STUB)),
    path: AbsolutePath.make(path),
  };
};

/** An artifact record for `path` that tests can hand to code that only copies or mounts it. */
export const stubContainerHelper = (path: string): ContainerHelperArtifact => ({
  target: { os: "linux", arch: "x64" },
  digest: "0".repeat(64),
  path: AbsolutePath.make(path),
});

/** `ContainerHelperAssets` that resolves every target to `helper`. */
export const testContainerHelperAssets = (helper: ContainerHelperArtifact) =>
  Layer.succeed(
    ContainerHelperAssets,
    ContainerHelperAssets.of({ resolve: (target) => Effect.succeed({ ...helper, target }) }),
  );
