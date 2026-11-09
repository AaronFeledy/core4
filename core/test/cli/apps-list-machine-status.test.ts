import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { discoverRunningAppsEvidenceFromSockets } from "../../src/cli/commands/list-discovery.ts";

for (const platform of ["darwin", "win32"] as const) {
  test.each(["stopped", "running", "starting", "unreadable"] as const)(
    `${platform} list uses read-only machine evidence for %s`,
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), "lando-list-machine-"));
      try {
        let inspections = 0;
        const evidence = await discoverRunningAppsEvidenceFromSockets(root, [], {
          platform,
          env: { HOME: root, CONTAINER_HOST: "foreign-runtime" },
          processRunner: {
            run: (spec) => {
              if (spec.args?.join(" ") !== "machine inspect lando")
                return Effect.die("list must not mutate a machine");
              if (spec.env?.CONTAINER_HOST !== undefined || spec.replaceEnv !== true)
                return Effect.die("machine inspect must use the managed environment");
              inspections += 1;
              return Effect.succeed({
                exitCode: state === "unreadable" ? 1 : 0,
                stdout: JSON.stringify([{ State: state }]),
                stderr: "",
              });
            },
          },
        });
        expect(inspections).toBe(1);
        expect(evidence.idleProviderIds).toEqual(state === "stopped" ? ["lando"] : []);
        expect(evidence.providerConfirmed).toBe(false);
        expect(evidence.confirmedProviderIds).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
