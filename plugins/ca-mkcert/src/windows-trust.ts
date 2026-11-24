/**
 * The Windows certificate store as seen from WSL. Edge and Chrome on Windows read it, not the Linux
 * stores, so a WSL user reaching Lando from a Windows browser needs the root there too. Lando only
 * inspects it, through WSL interop and Windows' `certutil.exe`; importing it needs a Windows
 * security prompt, so the remediation hands the user a command to run in Windows.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { TrustStoreStatus } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";

import type { HostEnv } from "./homebrew-trust.ts";
import { sha1Hex } from "./host-trust.ts";
import { PROBE_TIMEOUT_MS } from "./system-trust.ts";

export interface WindowsTrustPaths {
  /** Files whose presence means WSL can run Windows programs. */
  readonly interop: ReadonlyArray<string>;
  /** Where `certutil.exe` lives when it is not on PATH. */
  readonly certutil: string;
}

export const WSL_WINDOWS_TRUST_PATHS: WindowsTrustPaths = {
  interop: ["/proc/sys/fs/binfmt_misc/WSLInterop", "/proc/sys/fs/binfmt_misc/WSLInterop-late"],
  certutil: "/mnt/c/Windows/System32/certutil.exe",
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const STORE = {
  id: "windows",
  name: "Windows certificate store (Edge, Chrome)",
  location: "CurrentUser\\Root",
};

const INTEROP_REMEDIATION =
  "Make sure WSL can run Windows programs (interop is enabled and `certutil.exe` is reachable), then run `lando doctor`.";

export interface WindowsTrustOptions {
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly env: HostEnv;
  readonly platform: string;
  readonly paths: WindowsTrustPaths;
}

export const makeWindowsTrust = ({ processRunner, env, platform, paths }: WindowsTrustOptions) => {
  const run = (cmd: string, args: ReadonlyArray<string>) =>
    processRunner.run({ cmd, args, timeoutMs: PROBE_TIMEOUT_MS }).pipe(Effect.result);

  const unavailable = (detail: string): TrustStoreStatus => ({
    ...STORE,
    state: "unknown",
    reason: "interop-unavailable",
    detail,
    remediation: INTEROP_REMEDIATION,
  });

  const locate = Effect.promise(async () => {
    if (platform !== "linux") return undefined;
    const interop = await Promise.all(paths.interop.map(exists));
    if (!interop.includes(true)) return undefined;
    return {
      certutil:
        Bun.which("certutil.exe", { PATH: env.PATH ?? "" }) ??
        ((await exists(paths.certutil)) ? paths.certutil : null),
    };
  });

  /** A non-elevated command the user can paste into Windows PowerShell. */
  const remediation = Effect.fnUntraced(function* (caroot: string) {
    const pem = join(caroot, "rootCA.pem");
    const converted = yield* run("wslpath", ["-w", pem]);
    const windowsPath =
      Result.isSuccess(converted) && converted.success.exitCode === 0 ? converted.success.stdout.trim() : "";
    const command = (path: string) => `certutil -user -addstore Root '${path.replaceAll("'", "''")}'`;
    return windowsPath.length > 0
      ? `In Windows PowerShell, run \`${command(windowsPath)}\` and approve the prompt, then run \`lando doctor\`.`
      : `Copy ${pem} to Windows, then in Windows PowerShell run \`${command("<copied rootCA.pem>")}\` and approve the prompt, then run \`lando doctor\`.`;
  });

  return {
    /** The Windows store's view of `root` when running under WSL; no row elsewhere. Reads only. */
    inspect: Effect.fn("WindowsTrust.inspect")(function* (caroot: string, root: string) {
      const located = yield* locate;
      if (located === undefined) return [];
      if (located.certutil === null) {
        return [unavailable(`Lando could not find certutil.exe on PATH or at ${paths.certutil}.`)];
      }
      const sha1 = sha1Hex(root);
      if (sha1 === undefined) return [unavailable("The local CA is not a readable certificate.")];
      for (const scope of [["-user"], []]) {
        const ran = yield* run(located.certutil, [...scope, "-store", "Root", sha1]);
        if (Result.isFailure(ran))
          return [unavailable(`Lando could not run certutil.exe: ${ran.failure.message}`)];
        if (ran.success.exitCode === 0) return [{ ...STORE, state: "trusted" } satisfies TrustStoreStatus];
      }
      return [
        {
          ...STORE,
          state: "untrusted",
          reason: "missing",
          detail: "Neither the Windows user nor machine Root store holds the local CA.",
          remediation: yield* remediation(caroot),
        } satisfies TrustStoreStatus,
      ];
    }),
  };
};
