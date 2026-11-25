/**
 * Linux browser trust: the NSS databases Chrome, Chromium and Firefox read instead of the system
 * store. Lando inspects each database with NSS's `certutil`, matching the root by fingerprint so a
 * manual import under any nickname counts, and adds the root to databases that lack it under the
 * nickname `mkcert -install` uses, so `mkcert -uninstall` still removes it. A root that is present
 * but not trusted for TLS was distrusted on purpose and is never overridden. Every run is as the
 * invoking user; nothing is elevated and no database is created.
 */
import { join } from "node:path";
import type { TrustStoreStatus } from "@lando/sdk/schema";
import type { ProcessResult, ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";

import type { HostEnv } from "./homebrew-trust.ts";
import { PEM_BLOCK, parseCertificate, pemsContainRoot } from "./host-trust.ts";
import { failureDetail } from "./mkcert-command.ts";
import { type NssDatabase, discoverNssDatabases } from "./nss-databases.ts";
import { INSTALL_TRUST_REMEDIATION, PROBE_TIMEOUT_MS } from "./system-trust.ts";

/** Each candidate costs one certutil run; a database full of cached intermediates must stay cheap. */
const MAX_CANDIDATES = 20;

const PACKAGES: ReadonlyArray<readonly [manager: string, install: string]> = [
  ["apt", "sudo apt install libnss3-tools"],
  ["dnf", "sudo dnf install nss-tools"],
  ["yum", "sudo yum install nss-tools"],
  ["zypper", "sudo zypper install mozilla-nss-tools"],
  ["pacman", "sudo pacman -S nss"],
];

const toolMissingRemediation = (path: string): string => {
  const known = PACKAGES.find(([manager]) => Bun.which(manager, { PATH: path }) !== null);
  return `${known === undefined ? "Install NSS's certutil" : `Run \`${known[1]}\``}, then run \`lando setup\`.`;
};

interface TrustEntry {
  readonly nickname: string;
  readonly tls: boolean;
}

/** `certutil -L` rows: nickname, then `SSL,S/MIME,JAR/XPI` trust; TLS trust is a `C` in the first field. */
export const parseTrustListing = (output: string): ReadonlyArray<TrustEntry> => {
  const entries = new Map<string, boolean>();
  for (const line of output.split("\n")) {
    const match = /^(\S.*?)\s+([^\s,]*),[^\s,]*,[^\s,]*\s*$/u.exec(line);
    const nickname = match?.[1];
    if (nickname === undefined) continue;
    entries.set(nickname, entries.get(nickname) === true || (match?.[2] ?? "").includes("C"));
  }
  return [...entries].map(([nickname, tls]) => ({ nickname, tls }));
};

/** TLS-trusted entries first, then mkcert's own, then the rest. */
const byLikelihood = (entries: ReadonlyArray<TrustEntry>): ReadonlyArray<TrustEntry> => [
  ...entries.filter(({ tls }) => tls),
  ...entries.filter(({ tls, nickname }) => !tls && nickname.startsWith("mkcert")),
  ...entries.filter(({ tls, nickname }) => !tls && !nickname.startsWith("mkcert")),
];

/** The nickname `mkcert -install` gives the root: its serial number in decimal. */
export const mkcertNickname = (root: string): string => {
  const serial = parseCertificate(root)?.serialNumber;
  return serial === undefined ? "mkcert development CA" : `mkcert development CA ${BigInt(`0x${serial}`)}`;
};

export interface NssInspection {
  readonly database: NssDatabase;
  readonly status: TrustStoreStatus;
}

export interface NssTrustOptions {
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly env: HostEnv;
  readonly platform: string;
}

