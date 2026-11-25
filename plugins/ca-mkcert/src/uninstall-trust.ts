/**
 * The uninstall step for the mkcert local CA. Every Lando data root on a host shares one mkcert
 * `CAROOT`, and so does mkcert itself, so Lando cannot prove the CA is its own and never removes it.
 * The step names the exact trust entries mkcert v1.4.4 and Lando's setup created for this CA in the stores
 * Lando knows about, and the OS commands that remove them; none of them needs Lando's mkcert binary, which
 * purge deletes. Planning only reads
 * files: the uninstall contract offers no subprocesses.
 */
import { X509Certificate } from "node:crypto";
import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { isErrnoCode } from "@lando/sdk/errors";
import type { HostMaintenanceContribution } from "@lando/sdk/plugins";
import type { HostPlatform, HostUninstallStep } from "@lando/sdk/schema";
import { Effect } from "effect";

import { type HostEnv, locateBundles } from "./homebrew-trust.ts";
import { discoverNssDatabases } from "./nss-databases.ts";
import { javaKeystoreCommand } from "./uninstall-java.ts";

export const LOCAL_CA_MAINTAINER_ID = "local-ca";
export const LOCAL_CA_TRUST_STEP_ID = "trust";

const ROOT_FILE = "rootCA.pem";
const WSL_INTEROP = "/proc/sys/fs/binfmt_misc/WSLInterop";

/** Where mkcert's Linux `-install` writes its anchor, and the command that rebuilds that store, in mkcert's order. */
export const LINUX_ANCHOR_STORES: ReadonlyArray<{
  readonly dir: string;
  readonly ext: string;
  readonly refresh: string;
}> = [
  { dir: "/etc/pki/ca-trust/source/anchors", ext: ".pem", refresh: "update-ca-trust extract" },
  { dir: "/usr/local/share/ca-certificates", ext: ".crt", refresh: "update-ca-certificates" },
  { dir: "/etc/ca-certificates/trust-source/anchors", ext: ".crt", refresh: "trust extract-compat" },
  { dir: "/usr/share/pki/trust/anchors", ext: ".pem", refresh: "update-ca-certificates" },
];

export interface LocalCaHostAccess {
  readonly env: HostEnv;
  readonly exists: (path: string) => boolean;
  /** File text, or `undefined` when the file does not exist. Other read errors throw. */
  readonly readText: (path: string) => string | undefined;
  /** Subdirectory names, or none when the directory cannot be listed. */
  readonly listDirs: (path: string) => ReadonlyArray<string>;
}

const set = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/** The directory mkcert v1.4.4 uses as `CAROOT` (`getCAROOT`), or `undefined` when it has none. */
export const mkcertCaRoot = (platform: HostPlatform, env: HostEnv): string | undefined => {
  const explicit = set(env.CAROOT);
  if (explicit !== undefined) return explicit;
  if (platform === "win32") {
    const local = set(env.LOCALAPPDATA ?? env.LocalAppData);
    return local === undefined ? undefined : win32.join(local, "mkcert");
  }
  const xdg = set(env.XDG_DATA_HOME);
  if (xdg !== undefined) return posix.join(xdg, "mkcert");
  const home = set(env.HOME);
  if (home === undefined) return undefined;
  return platform === "darwin"
    ? posix.join(home, "Library", "Application Support", "mkcert")
    : posix.join(home, ".local", "share", "mkcert");
};

export interface LocalCaIdentity {
  readonly serial: string;
  readonly nickname: string;
  readonly sha1: string;
  readonly sha256: string;
}

/** mkcert names trust entries after the decimal serial (`caUniqueName`). */
export const localCaIdentity = (pem: string): LocalCaIdentity => {
  const certificate = new X509Certificate(pem);
  const serial = BigInt(`0x${certificate.serialNumber}`).toString(10);
  return {
    serial,
    nickname: `mkcert development CA ${serial}`,
    sha1: certificate.fingerprint.replaceAll(":", ""),
    sha256: certificate.fingerprint256,
  };
};

const quote = (value: string): string =>
  /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

const run = (command: string): string => `Run \`${command}\`.`;

/** The host the plan describes. */
interface Host {
  readonly platform: HostPlatform;
  readonly access: LocalCaHostAccess;
}

const nssDatabases = ({ platform, access }: Host): ReadonlyArray<string> => {
  const home = set(access.env.HOME);
  if (home === undefined) return [];
  const profiles = (dir: string) => access.listDirs(dir).map((name) => posix.join(dir, name));
  const candidates =
    platform === "darwin"
      ? profiles(posix.join(home, "Library", "Application Support", "Firefox", "Profiles"))
      : [
          posix.join(home, ".pki", "nssdb"),
          posix.join(home, "snap", "chromium", "current", ".pki", "nssdb"),
          "/etc/pki/nssdb",
          ...profiles(posix.join(home, ".mozilla", "firefox")),
          ...profiles(posix.join(home, "snap", "firefox", "common", ".mozilla", "firefox")),
        ];
  return candidates.filter((dir) => access.exists(posix.join(dir, "cert9.db")));
};

