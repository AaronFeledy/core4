import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { logsFollowFromInput, logsOptionsFromInput } from "../../src/cli/command-specs/app/logs.ts";
import { initOptionsFromInput } from "../../src/cli/command-specs/apps/init.ts";
import { appsListPathFromInput } from "../../src/cli/command-specs/apps/list.ts";
import { keepVolumesFromInput } from "../../src/cli/command-specs/apps/scratch/destroy.ts";
import { pruneFromInput } from "../../src/cli/command-specs/apps/scratch/gc.ts";
import { globalConfigFormatFromInput } from "../../src/cli/command-specs/meta/global/config.ts";
import { globalDestroyOptionsFromInput } from "../../src/cli/command-specs/meta/global/destroy.ts";
import { globalInstallOptionsFromInput } from "../../src/cli/command-specs/meta/global/install.ts";
import { globalStartOptionsFromInput } from "../../src/cli/command-specs/meta/global/start.ts";
import {
  globalStatusFormatFromInput,
  globalStatusOptionsFromInput,
} from "../../src/cli/command-specs/meta/global/status.ts";
import { globalUninstallOptionsFromInput } from "../../src/cli/command-specs/meta/global/uninstall.ts";
import { shellenvShellFromInput } from "../../src/cli/command-specs/meta/shellenv.ts";
import { uninstallOptionsFromInput } from "../../src/cli/command-specs/meta/uninstall.ts";
import {
  scratchIdFromInput,
  scratchListFormatFromInput,
  scratchStartOptionsFromInput,
} from "../../src/cli/commands/scratch.ts";
import { MalformedCliFlagValueError } from "../../src/cli/flag-value-validation.ts";
import type { ResultFormat } from "../../src/cli/format-flags.ts";
import { compiledCommandInputFromArgv, normalizeCompiledCommandArgv } from "../../src/cli/run.ts";

const compiledInput = (
  commandId: string,
  argv: ReadonlyArray<string>,
  rendererMode: "lando" | "json" = "lando",
  resultFormat?: ResultFormat,
) =>
  compiledCommandInputFromArgv(commandId, argv, {
    rendererMode,
    ...(resultFormat === undefined ? {} : { resultFormat }),
  });

