import { describe, expect, test } from "bun:test";
import { ProcessTimeoutError } from "@lando/sdk/errors";
import { ProcessRunner } from "@lando/sdk/services";
import { Cause, Effect, Exit, Layer, Option, Result, Stream } from "effect";

import {
  HostProxyOpenerError,
  canOpenHost,
  openHostTarget,
  openUrl,
  openerArgvFor,
} from "../../src/services/host-opener";

test("keeps the process failure as the host opener cause", async () => {
  const cause = new ProcessTimeoutError({
    cmd: "xdg-open",
    message: "The host opener timed out.",
    elapsedMs: 100,
    remediation: "Restore the desktop session before opening the URL.",
  });
  const result = await Effect.runPromise(
    openHostTarget("https://example.test", { platform: "linux" }).pipe(
      Effect.provideService(ProcessRunner, {
        run: () => Effect.fail(cause),
        stream: () => Stream.die("unused"),
        streamWithExit: () => Stream.die("unused"),
      }),
      Effect.result,
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(HostProxyOpenerError);
    expect(result.failure.cause).toBe(cause);
  }
});

const fakeProcess = (record: { commands: (readonly string[])[] }) =>
  Layer.succeed(
    ProcessRunner,
    ProcessRunner.of({
      run: ({ cmd, args }) => {
        record.commands.push([cmd, ...(args ?? [])]);
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      },
      stream: () => Stream.die("not used"),
      streamWithExit: () => Stream.die("not used"),
    }),
  );

describe("openerArgvFor", () => {
  test("selects the platform opener", () => {
    expect(openerArgvFor("darwin", "https://a.lndo.site")).toEqual(["open", "https://a.lndo.site"]);
    expect(openerArgvFor("linux", "https://a.lndo.site")).toEqual(["xdg-open", "https://a.lndo.site"]);
    expect(openerArgvFor("win32", "https://a.lndo.site")).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      "https://a.lndo.site",
    ]);
  });

  test("passes win32 URLs unchanged as one argv element", () => {
    const url = 'https://a.lndo.site/path?name="quoted value"&price=$5';
    expect(openerArgvFor("win32", url)).toEqual(["rundll32.exe", "url.dll,FileProtocolHandler", url]);
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
  test("issues the platform opener argv through ProcessRunner", async () => {
    const record: { commands: (readonly string[])[] } = { commands: [] };
    await Effect.runPromise(
      openUrl("https://web.myapp.lndo.site", { platform: "linux" }).pipe(Effect.provide(fakeProcess(record))),
    );
    expect(record.commands).toEqual([["xdg-open", "https://web.myapp.lndo.site"]]);
  });

  test("rejects a non-http(s) scheme with HostProxyOpenUrlSchemeError", async () => {
    const record: { commands: (readonly string[])[] } = { commands: [] };
    const exit = await Effect.runPromiseExit(
      openUrl("ftp://example.test", { platform: "linux" }).pipe(Effect.provide(fakeProcess(record))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(error._tag).toBe("HostProxyOpenUrlSchemeError");
    }
    expect(record.commands).toEqual([]);
  });
});
