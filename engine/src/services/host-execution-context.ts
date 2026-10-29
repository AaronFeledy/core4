import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { FileIoError } from "@lando/sdk/errors";

export interface CapturedHostExecutionContext {
  readonly requestedCwd: string;
  readonly baseCwd: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string>>;
  readonly pwdKey: string;
  readonly explicitPwd: string | undefined;
}

export interface HostExecutionContext {
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export const captureHostExecutionContext = (
  input: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
  host = { cwd: process.cwd(), env: process.env, platform: process.platform },
): CapturedHostExecutionContext => {
  const parent = { ...host.env };
  const overrides = { ...input.env };
  const keyOf = (key: string) => (host.platform === "win32" ? key.toUpperCase() : key);
  const env: Record<string, string> = {};
  const spellings = new Map<string, string>();
  for (const source of [parent, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const normalized = keyOf(key);
      const spelling = spellings.get(normalized) ?? key;
      spellings.set(normalized, spelling);
      env[spelling] = value;
    }
  }
  const callerPwd = Object.keys(overrides).findLast((key) => keyOf(key) === "PWD");
  return {
    requestedCwd: input.cwd ?? host.cwd,
    baseCwd: host.cwd,
    platform: host.platform,
    env,
    pwdKey: Object.keys(env).find((key) => keyOf(key) === "PWD") ?? "PWD",
    explicitPwd: callerPwd === undefined ? undefined : overrides[callerPwd],
  };
};

const directoryIdentity = async (
  captured: CapturedHostExecutionContext,
  lookup: (path: string) => Promise<string>,
): Promise<string> => {
  if (captured.platform === "win32") {
    const drive = win32.parse(captured.baseCwd).root;
    const requested = captured.requestedCwd;
    const driveRelative = /^[a-z]:[^\\/]/i.test(requested) || /^[a-z]:$/i.test(requested);
    const qualified = driveRelative
      ? `${
          requested.slice(0, 2).toUpperCase() === captured.baseCwd.slice(0, 2).toUpperCase()
            ? captured.baseCwd
            : (captured.env[`=${requested.slice(0, 2).toUpperCase()}`] ?? `${requested.slice(0, 2)}\\`)
        }\\${requested.slice(2)}`
      : /^[\\/](?![\\/])/.test(requested)
        ? `${drive}${requested.slice(1)}`
        : win32.isAbsolute(requested)
          ? requested
          : `${captured.baseCwd}\\${requested}`;
    return lookup(`${qualified}\\`);
  }
  const anchored = captured.requestedCwd.startsWith("/")
    ? captured.requestedCwd
    : `${captured.baseCwd}/${captured.requestedCwd}`;
  let prefix = "";
  // Bun realpath lexically erases '..' before traversing symlinks. Directory-form
  // lookups validate every erased prefix, including file/.. and missing/.. .
  for (const component of anchored.split("/").slice(1)) {
    if (component === "..")
      prefix = posix.dirname(await lookup(`${prefix}${prefix.endsWith("/") ? "" : "/"}`));
    else prefix += `/${component}`;
  }
  return lookup(`${prefix}${prefix.endsWith("/") ? "" : "/"}`);
};

export const prepareHostExecutionContext = async (
  captured: CapturedHostExecutionContext,
  lookup: (path: string) => Promise<string> = realpath,
): Promise<HostExecutionContext> => {
  try {
    const cwd = await directoryIdentity(captured, lookup);
    return { cwd, env: { ...captured.env, [captured.pwdKey]: captured.explicitPwd ?? cwd } };
  } catch (cause) {
    throw new FileIoError({
      message: `Could not prepare host working directory ${captured.requestedCwd}: ${cause instanceof Error ? cause.message : String(cause)}`,
      path: captured.requestedCwd,
      cause,
      remediation:
        "Ensure the requested working directory and every traversed component exist, are directories, and are accessible, then re-run the command.",
    });
  }
};
