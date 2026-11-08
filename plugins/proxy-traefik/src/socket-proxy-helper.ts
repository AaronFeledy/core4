import { absurd } from "effect";

export const SOCKET_PROXY_UNIT_PATHS = [
  "/etc/systemd/system/lando-proxy-http.socket",
  "/etc/systemd/system/lando-proxy-http.service",
  "/etc/systemd/system/lando-proxy-https.socket",
  "/etc/systemd/system/lando-proxy-https.service",
] as const;
export const SOCKET_PROXY_POLKIT_PATH = "/etc/polkit-1/rules.d/10-lando-proxy.rules";
const SOCKET_PROXY_MARKER = "lando-proxy-socket-helper";
const SOCKET_PROXY_OWNER_KEY = "lando-data-root";

/** Elevated script exit when flock is missing. Distinct from ownership mismatch (3). */
export const SOCKET_PROXY_EXIT_NEEDS_FLOCK = 4 as const;
/** Elevated script exit when an artifact path is a symlink. */
export const SOCKET_PROXY_EXIT_SYMLINK = 5 as const;
/** Elevated script exit when ownership/digest recheck fails. */
export const SOCKET_PROXY_EXIT_FOREIGN = 3 as const;

export const socketProxyUnitHeader = (canonicalUserDataRoot: string): string =>
  `# ${SOCKET_PROXY_MARKER}\n# ${SOCKET_PROXY_OWNER_KEY}: ${JSON.stringify(canonicalUserDataRoot)}`;

export const socketProxyPolkitHeader = (canonicalUserDataRoot: string): string =>
  `// ${SOCKET_PROXY_MARKER}\n// ${SOCKET_PROXY_OWNER_KEY}: ${JSON.stringify(canonicalUserDataRoot)}`;

const stampLinePattern = /^(?:#|\/\/) lando-data-root:\s*/u;

type SocketProxyStampParse =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly root: string }
  | { readonly kind: "malformed" };

/**
 * Parses owner stamps. Multiple stamps, non-JSON, non-string, or non-absolute roots are malformed.
 * Unattributed (no stamp line) is distinct and returned as none.
 */
const parseSocketProxyOwnerStamp = (content: string): SocketProxyStampParse => {
  const stamps = content.split("\n").filter((line) => stampLinePattern.test(line));
  if (stamps.length === 0) return { kind: "none" };
  if (stamps.length !== 1) return { kind: "malformed" };
  const stamp = stamps[0];
  if (stamp === undefined) return { kind: "malformed" };
  try {
    const value: unknown = JSON.parse(stamp.replace(stampLinePattern, ""));
    if (typeof value !== "string" || !value.startsWith("/")) return { kind: "malformed" };
    return { kind: "ok", root: value };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: "malformed" };
    throw error;
  }
};

/** Owner root when the stamp is well-formed and absolute; otherwise undefined. */
export const socketProxyOwnerRoot = (content: string): string | undefined => {
  const parsed = parseSocketProxyOwnerStamp(content);
  return parsed.kind === "ok" ? parsed.root : undefined;
};

export type SocketProxyArtifactClassification =
  | { readonly kind: "absent" }
  | { readonly kind: "owned" }
  | { readonly kind: "unmarked" }
  | {
      readonly kind: "foreign";
      readonly reason: "other-root" | "missing-root" | "unattributed" | "mixed";
      readonly ownerRoot?: string;
    };

/**
 * Classifies the systemd unit files, which are world-readable and are the ownership record; the polkit
 * rule is often readable only by root, so only the privileged install and removal scripts check its stamp.
 * null means absent; undefined means present but unreadable. Partial owned sets remain removable.
 * Malformed or non-absolute stamps are mixed (never unattributed).
 */
