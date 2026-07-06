import { describe, expect, test } from "bun:test";

import { Effect, Exit, Layer } from "effect";

import { ShellRunner } from "@lando/sdk/services";

import { canOpenHost, openUrl, openerCommandFor } from "../../src/services/host-opener.ts";

const fakeShell = (record: { commands: string[] }) =>
  Layer.succeed(ShellRunner, {
    exec: (command: string) => {
      record.commands.push(command);
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    },
    run: () => Effect.die("not used"),
    runScript: () => Effect.die("not used"),
    interactive: () => Effect.die("not used"),
  });

describe("openerCommandFor", () => {
  test("selects the platform opener", () => {
    expect(openerCommandFor("darwin", "https://a.lndo.site")).toBe("open 'https://a.lndo.site'");
    expect(openerCommandFor("linux", "https://a.lndo.site")).toBe("xdg-open 'https://a.lndo.site'");
    expect(openerCommandFor("win32", "https://a.lndo.site")).toBe("start \"\" 'https://a.lndo.site'");
  });
});

describe("canOpenHost", () => {
  test("darwin and win32 are always capable", () => {
    expect(canOpenHost({ platform: "darwin", env: {} })).toBe(true);
    expect(canOpenHost({ platform: "win32", env: {} })).toBe(true);
  });

  test("linux is capable only with a display server", () => {
    expect(canOpenHost({ platform: "linux", env: {} })).toBe(false);
    expect(canOpenHost({ platform: "linux", env: { DISPLAY: ":0" } })).toBe(true);
    expect(canOpenHost({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } })).toBe(true);
  });
});

describe("openUrl", () => {
  test("issues the platform opener command through ShellRunner", async () => {
    const record = { commands: [] as string[] };
    await Effect.runPromise(
      openUrl("https://web.myapp.lndo.site", { platform: "linux" }).pipe(Effect.provide(fakeShell(record))),
    );
    expect(record.commands).toEqual(["xdg-open 'https://web.myapp.lndo.site'"]);
  });

  test("rejects a non-http(s) scheme with HostProxyOpenUrlSchemeError", async () => {
    const record = { commands: [] as string[] };
    const exit = await Effect.runPromiseExit(
      openUrl("ftp://example.test", { platform: "linux" }).pipe(Effect.provide(fakeShell(record))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect((error as { _tag?: string } | undefined)?._tag).toBe("HostProxyOpenUrlSchemeError");
    }
    expect(record.commands).toEqual([]);
  });
});
