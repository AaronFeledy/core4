import {
  SOCKET_PROXY_EXIT_FOREIGN,
  SOCKET_PROXY_EXIT_NEEDS_FLOCK,
  SOCKET_PROXY_EXIT_SYMLINK,
} from "./socket-proxy-helper.ts";

export type SocketProxyPriorDigests = Readonly<Record<string, string | null>>;

export const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const socketProxyLockPreamble = [
  "set -eu",
  `command -v flock >/dev/null 2>&1 || { printf '%s\\n' 'Install flock (util-linux), then run lando setup again.' >&2; exit ${SOCKET_PROXY_EXIT_NEEDS_FLOCK}; }`,
  "exec 9>/run/lock/lando-proxy-helper.lock",
  "flock -x 9",
] as const;

export const socketProxyArtifactRecheck = (input: {
  readonly path: string;
  readonly priorDigest: string | null | undefined;
  readonly header: string;
  readonly allowUnknownDigest: boolean;
  readonly allowUnattributed: boolean;
}): string => {
  const path = shQuote(input.path);
  const reject = `exit ${SOCKET_PROXY_EXIT_FOREIGN}`;
  const symlink = `[ ! -L ${path} ] || exit ${SOCKET_PROXY_EXIT_SYMLINK}`;
  if (input.priorDigest === null || input.priorDigest === undefined) {
    return `${symlink}\n[ ! -e ${path} ] || ${reject}`;
  }
  const headerLines = input.header.split("\n");
  const stamps = input.allowUnattributed ? headerLines.slice(0, 1) : headerLines;
  return [
    symlink,
    `[ -f ${path} ] || ${reject}`,
    ...(input.priorDigest === "unknown"
      ? input.allowUnknownDigest
        ? []
        : [reject]
      : [
          `current_digest="$(sha256sum -- ${path})"`,
          `[ "\${current_digest%% *}" = ${shQuote(input.priorDigest)} ] || ${reject}`,
        ]),
    ...stamps.map((line) => `grep -Fxq -- ${shQuote(line)} ${path} || ${reject}`),
    `[ "$(grep -Ec '^(#|//) lando-data-root:' ${path} || true)" = ${input.allowUnattributed ? "0" : "1"} ] || ${reject}`,
  ].join("\n");
};
