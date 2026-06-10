import {
  scratchIdFromInput,
  scratchListFormatFromInput,
  scratchStartOptionsFromInput,
} from "../../src/cli/commands/scratch.ts";
import { logsDeferredErrorFromInput, logsOptionsFromInput } from "../../src/cli/oclif/commands/app/logs.ts";
import { initOptionsFromInput } from "../../src/cli/oclif/commands/apps/init.ts";
import { keepVolumesFromInput } from "../../src/cli/oclif/commands/apps/scratch/destroy.ts";
import { pruneFromInput } from "../../src/cli/oclif/commands/apps/scratch/gc.ts";
import { globalConfigFormatFromInput } from "../../src/cli/oclif/commands/meta/global/config.ts";
import { globalDestroyOptionsFromInput } from "../../src/cli/oclif/commands/meta/global/destroy.ts";
import { globalInstallOptionsFromInput } from "../../src/cli/oclif/commands/meta/global/install.ts";
import { globalStartOptionsFromInput } from "../../src/cli/oclif/commands/meta/global/start.ts";
import {
  globalStatusFormatFromInput,
  globalStatusOptionsFromInput,
} from "../../src/cli/oclif/commands/meta/global/status.ts";
import { globalUninstallOptionsFromInput } from "../../src/cli/oclif/commands/meta/global/uninstall.ts";
import { shellenvShellFromInput } from "../../src/cli/oclif/commands/meta/shellenv.ts";
import { uninstallOptionsFromInput } from "../../src/cli/oclif/commands/meta/uninstall.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/run.ts";

const compiledInput = (
  commandId: string,
  argv: ReadonlyArray<string>,
  rendererMode: "lando" | "json" = "lando",
) => compiledCommandInputFromArgv(commandId, argv, { rendererMode });

describe("dual-dispatch argv parser parity", () => {
  test("apps:init uses the same parsed input shape as the OCLIF helper", () => {
    const input = compiledInput("apps:init", [
      "--name",
      "demo",
      "--recipe=node-postgres",
      "--answer",
      "database=main",
      "--full",
      "--yes",
      "--no-interactive",
    ]);

    expect(initOptionsFromInput(input)).toEqual({
      cwd: process.cwd(),
      full: true,
      name: "demo",
      recipe: "node-postgres",
      answers: { database: "main" },
      yes: true,
      nonInteractive: true,
    });
  });

  test("apps:init accepts the --non-interactive alias for --no-interactive", () => {
    const input = compiledInput("apps:init", ["--non-interactive"]);

    expect(initOptionsFromInput(input).nonInteractive).toBe(true);
  });

  test("app:logs uses the same parsed input shape as the OCLIF helper", () => {
    const input = compiledInput("app:logs", ["--service", "appserver", "--tail", "25"]);

    expect(logsOptionsFromInput(input)).toEqual({ service: "appserver", tail: 25 });
    expect(logsDeferredErrorFromInput(input)).toBeUndefined();
    expect(logsDeferredErrorFromInput(compiledInput("app:logs", ["--follow"]))).toMatchObject({
      _tag: "NotImplementedError",
    });
  });

  test("app:logs drops a non-numeric --tail instead of forwarding a string", () => {
    const input = compiledInput("app:logs", ["--tail", "abc"]);

    expect((input.flags as { readonly tail?: unknown }).tail).toBeUndefined();
    expect(logsOptionsFromInput(input)).toEqual({});
  });

  test("apps:scratch:start uses scratchStartOptionsFromInput for recipe and fork flags", () => {
    const input = compiledInput("apps:scratch:start", [
      "--from",
      "lamp",
      "--answer",
      "php=8.2",
      "--option",
      "php=8.4",
      "--detach",
      "--name",
      "try-lamp",
      "--mount-cwd",
      "--share-global-storage",
    ]);

    expect(scratchStartOptionsFromInput(input)).toEqual({
      fork: false,
      from: "lamp",
      detach: true,
      name: "try-lamp",
      answers: { php: "8.4" },
      yes: false,
      nonInteractive: false,
      mountCwd: {},
      shareGlobalStorage: true,
    });
  });

  test("apps:scratch id, format, destroy, and gc helpers consume compiled argv input", () => {
    expect(scratchIdFromInput(compiledInput("apps:scratch:stop", ["scratch-demo-abc123"]))).toBe(
      "scratch-demo-abc123",
    );
    expect(scratchIdFromInput(compiledInput("apps:scratch:logs", ["scratch-demo-abc123"]))).toBe(
      "scratch-demo-abc123",
    );
    expect(scratchListFormatFromInput(compiledInput("apps:scratch:list", ["--format", "json"]))).toBe("json");
    expect(
      scratchListFormatFromInput(compiledInput("apps:scratch:info", ["scratch-demo-abc123"], "json")),
    ).toBe("json");
    expect(
      keepVolumesFromInput(compiledInput("apps:scratch:destroy", ["scratch-demo-abc123", "--keep-volumes"])),
    ).toBe(true);
    expect(pruneFromInput(compiledInput("apps:scratch:gc", ["--prune"]))).toBe(true);
  });

  test("meta:global helpers consume compiled argv input", () => {
    expect(
      globalStartOptionsFromInput(compiledInput("meta:global:start", ["--service", "traefik", "-s", "dns"])),
    ).toEqual({
      services: ["traefik", "dns"],
    });
    expect(
      globalStatusOptionsFromInput(
        compiledInput("meta:global:status", ["--service=traefik", "--format=json"]),
      ),
    ).toEqual({
      services: ["traefik"],
      format: "json",
    });
    expect(globalStatusFormatFromInput(compiledInput("meta:global:status", ["--format", "json"]))).toBe(
      "json",
    );
    expect(globalConfigFormatFromInput(compiledInput("meta:global:config", ["--format=json"]))).toBe("json");
    expect(globalDestroyOptionsFromInput(compiledInput("meta:global:destroy", ["--yes", "--purge"]))).toEqual(
      {
        yes: true,
        purge: true,
      },
    );
    expect(globalInstallOptionsFromInput(compiledInput("meta:global:install", ["proxy"]))).toEqual({
      plugin: "proxy",
    });
    expect(
      globalUninstallOptionsFromInput(compiledInput("meta:global:uninstall", ["proxy", "--purge"])),
    ).toEqual({
      plugin: "proxy",
      purge: true,
    });
  });

  test("setup, shellenv, and uninstall helpers consume compiled argv input", () => {
    expect(
      compiledInput("meta:setup", ["--yes", "--provider=podman", "--skip-file-sync"]).flags,
    ).toMatchObject({
      yes: true,
      provider: "podman",
      "skip-file-sync": true,
    });
    expect(shellenvShellFromInput(compiledInput("meta:shellenv", ["--shell=pwsh"]))).toBe("powershell");
    expect(uninstallOptionsFromInput(compiledInput("meta:uninstall", ["--dry-run", "--purge"]))).toEqual({
      dryRun: true,
      yes: false,
      keepData: false,
      purge: true,
    });
  });
});
