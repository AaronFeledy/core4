import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { withEnvVar } from "../_support/temp-cwd.ts";
import { resolveRoutePodmanTarget } from "../live/route-cli-live-support.ts";

test.each([
  { mode: "lando", managedOnly: false, endpoint: "managed", admitted: "lando" },
  { mode: "lando", managedOnly: false, endpoint: "bridge", admitted: undefined },
  { mode: "podman", managedOnly: false, endpoint: "bridge", admitted: "podman" },
  { mode: "podman", managedOnly: true, endpoint: "bridge", admitted: undefined },
  { mode: "podman", managedOnly: true, endpoint: "managed", admitted: "lando" },
  { mode: "podman", managedOnly: false, endpoint: "empty", admitted: undefined },
  { mode: "podman", managedOnly: false, endpoint: "missing", admitted: undefined },
] as const)(
  "$mode (managed-only: $managedOnly) with a $endpoint socket",
  async ({ mode, managedOnly, endpoint, admitted }) => {
    const root = await mkdtemp(join(tmpdir(), "route-sock-"));
    try {
      await withEnvVar("LANDO_USER_DATA_ROOT", root, async () => {
        const socketPath =
          endpoint === "managed" ? makeLandoPaths().providerSocketPath : join(root, "bridge.sock");
        await mkdir(dirname(socketPath), { recursive: true });
        const listener =
          endpoint === "managed" || endpoint === "bridge"
            ? Bun.listen({ unix: socketPath, socket: { data() {} } })
            : undefined;
        try {
          await withEnvVar("LANDO_PROVIDER", mode, async () =>
            withEnvVar("LANDO_TEST_PODMAN_SOCKET", endpoint === "empty" ? "" : socketPath, async () => {
              expect(resolveRoutePodmanTarget(managedOnly)).toEqual(
                admitted === undefined ? undefined : { provider: admitted, socketPath },
              );
            }),
          );
        } finally {
          listener?.stop(true);
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
