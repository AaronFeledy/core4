import { Effect } from "effect";

import { HostProxyOpenUrlSchemeError } from "@lando/sdk/errors";
import type { ShellExecError } from "@lando/sdk/errors";
import { ShellRunner } from "@lando/sdk/services";

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

export const openUrl = (
  url: string,
  options?: OpenUrlOptions,
): Effect.Effect<void, HostProxyOpenUrlSchemeError | ShellExecError, ShellRunner> =>
  Effect.gen(function* () {
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