describe("native argv parser seam", () => {
  test("strict:false inputs strip the option terminator and preserve the command remainder", () => {
    const input = compiledInput("app:exec", ["--user", "www-data", "--", "echo", "-n", "hello"]);

    expect(input.flags.user).toBe("www-data");
    expect(input.parsedArgv).toEqual(["echo", "-n", "hello"]);
  });

  test("strict:false inputs preserve an unknown leading option as passthrough argv", () => {
    const input = compiledInput("meta:bun", ["-e", "console.log('ok')"]);

    expect(input.parsedArgv).toEqual(["-e", "console.log('ok')"]);
  });

  test("strict:false inputs parse declared flags after positional argv", () => {
    const input = compiledInput("app:config", ["set", "services.appserver.type", "lando", "--dry-run"]);

    expect(input.flags["dry-run"]).toBe(true);
    expect(input.parsedArgv).toEqual(["set", "services.appserver.type", "lando"]);
  });

  test("native command inputs carry the resolved universal result format", () => {
    expect(scratchListFormatFromInput(compiledInput("apps:scratch:list", [], "json", "json"))).toBe("json");
    expect(scratchListFormatFromInput(compiledInput("apps:scratch:list", [], "json", "text"))).toBe("table");
    expect(globalConfigFormatFromInput(compiledInput("meta:global:config", [], "lando", "json"))).toBe(
      "json",
    );
  });

  test("apps:list resolves --path through the shared input extractor", () => {
    expect(appsListPathFromInput(compiledInput("apps:list", ["--path", "demo"]))).toBe("demo");
    expect(appsListPathFromInput(compiledInput("apps:list", ["--path=demo"]))).toBe("demo");
    expect(appsListPathFromInput(compiledInput("apps:list", []))).toBeUndefined();
  });

  test("apps:init resolves every scaffold flag through the shared input parser", () => {
    const input = compiledInput("apps:init", [
      "--name",
      "demo",
      "--recipe=node-postgres",
      "--answer",
      "database=main",
      "--option",
      "database=option-wins",
      "--answers",
      "answers.json",
      "--full",
      "--yes",
      "--interactive",
      "--no-interactive",
    ]);

    expect(initOptionsFromInput(input)).toEqual({
      cwd: process.cwd(),
      destination: resolve(process.cwd(), "demo"),
      full: true,
      name: "demo",
      recipe: "node-postgres",
      answers: { database: "option-wins" },
      answersFile: "answers.json",
      yes: true,
      nonInteractive: false,
    });
  });

  test("apps:init accepts the --non-interactive alias for --no-interactive", () => {
    const input = compiledInput("apps:init", ["--non-interactive"]);

    expect(initOptionsFromInput(input).nonInteractive).toBe(true);
  });

  test("apps:init defaults to non-interactive when stdin is not a TTY", () => {
    const input = compiledInput("apps:init", []);

    expect(initOptionsFromInput(input).nonInteractive).toBe(true);
  });

  test("app:logs resolves service, tail, and since through the shared input parser", () => {
    const input = compiledInput("app:logs", ["--service", "appserver", "--tail", "25", "--since", "1h"]);

    expect(logsOptionsFromInput(input)).toEqual({ service: "appserver", tail: 25, since: "1h" });
    expect(logsFollowFromInput(input)).toBe(false);
    expect(logsFollowFromInput(compiledInput("app:logs", ["--follow"]))).toBe(true);
  });

  test("native input parses bundled log flags at the shared argv helper seam", () => {
    const input = compiledInput("app:logs", ["-fsappserver"]);

    expect(logsOptionsFromInput(input)).toEqual({ service: "appserver" });
    expect(logsFollowFromInput(input)).toBe(true);
  });

  test("native command inputs preserve valid separated, equals, and repeatable values", () => {
    const logs = compiledInput("app:logs", ["--service", "appserver", "--since=1h", "--tail", "25"]);
    const init = compiledInput("apps:init", ["--answer", "php=8.3", "--answer=database=mysql"]);

    expect(logsOptionsFromInput(logs)).toEqual({ service: "appserver", since: "1h", tail: 25 });
    expect(init.flags.answer).toEqual(["php=8.3", "database=mysql"]);
  });

  test("app:logs parses --source through the native input seam", () => {
    const input = compiledInput("app:logs", ["--service", "db", "--source", "slow-query", "--follow"]);

    expect(logsOptionsFromInput(input)).toEqual({ service: "db", source: "slow-query" });
    expect(logsFollowFromInput(input)).toBe(true);
  });

  test.each([
    ["invalid integer", ["--tail", "abc"]],
    ["repeated option", ["--service", "appserver", "--service=database"]],
    ["truncated short bundle", ["-fs"]],
  ])("app:logs rejects %s before producing native input", (_name, argv) => {
    expect(() => compiledInput("app:logs", argv)).toThrow(MalformedCliFlagValueError);
  });

  test("apps:scratch:start uses scratchStartOptionsFromInput for recipe and fork flags", () => {
    const input = compiledInput("apps:scratch:start", [
      "--from",
      "lamp",
      "--answer",
      "php=8.2",
      "--option",
      "php=8.4",
      "--answers",
      "answers.json",
      "--detach",
      "--name",
      "try-lamp",
      "--interactive",
      "--mount-cwd",
      "--share-global-storage",
    ]);

    expect(scratchStartOptionsFromInput(input)).toEqual({
      fork: false,
      from: "lamp",
      detach: true,
      name: "try-lamp",
      answers: { php: "8.4" },
      answersFile: "answers.json",
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
      scratchListFormatFromInput(compiledInput("apps:scratch:info", ["scratch-demo-abc123"], "json", "json")),
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
    const yesInstall = compiledInput("meta:global:install", ["--yes"]);
    expect(yesInstall.flags.yes).toBe(true);
    expect(globalInstallOptionsFromInput(yesInstall)).toEqual({});
    expect(
      globalUninstallOptionsFromInput(compiledInput("meta:global:uninstall", ["proxy", "--purge"])),
    ).toEqual({
      plugin: "proxy",
      purge: true,
    });
  });

  test("native argv normalization maps space-separated phrases to canonical ids", () => {
    expect(normalizeCompiledCommandArgv(["apps", "scratch", "run", "--", "echo", "ok"])).toEqual([
      "apps:scratch:run",
      "--",
      "echo",
      "ok",
    ]);
    expect(normalizeCompiledCommandArgv(["global", "list", "--format=json"])).toEqual([
      "global:list",
      "--format=json",
    ]);
    expect(normalizeCompiledCommandArgv(["global", "logs", "--service", "proxy"])).toEqual([
      "global:logs",
      "--service",
      "proxy",
    ]);
    expect(normalizeCompiledCommandArgv(["global", "config", "set", "services.proxy.type", "lando"])).toEqual(
      ["global:config:set", "services.proxy.type", "lando"],
    );
    expect(normalizeCompiledCommandArgv(["meta", "global", "restart"])).toEqual(["meta:global:restart"]);
    expect(normalizeCompiledCommandArgv(["global", "rebuild"])).toEqual(["global:rebuild"]);
    expect(normalizeCompiledCommandArgv(["meta", "global", "rebuild"])).toEqual(["meta:global:rebuild"]);
    expect(normalizeCompiledCommandArgv(["scratch", "start"])).toEqual(["apps:scratch:start"]);
    expect(normalizeCompiledCommandArgv(["scratch", "stop", "x"])).toEqual(["apps:scratch:stop", "x"]);
    expect(normalizeCompiledCommandArgv(["scratch", "destroy", "x"])).toEqual(["apps:scratch:destroy", "x"]);
    expect(normalizeCompiledCommandArgv(["scratch", "list"])).toEqual(["apps:scratch:list"]);
    expect(normalizeCompiledCommandArgv(["scratch", "info", "x"])).toEqual(["apps:scratch:info", "x"]);
    expect(normalizeCompiledCommandArgv(["scratch", "logs", "x"])).toEqual(["apps:scratch:logs", "x"]);
    expect(normalizeCompiledCommandArgv(["scratch", "gc"])).toEqual(["apps:scratch:gc"]);
    expect(normalizeCompiledCommandArgv(["scratch", "run", "--", "echo"])).toEqual([
      "apps:scratch:run",
      "--",
      "echo",
    ]);
    expect(normalizeCompiledCommandArgv(["recipes", "list"])).toEqual(["meta:recipes:list"]);
    expect(normalizeCompiledCommandArgv(["recipes", "describe", "toolbox"])).toEqual([
      "meta:recipes:describe",
      "toolbox",
    ]);
    expect(normalizeCompiledCommandArgv(["recipes", "validate", "./"])).toEqual([
      "meta:recipes:validate",
      "./",
    ]);
    expect(normalizeCompiledCommandArgv(["share", "list"])).toEqual(["app:share:list"]);
    expect(normalizeCompiledCommandArgv(["share", "stop", "sess"])).toEqual(["app:share:stop", "sess"]);
    expect(normalizeCompiledCommandArgv(["scratch"])).toEqual(["scratch"]);
    expect(normalizeCompiledCommandArgv(["scratch", "--detach"])).toEqual(["scratch", "--detach"]);
    expect(normalizeCompiledCommandArgv(["recipes"])).toEqual(["recipes"]);
    expect(normalizeCompiledCommandArgv(["share"])).toEqual(["share"]);
    expect(normalizeCompiledCommandArgv(["apps", "scratch", "list"])).toEqual(["apps", "scratch", "list"]);
  });

  test("setup, shellenv, and uninstall helpers consume native argv input", () => {
    expect(
      compiledInput("meta:setup", ["--yes", "--provider=podman", "--skip-file-sync"]).flags,
    ).toMatchObject({
      yes: true,
      provider: "podman",
      "skip-file-sync": true,
    });
    expect(shellenvShellFromInput(compiledInput("meta:shellenv", ["--shell=pwsh"]))).toBe("powershell");
    expect(
      uninstallOptionsFromInput(compiledInput("meta:uninstall", ["--dry-run", "--purge"])),
    ).toMatchObject({
      dryRun: true,
      yes: false,
      keepData: false,
      purge: true,
    });
  });
});
