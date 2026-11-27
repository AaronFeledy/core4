/**
 * The host change that trusts the local CA in the system store, as setup declares it: the exact
 * root commands for each platform, the input they read, their undo, and how a person makes the
 * same change by hand. `system-store-change.ts` plans and applies it.
 */
import { X509Certificate, createHash } from "node:crypto";
import { type HostChange, HostChangeId, type HostChangeStep, type HostChangeUndo } from "@lando/sdk/schema";
import { Result } from "effect";

import { PEM_BLOCK, sha1Hex } from "./host-trust.ts";
import {
  type LinuxAnchorStore,
  MACOS_STAGED_ROOT,
  MACOS_STAGE_DIR,
  MACOS_SYSTEM_KEYCHAIN,
  landoAnchorPath,
} from "./system-trust.ts";
import { quote } from "./uninstall-trust.ts";

export const TRUST_SYSTEM_STORE = HostChangeId.make("ca-mkcert:trust-system-store");

const OWNER = "@lando/ca-mkcert";
const SUMMARY = "Trust Lando's local CA in the system store";

/** Where the change writes trust on this host. */
export type SystemStoreTarget =
  | { readonly kind: "linux"; readonly store: LinuxAnchorStore }
  | { readonly kind: "darwin" }
  | { readonly kind: "win32"; readonly caroot: string };

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Why `pem` must not reach a trust store, or undefined when it is exactly one CA certificate.
 * Total, so planning and `--dry-run` can describe a corrupt root instead of failing on it.
 */
export const rootPemProblem = (pem: string): string | undefined => {
  const blocks = pem.match(PEM_BLOCK) ?? [];
  if (blocks.length !== 1) return `it holds ${blocks.length} certificates instead of one`;
  if (pem.replace(PEM_BLOCK, "").trim().length > 0) return "it holds more than one certificate";
  const certificate = Result.try(() => new X509Certificate(pem));
  if (Result.isFailure(certificate)) return "it is not a readable X.509 certificate";
  return certificate.success.ca ? undefined : "it is not a CA certificate";
};

const step = (
  id: string,
  summary: string,
  argv: readonly [string, ...string[]],
  extra: Partial<Pick<HostChangeStep, "stdin" | "env" | "privileged">> = {},
): HostChangeStep => ({ id, summary, argv, privileged: true, when: "always", ...extra });

/**
 * What root reads: the existing root, bound by its digest, or, when setup has yet to create one,
 * the root `ensureRoot` returns at apply, which the change checks before any step reads it.
 */
const rootInput = (digest: string | undefined): NonNullable<HostChangeStep["stdin"]> => ({
  summary: "The local CA certificate (never its private key)",
  ...(digest === undefined
    ? {
        boundAt: "apply" as const,
        verifiedBy:
          "the root setup creates first, piped only if it is exactly one PEM certificate that parses as X.509 and is a CA (CA:TRUE)",
      }
    : { sha256: digest }),
});

/** The keychain removal for the root with `sha1`; without one, what setup records later. */
export const macosUndo = (sha1: string | undefined): HostChangeUndo =>
  sha1 === undefined
    ? {
        _tag: "manual",
        detail: "Setup records the exact removal commands once the local CA is a readable CA certificate.",
      }
    : {
        _tag: "steps",
        consent: "separate",
        summary: "Remove Lando's local CA from the macOS System keychain",
        steps: [
          step("untrust", "Remove the CA's trust setting", [
            "/usr/bin/security",
            "remove-trusted-cert",
            "-d",
            MACOS_STAGED_ROOT,
          ]),
          step("delete", "Delete the CA from the System keychain", [
            "/usr/bin/security",
            "delete-certificate",
            "-Z",
            sha1,
            MACOS_SYSTEM_KEYCHAIN,
          ]),
          step("unstage", "Remove the staged copy", ["/bin/rm", "-f", MACOS_STAGED_ROOT]),
        ],
      };

export const windowsUndo = (sha1: string | undefined): HostChangeUndo => ({
  _tag: "manual",
  detail: `Run \`certutil -user -delstore Root ${sha1 ?? "<SHA-1 of the local CA>"}\`.`,
});

