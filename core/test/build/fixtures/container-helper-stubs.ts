import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTAINER_HELPER_ARCHES, CONTAINER_HELPER_FILE } from "@lando/container-runtime/container-helper";

/**
 * A `LANDO_CONTAINER_HELPER_DIR` with a stub helper per arch, for tests that
 * compile `lando` but never run the embedded helper in a container.
 */
export const stubContainerHelperDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-helper-stub-"));
  for (const arch of CONTAINER_HELPER_ARCHES) {
    await mkdir(join(root, `linux-${arch}`), { recursive: true });
    await writeFile(join(root, `linux-${arch}`, CONTAINER_HELPER_FILE), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }
  return root;
};
