import { expect, test } from "bun:test";
import { appIdentityKey } from "@lando/sdk/schema";
import { cleanupUninstallResources } from "../../src/install/uninstall-resource-cleanup.ts";

const root = "/tmp/uninstall-scratch-network";
const labels = {
  "dev.lando.app": "scratch-app",
  "dev.lando.app-root": root,
  "dev.lando.owner": appIdentityKey("owner", root),
  "dev.lando.provider": "lando",
  "dev.lando.scratch": "TRUE",
  "dev.lando.scratch-id": "scratch-app",
};

test.each(["complete", "partial-scratch", "wrong-id"] as const)(
  "uninstall removes scratch network only with complete ownership proof: %s",
  async (proof) => {
    const removals: string[][] = [];
    const observedLabels =
      proof === "partial-scratch"
        ? Object.fromEntries(Object.entries(labels).filter(([key]) => key !== "dev.lando.scratch-id"))
        : proof === "wrong-id"
          ? { ...labels, "dev.lando.scratch-id": "other" }
          : labels;
    const exec = async (_file: string, args: readonly string[]) => {
      if (args[0] === "network" && args[1] === "ls")
        return { stdout: args.includes("label=dev.lando.app") ? "candidate-ref\n" : "" };
      if (args[0] === "network" && args[1] === "inspect")
        return {
          stdout: JSON.stringify({
            Id: "observed-network-id",
            Name: "scratch-bridge",
            Labels: observedLabels,
          }),
        };
      if (args[0] === "network" && args[1] === "rm") {
        removals.push([...args]);
        return { stdout: "" };
      }
      return { stdout: "" };
    };
    const cleanup = cleanupUninstallResources(exec, {
      cmd: "podman",
      providerId: "lando",
      managed: true,
      argsPrefix: [],
    });
    if (proof === "complete") await cleanup;
    else await expect(cleanup).rejects.toMatchObject({ _tag: "UninstallResourceCleanupError" });
    expect(removals).toEqual(proof === "complete" ? [["network", "rm", "observed-network-id"]] : []);
  },
);