/** The change for `target`; `root` is the planned root when one exists. */
export const systemStoreChange = (
  target: SystemStoreTarget,
  input: { readonly binary: string },
  root: string | undefined,
  caroot?: string,
): HostChange => {
  const digest = root === undefined ? undefined : sha256(root);
  // A corrupt root is planned like any other; applying it refuses with its remedy, and the plan
  // says so up front instead of failing to parse it.
  const problem = root === undefined ? undefined : rootPemProblem(root);
  const sha1 = root === undefined || problem !== undefined ? undefined : sha1Hex(root);
  const rootPath = caroot === undefined ? "rootCA.pem" : `${caroot}/rootCA.pem`;
  const note =
    problem === undefined
      ? ""
      : ` ${rootPath} cannot be trusted as it is, because ${problem}; applying this change stops and says how to replace it.`;
  const base = {
    id: TRUST_SYSTEM_STORE,
    owner: OWNER,
    stage: "ca",
    summary: SUMMARY,
    consent: "standard",
    persistent: false,
    requirement: "recommended",
  } as const;
  const digestDetail = {
    ...(digest === undefined ? {} : { sha256: digest }),
    ...(problem === undefined ? {} : { problem: `${rootPath}: ${problem}` }),
  };
  // A person may read their own copy of the root; only Lando's root steps must not read a user path.
  const rootFile =
    caroot === undefined ? `"$(${quote(input.binary)} -CAROOT)/rootCA.pem"` : quote(`${caroot}/rootCA.pem`);
  switch (target.kind) {
    case "linux": {
      const anchor = landoAnchorPath(target.store);
      return {
        ...base,
        reason: `Browsers and command-line tools accept the HTTPS URLs Lando serves only when the system store trusts its local CA. Lando writes the CA certificate, never its key, to ${anchor} and rebuilds the ${target.store.family} store.${note}`,
        details: { anchor, ...digestDetail },
        // `tee` reads its own descriptor 0 into the fixed root-owned anchor path; opening
        // `/dev/stdin` by path fails on the socket Lando hands a child. Root's umask decides
        // tee's mode, so the anchor's mode is set explicitly.
        steps: [
          step("write-anchor", `Write the CA certificate to ${anchor}`, ["/usr/bin/tee", anchor], {
            stdin: rootInput(digest),
          }),
          step("chmod-anchor", `Make ${anchor} readable`, ["/usr/bin/chmod", "0644", anchor]),
          step("refresh", "Rebuild the system trust store", target.store.refresh),
        ],
        manual: `sudo install -m 0644 ${rootFile} ${quote(anchor)} && sudo ${target.store.refresh.map(quote).join(" ")}`,
        undo: {
          _tag: "steps",
          consent: "separate",
          summary: "Remove Lando's local CA from the system store",
          steps: [
            step("remove-anchor", `Remove ${anchor}`, ["/usr/bin/rm", "-f", "--", anchor]),
            step("refresh", "Rebuild the system trust store", target.store.refresh),
          ],
        },
      };
    }
    case "darwin":
      return {
        ...base,
        reason: `Browsers and command-line tools accept the HTTPS URLs Lando serves only when the System keychain trusts its local CA. Lando stages the CA certificate, never its key, at ${MACOS_STAGED_ROOT} and trusts it there. macOS also asks you to approve the trust setting in its own dialog, which needs a desktop session.${note}`,
        details: { staged: MACOS_STAGED_ROOT, ...digestDetail },
        manual: `sudo security add-trusted-cert -d -r trustRoot -k ${MACOS_SYSTEM_KEYCHAIN} ${rootFile}`,
        steps: [
          step("stage-dir", `Create ${MACOS_STAGE_DIR}`, ["/bin/mkdir", "-p", MACOS_STAGE_DIR]),
          step(
            "stage",
            `Write the CA certificate to ${MACOS_STAGED_ROOT}`,
            ["/usr/bin/tee", MACOS_STAGED_ROOT],
            {
              stdin: rootInput(digest),
            },
          ),
          step("trust", "Trust the CA in the System keychain", [
            "/usr/bin/security",
            "add-trusted-cert",
            "-d",
            "-r",
            "trustRoot",
            "-k",
            MACOS_SYSTEM_KEYCHAIN,
            MACOS_STAGED_ROOT,
          ]),
        ],
        undo:
          root === undefined
            ? {
                _tag: "manual",
                detail: "Setup records the exact removal commands once it creates the local CA.",
              }
            : macosUndo(sha1),
      };
    case "win32":
      return {
        ...base,
        reason: `Browsers and command-line tools accept the HTTPS URLs Lando serves only when Windows trusts its local CA. mkcert adds it to your user's Root store; Windows shows a Security Warning that you approve, and \`--yes\` cannot answer it.${note}`,
        details: { caroot: target.caroot, ...digestDetail },
        steps: [
          step("install", "Add the CA to your Windows Root store", [input.binary, "-install"], {
            privileged: false,
            env: { CAROOT: target.caroot, TRUST_STORES: "system" },
          }),
        ],
        undo: windowsUndo(sha1),
      };
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
};
