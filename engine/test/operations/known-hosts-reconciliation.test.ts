import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonContainerLabels } from "@lando/container-runtime/plan";
import { bringUpRecreateReasons } from "@lando/container-runtime/podman/bring-up-recreate";
import { Effect } from "effect";
import { withStartedSshAgent } from "../../src/operations/start-ssh-agent.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const change of ["append", "replace", "retarget", "remove"] as const) {
  test(`next-start known_hosts reconciliation handles ${change} without changing agent evidence`, async () => {
    // Given a service already bound to a real host file through the start acquisition surface.
    const home = await mkdtemp(join(tmpdir(), "lando-known-hosts-reconcile-"));
    try {
      await mkdir(join(home, ".ssh"));
      const path = join(home, ".ssh", "known_hosts");
      const original = change === "retarget" ? join(home, "original") : path;
      await writeFile(original, "host-a ssh-ed25519 fixture-a");
      if (change === "retarget") await symlink(original, path);
      const desired = {
        ...plan,
        services: { [web.name]: { ...web, extensions: { "@lando/core/ssh-agent": { mode: "host" } } } },
      };
      const harness = makeHarness({ plannedApp: desired });
      const start = () =>
        Effect.runPromise(
          withStartedSshAgent(
            desired,
            { kind: "user", id: desired.id, root: desired.root },
            {},
            { mode: "host" },
            {
              home,
              startSession: () =>
                Effect.succeed({
                  appId: desired.id,
                  sessionId: "unchanged-session",
                  kind: "ssh",
                  socketName: "agent.sock",
                  mount: { _tag: "volume", volume: "agent" },
                  close: () => Promise.resolve(),
                  closed: Promise.resolve(),
                }),
              use: Effect.succeed,
            },
          ).pipe(Effect.provide(harness.layer)),
        );
      const before = await start();
      const beforeService = before.services[web.name];
      if (beforeService === undefined) throw new TypeError("Missing fixture service");
      const labels = commonContainerLabels(before, beforeService);
      const bindSources = { "/run/lando/ssh-agent": "volume:agent" };
      // When the host path changes and the next start resolves its source again.
      switch (change) {
        case "append":
          await appendFile(path, "\nhost-b ssh-ed25519 fixture-b");
          break;
        case "replace":
          await writeFile(join(home, "new"), "host-c ssh-ed25519 fixture-c");
          await rename(join(home, "new"), path);
          break;
        case "retarget":
          await writeFile(join(home, "new"), "host-c ssh-ed25519 fixture-c");
          await symlink(join(home, "new"), join(home, "new-link"));
          await rename(join(home, "new-link"), path);
          break;
        case "remove":
          await unlink(path);
          break;
        default:
          change satisfies never;
      }
      const after = await start();
      const afterService = after.services[web.name];
      if (afterService === undefined) throw new TypeError("Missing fixture service");
      // Then only a replaced or removed source needs immutable-create reconciliation.
      expect(bringUpRecreateReasons(after, afterService, { labels, bindSources })).toEqual(
        change === "append" ? [] : ["config"],
      );
      expect(commonContainerLabels(after, afterService)["dev.lando.ssh-agent-overlay"]).toBe("true");
      expect(afterService.mounts.some((mount) => mount.target === "/etc/ssh/ssh_known_hosts")).toBe(
        change !== "remove",
      );
      const repeated = await start();
      const repeatedService = repeated.services[web.name];
      if (repeatedService === undefined) throw new TypeError("Missing fixture service");
      expect(
        bringUpRecreateReasons(repeated, repeatedService, {
          labels: commonContainerLabels(after, afterService),
          bindSources,
        }),
      ).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