const systemStoreCommands = (
  { platform, access }: Host,
  caroot: string,
  ca: LocalCaIdentity,
): ReadonlyArray<string> => {
  switch (platform) {
    case "darwin":
      return [
        run(`sudo security remove-trusted-cert -d ${quote(posix.join(caroot, ROOT_FILE))}`),
        run(`sudo security delete-certificate -Z ${ca.sha1} /Library/Keychains/System.keychain`),
      ];
    case "win32":
      return [
        run(`certutil -user -delstore Root ${ca.sha1}`),
        `If the CA was added for all users, also run \`certutil -delstore Root ${ca.sha1}\` from an elevated prompt.`,
      ];
    case "linux":
    case "wsl": {
      const fileName = ca.nickname.replaceAll(" ", "_");
      const anchors = LINUX_ANCHOR_STORES.map((store) => ({
        ...store,
        file: posix.join(store.dir, `${fileName}${store.ext}`),
      })).filter(({ file }) => access.exists(file));
      const linux =
        anchors.length === 0
          ? ["No mkcert anchor file for this CA is in the system trust store."]
          : anchors.map(({ file, refresh }) => run(`sudo rm -f ${file} && sudo ${refresh}`));
      const windows =
        platform === "wsl" || access.exists(WSL_INTEROP)
          ? [
              `On the Windows side, run \`certutil.exe -user -delstore Root ${ca.sha1}\`; if the CA was added for all users, also run \`certutil.exe -delstore Root ${ca.sha1}\` from an elevated prompt.`,
            ]
          : [];
      return [...linux, ...windows];
    }
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
};

const manualDetail = Effect.fnUntraced(function* (host: Host, caroot: string, pem: string) {
  const finish = `Then delete ${caroot}, which holds the CA's private key, unless another tool uses it.`;
  let ca: LocalCaIdentity;
  try {
    ca = localCaIdentity(pem);
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return `${posix.join(caroot, ROOT_FILE)} is not a readable certificate, so Lando cannot name its trust entries. Remove it from your trust stores with your OS tools. ${finish}`;
  }
  // mkcert's own databases, plus the ones Lando's setup writes (such as Chromium's XDG database).
  const written = yield* Effect.promise(() =>
    discoverNssDatabases(host.access.env, host.platform === "wsl" ? "linux" : host.platform),
  );
  const nss = [...new Set([...nssDatabases(host), ...written.map(({ dir }) => dir)])].map((dir) =>
    run(`${dir.startsWith("/etc/") ? "sudo " : ""}certutil -D -d ${quote(`sql:${dir}`)} -n '${ca.nickname}'`),
  );
  const brew = (yield* Effect.promise(() => locateBundles(host.access.env, host.platform))).map(
    ({ prefix }) => run(`${quote(posix.join(prefix, "bin", "brew"))} postinstall ca-certificates`),
  );
  const java = javaKeystoreCommand(host.platform, host.access, ca.nickname);
  return [
    `Lando leaves this local CA (SHA-256 ${ca.sha256}) trusted because every Lando installation on this machine and mkcert itself share it.`,
    "After uninstalling every Lando installation, remove it from the trust stores Lando knows about with your OS tools:",
    ...systemStoreCommands(host, caroot, ca),
    ...nss,
    ...(java === undefined ? [] : [run(java)]),
    ...(brew.length === 0 ? [] : ["Once the system store no longer trusts it:", ...brew]),
    finish,
  ].join(" ");
});

const step = (fields: Pick<HostUninstallStep, "target" | "status" | "detail">): HostUninstallStep => ({
  id: LOCAL_CA_TRUST_STEP_ID,
  label: "local CA trust",
  destructive: false,
  ...fields,
});

const planTrustStep = Effect.fnUntraced(function* (host: Host) {
  const { platform, access } = host;
  const caroot = mkcertCaRoot(platform, access.env);
  if (caroot === undefined) {
    return step({ target: "mkcert CAROOT", status: "skipped", detail: "mkcert has no CA directory here." });
  }
  const rootPath = join(caroot, ROOT_FILE);
  let pem: string | undefined;
  try {
    pem = access.readText(rootPath);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return step({
      target: caroot,
      status: "manual",
      detail: `Lando could not read ${rootPath} (${reason}). Remove the local CA from your trust stores with your OS tools, then delete ${caroot} unless another tool uses it.`,
    });
  }
  if (pem === undefined) {
    return step({ target: caroot, status: "skipped", detail: `No local CA in ${caroot}.` });
  }
  const detail = yield* manualDetail(host, caroot, pem);
  return step({ target: caroot, status: "manual", detail });
});

const listDirs = (path: string): ReadonlyArray<string> => {
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (cause) {
    if (cause instanceof Error) return [];
    throw cause;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
};

export const makeLocalCaHostMaintainer = (
  access: Partial<LocalCaHostAccess> = {},
): HostMaintenanceContribution => {
  const host: LocalCaHostAccess = {
    env: access.env ?? process.env,
    exists: access.exists ?? existsSync,
    readText: access.readText ?? readText,
    listDirs: access.listDirs ?? listDirs,
  };
  return {
    id: LOCAL_CA_MAINTAINER_ID,
    uninstall: {
      plan: ({ platform }) => Effect.map(planTrustStep({ platform, access: host }), (planned) => [planned]),
      // Engine executes only owned steps; this step is always manual or skipped.
      execute: ({ step: planned }) =>
        Effect.succeed(
          planned.status === "skipped"
            ? { outcome: "skipped", detail: planned.detail }
            : { outcome: "manual", detail: planned.detail },
        ),
    },
  };
};