export const makeNssTrust = ({ processRunner, env, platform }: NssTrustOptions) => {
  const row = (database: NssDatabase, state: Omit<TrustStoreStatus, "id" | "name" | "location">) => ({
    status: { id: "nss", name: database.name, location: database.dir, ...state } satisfies TrustStoreStatus,
    database,
  });
  const failed = (database: NssDatabase, detail: string) =>
    row(database, {
      state: "unknown",
      reason: "inspection-failed",
      detail,
      remediation: `Close ${database.browser} if the database is locked, then run \`lando doctor\`.`,
    });

  const certutil = (binary: string, args: ReadonlyArray<string>) =>
    processRunner.run({ cmd: binary, args, stdin: "", timeoutMs: PROBE_TIMEOUT_MS }).pipe(Effect.result);

  /** Run certutil; a spawn failure becomes a failed result so callers handle one shape. */
  const run = (binary: string, args: ReadonlyArray<string>) =>
    certutil(binary, args).pipe(
      Effect.map(
        (ran): ProcessResult =>
          Result.isSuccess(ran) ? ran.success : { exitCode: -1, stdout: "", stderr: ran.failure.message },
      ),
    );

  const inspectDatabase = Effect.fnUntraced(function* (binary: string, database: NssDatabase, root: string) {
    const sql = `sql:${database.dir}`;
    const listed = yield* run(binary, ["-L", "-d", sql]);
    if (listed.exitCode !== 0) return failed(database, `\`certutil -L\` failed: ${failureDetail(listed)}`);
    const ordered = byLikelihood(parseTrustListing(listed.stdout));
    let presentWithoutTls = false;
    for (const { nickname, tls } of ordered.slice(0, MAX_CANDIDATES)) {
      const exported = yield* run(binary, ["-L", "-d", sql, "-n", nickname, "-a"]);
      if (exported.exitCode !== 0)
        return failed(database, `\`certutil -L -n\` failed: ${failureDetail(exported)}`);
      if (!pemsContainRoot(exported.stdout.match(PEM_BLOCK) ?? [], root)) continue;
      if (tls) return row(database, { state: "trusted" });
      presentWithoutTls = true;
    }
    if (presentWithoutTls) {
      return row(database, {
        state: "untrusted",
        reason: "not-trusted-for-tls",
        detail: "The database holds the local CA but does not trust it to identify websites.",
        remediation: `In ${database.browser}'s certificate settings, trust the local CA to identify websites, then run \`lando doctor\`.`,
      });
    }
    // An unchecked entry may hold the root, so "missing" (which authorizes a write) is unproven.
    const unchecked = ordered.length - MAX_CANDIDATES;
    if (unchecked > 0) {
      return row(database, {
        state: "unknown",
        reason: "inspection-incomplete",
        detail: `The database holds ${ordered.length} certificates; Lando checked ${MAX_CANDIDATES} and did not find the local CA, leaving ${unchecked} unchecked.`,
        remediation: `Check whether ${database.browser}'s certificate settings trust the local CA, then run \`lando doctor\`.`,
      });
    }
    return row(database, {
      state: "untrusted",
      reason: "missing",
      detail: "The database does not include the local CA.",
      remediation: INSTALL_TRUST_REMEDIATION,
    });
  });

  const installInto = Effect.fnUntraced(function* (
    binary: string,
    caroot: string,
    root: string,
    database: NssDatabase,
  ) {
    const args = ["-A", "-d", `sql:${database.dir}`, "-t", "C,,", "-n", mkcertNickname(root)];
    const added = yield* run(binary, [...args, "-i", join(caroot, "rootCA.pem")]);
    if (added.exitCode !== 0) {
      return row(database, {
        state: "untrusted",
        reason: "install-failed",
        detail: failureDetail(added),
        remediation: `Close ${database.browser} if it reports the database is locked, then run \`lando setup\` again.`,
      });
    }
    const after = yield* inspectDatabase(binary, database, root);
    return after.status.state === "trusted"
      ? row(database, { state: "trusted", detail: `Restart ${database.browser} to use it.` })
      : after;
  });

  const located = Effect.promise(() => discoverNssDatabases(env, platform));
  const findCertutil = () => Bun.which("certutil", { PATH: env.PATH ?? "" });

  return {
    /** One row per browser database. Reads only. */
    inspect: Effect.fn("Nss.inspect")(function* (root: string) {
      const databases = yield* located;
      if (databases.length === 0) return [];
      const binary = findCertutil();
      if (binary === null) {
        const remediation = toolMissingRemediation(env.PATH ?? "");
        return databases.map((database) =>
          row(database, {
            state: "unknown",
            reason: "tool-missing",
            detail: "NSS's certutil is not installed, so Lando cannot check or update this browser database.",
            remediation,
          }),
        );
      }
      return yield* Effect.forEach(databases, (database) => inspectDatabase(binary, database, root));
    }),
    /** Add the root to each inspected database that lacks it; others keep their inspected row. */
    install: Effect.fn("Nss.install")(function* (
      caroot: string,
      root: string,
      inspections: ReadonlyArray<NssInspection>,
    ) {
      const binary = findCertutil();
      return yield* Effect.forEach(inspections, (inspection) =>
        binary !== null && inspection.status.state === "untrusted" && inspection.status.reason === "missing"
          ? installInto(binary, caroot, root, inspection.database)
          : Effect.succeed(inspection),
      );
    }),
  };
};

export type NssTrust = ReturnType<typeof makeNssTrust>;