export const classifySocketProxyArtifacts = (
  contents: readonly (string | null | undefined)[],
  currentRoot: string,
  existingRoots: readonly string[],
): SocketProxyArtifactClassification => {
  const present = contents.filter((content) => content !== null);
  if (present.length === 0) return { kind: "absent" };
  if (present.some((content) => content === undefined)) return { kind: "foreign", reason: "mixed" };
  const readable = present.filter((content): content is string => content !== undefined);
  const marked = readable.filter((content) =>
    content
      .split("\n")
      .some((line) => line === `# ${SOCKET_PROXY_MARKER}` || line === `// ${SOCKET_PROXY_MARKER}`),
  );
  if (marked.length === 0) return { kind: "unmarked" };
  if (marked.length !== present.length) return { kind: "foreign", reason: "mixed" };
  const stamps = marked.map(parseSocketProxyOwnerStamp);
  if (stamps.some((stamp) => stamp.kind === "malformed")) {
    return { kind: "foreign", reason: "mixed" };
  }
  const owners = stamps.map((stamp) => (stamp.kind === "ok" ? stamp.root : undefined));
  const distinct = new Set(owners);
  if (distinct.size !== 1) return { kind: "foreign", reason: "mixed" };
  const ownerRoot = owners[0];
  if (ownerRoot === undefined) return { kind: "foreign", reason: "unattributed" };
  if (ownerRoot === currentRoot) return { kind: "owned" };
  return {
    kind: "foreign",
    reason: existingRoots.includes(ownerRoot) ? "other-root" : "missing-root",
    ownerRoot,
  };
};

export const SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS = [
  "sudo systemctl disable --now lando-proxy-http.socket lando-proxy-https.socket lando-proxy-http.service lando-proxy-https.service",
  `sudo rm -f ${[...SOCKET_PROXY_UNIT_PATHS, SOCKET_PROXY_POLKIT_PATH].join(" ")}`,
  "sudo systemctl daemon-reload",
].join("\n");

type SocketProxyNoticeStyle = "brief" | "commands";

/**
 * User-facing notice for a foreign/unmarked helper.
 * `brief` is for start/ensure (no removal recipe). `commands` is for configure/doctor.
 */
export const foreignSocketProxyNotice = (
  classification: SocketProxyArtifactClassification,
  style: SocketProxyNoticeStyle = "commands",
): string => {
  switch (classification.kind) {
    case "foreign":
      switch (classification.reason) {
        case "other-root":
          return style === "brief"
            ? `Ports 80 and 443 are served by the Lando install at ${classification.ownerRoot}.`
            : `Ports 80 and 443 are served by the socket proxy of the Lando install at ${classification.ownerRoot}, so this install uses fallback ports. If you no longer use that install, remove it with \`LANDO_USER_DATA_ROOT=${classification.ownerRoot} lando uninstall --purge\`, then run \`lando setup\` here.`;
        case "missing-root":
          return style === "brief"
            ? `Ports 80 and 443 are held by a socket proxy left by a removed Lando install (${classification.ownerRoot}); run \`lando setup\` to take it over.`
            : `Ports 80 and 443 are held by a socket proxy left by a Lando install that no longer exists (${classification.ownerRoot}). Run \`lando setup\` to replace it, or remove it yourself:\n${SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS}`;
        case "unattributed":
          return style === "brief"
            ? "Ports 80 and 443 are held by a socket proxy from an older Lando build; run `lando setup` to take it over."
            : `Ports 80 and 443 are held by a socket proxy from an older Lando build that did not record which install owns it. If no other Lando install on this host uses it, run \`lando setup\` interactively to replace it, or remove it yourself:\n${SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS}`;
        case "mixed":
          return style === "brief"
            ? "The socket proxy on ports 80 and 443 needs a manual check; run `lando doctor` for details."
            : `The socket proxy files on this host disagree about which Lando install owns them, or could not be read. Lando will not change them. Check them, then remove them yourself if no install uses them:\n${SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS}`;
      }
      return absurd(classification.reason);
    case "unmarked":
      return style === "brief"
        ? "Ports 80 and 443 are held by systemd units Lando did not create."
        : "Ports 80 and 443 are held by systemd units Lando did not create. Lando leaves them alone and uses fallback ports.";
    case "absent":
    case "owned":
      return "";
  }
};

/** SHA-256 hex of UTF-8 content; used to pin classified prior state into elevated scripts. */
export const socketProxyContentDigest = (content: string): string => {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(content);
  return hash.digest("hex");
};

export const LANDO_SOCKET_PROXY_HOLDER_LABEL = "another Lando install's socket proxy" as const;

/** True only when the holder is a Lando proxy unit (not truncated systemd-socket-proxyd comm). */
export const isLandoSocketProxyUnit = (unit: string | undefined): boolean =>
  unit?.startsWith("lando-proxy-") === true;
