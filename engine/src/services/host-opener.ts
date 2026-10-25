import { posix } from "node:path";
import { Effect, Schema } from "effect";

import { RedactionService } from "@lando/redaction/service";
import { HostProxyOpenUrlSchemeError } from "@lando/sdk/errors";
import type { ShellExecError } from "@lando/sdk/errors";
import { ProcessRunner, ShellRunner } from "@lando/sdk/services";

export interface HostOpenerCapabilityInput {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface OpenUrlOptions {
  readonly platform?: NodeJS.Platform;
}

const OPENABLE_SCHEMES = new Set(["http:", "https:"]);

const shellQuote = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`;
const cmdQuote = (value: string): string => `"${value.replace(/"/gu, '""')}"`;

export const openerArgvFor = (platform: NodeJS.Platform, target: string): readonly [string, ...string[]] =>
  platform === "win32"
    ? ["rundll32.exe", "url.dll,FileProtocolHandler", target]
    : [platform === "darwin" ? "open" : "xdg-open", target];

export const revealArgvFor = (
  platform: NodeJS.Platform,
  target: string,
  isDirectory: boolean,
): readonly [string, ...string[]] => {
  if (platform === "win32") return ["explorer.exe", `/select,${target}`];
  if (platform === "darwin") return ["open", "-R", target];
  return ["xdg-open", isDirectory ? target : posix.dirname(target)];
};

export class HostProxyOpenerError extends Schema.TaggedError<HostProxyOpenerError>()("HostProxyOpenerError", {
  message: Schema.String,
  opener: Schema.String,
  operation: Schema.Literals(["openUrl", "revealPath"]),
  exitCode: Schema.optionalKey(Schema.Number),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

const runHostOpener = Effect.fn("HostOpener.run")(function* (
  target: string,
  argv: readonly [string, ...string[]],
  operation: HostProxyOpenerError["operation"],
) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  const [cmd, ...args] = argv;
  const runner = yield* ProcessRunner;
  const failure = (exitCode?: number) =>
    new HostProxyOpenerError({
      message: "The host opener failed.",
      opener: cmd,
      operation,
      ...(exitCode === undefined ? {} : { exitCode }),
      remediation: "Check that your host has a working default browser or file manager and desktop session.",
    });
  const launch = runner.run({ cmd, args }).pipe(Effect.mapError(() => failure()));
  const result = yield* redaction._tag === "Some"
    ? launch.pipe(
        Effect.provideService(RedactionService, {
          ...redaction.value,
          forProfile: (profile, options) =>
            redaction.value.forProfile(profile, {
              ...options,
              authoritativeTokens: [...(options?.authoritativeTokens ?? []), target, ...args],
            }),
        }),
      )
    : launch;
  // Windows Explorer can exit 1 after a successful reveal; its exit code is not a failure signal.
  if (operation === "revealPath" && cmd === "explorer.exe") return;
  if (result.exitCode !== 0) return yield* Effect.fail(failure(result.exitCode));
});

export const openHostTarget = Effect.fn("HostOpener.openHostTarget")(function* (
  url: string,
  options?: OpenUrlOptions,
) {
  yield* runHostOpener(url, openerArgvFor(options?.platform ?? process.platform, url), "openUrl");
});

export const revealHostPath = Effect.fn("HostOpener.revealHostPath")(function* (
  target: string,
  isDirectory: boolean,
  options?: OpenUrlOptions,
) {
  yield* runHostOpener(
    target,
    revealArgvFor(options?.platform ?? process.platform, target, isDirectory),
    "revealPath",
  );
});

export const openerCommandFor = (platform: NodeJS.Platform, url: string): string => {
  if (platform === "win32") return `start "" ${cmdQuote(url)}`;
  return `${platform === "darwin" ? "open" : "xdg-open"} ${shellQuote(url)}`;
};

export const canOpenHost = (input: HostOpenerCapabilityInput): boolean => {
  if (input.platform === "darwin" || input.platform === "win32") return true;
  return input.env.DISPLAY !== undefined || input.env.WAYLAND_DISPLAY !== undefined;
};

const parseScheme = (url: string): string | undefined => {
  try {
    return new URL(url).protocol;
  } catch {
    return undefined;
  }
};

export const openUrl = Effect.fn("HostOpener.openUrl")(function* (
  url: string,
  options?: OpenUrlOptions,
): Effect.fn.Return<void, HostProxyOpenUrlSchemeError | ShellExecError, ShellRunner> {
  const protocol = parseScheme(url);
  if (protocol === undefined || !OPENABLE_SCHEMES.has(protocol)) {
    return yield* Effect.fail(
      new HostProxyOpenUrlSchemeError({
        message: `Refusing to open ${url}: only http and https URLs can be opened.`,
        ...(protocol === undefined ? {} : { scheme: protocol.replace(/:$/u, "") }),
        url,
        remediation: "Open only http:// or https:// URLs.",
      }),
    );
  }
  const shell = yield* ShellRunner;
  const platform = options?.platform ?? process.platform;
  yield* shell.exec(openerCommandFor(platform, url));
});
