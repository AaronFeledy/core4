import {
  SOCKET_PROXY_POLKIT_PATH as POLKIT_RULE_PATH,
  SOCKET_PROXY_UNIT_PATHS as SOCKET_UNIT_PATHS,
  socketProxyPolkitHeader,
  socketProxyUnitHeader,
} from "./socket-proxy-helper.ts";
import {
  type SocketProxyPriorDigests,
  shQuote,
  socketProxyArtifactRecheck,
  socketProxyLockPreamble,
} from "./socket-proxy-script.ts";

export { POLKIT_RULE_PATH, SOCKET_UNIT_PATHS };

const SYSTEMD_UNIT_DIR = "/etc/systemd/system" as const;

export const PROXYD_CANDIDATES = [
  "/usr/lib/systemd/systemd-socket-proxyd",
  "/lib/systemd/systemd-socket-proxyd",
] as const;

const SOCKET_UNIT_NAMES = [
  "lando-proxy-http.socket",
  "lando-proxy-http.service",
  "lando-proxy-https.socket",
  "lando-proxy-https.service",
] as const;

export type SocketProxyServiceType = "notify" | "simple";

const UNIT_REGEX_SOURCE = "/^lando-proxy-[a-z0-9_-]+\\.(socket|service)$/";
const VERB_REGEX_SOURCE = "/^(start|stop|restart|try-restart|reload|reload-or-restart)$/";

export const renderPolkitRule = (
  user: string,
  userDataRoot: string,
): string => `${socketProxyPolkitHeader(userDataRoot)}
polkit.addRule(function (action, subject) {
  if (action.id !== "org.freedesktop.systemd1.manage-units") {
    return polkit.Result.NOT_HANDLED;
  }
  if (subject.user !== ${JSON.stringify(user)}) {
    return polkit.Result.NOT_HANDLED;
  }
  var unit = action.lookup("unit");
  var verb = action.lookup("verb");
  if (unit === null || verb === null) {
    return polkit.Result.NOT_HANDLED;
  }
  if (!${UNIT_REGEX_SOURCE}.test(unit)) {
    return polkit.Result.NOT_HANDLED;
  }
  if (!${VERB_REGEX_SOURCE}.test(verb)) {
    return polkit.Result.NOT_HANDLED;
  }
  return polkit.Result.YES;
});
`;

const renderSocketUnit = (input: {
  readonly description: string;
  readonly listen: string;
  readonly user: string;
  readonly userDataRoot: string;
}): string => `${socketProxyUnitHeader(input.userDataRoot)}
[Unit]
Description=${input.description}

[Socket]
ListenStream=${input.listen}
Accept=no
FreeBind=yes
SocketUser=${input.user}
`;

const renderServiceUnit = (input: {
  readonly description: string;
  readonly socket: string;
  readonly binary: string;
  readonly target: string;
  readonly user: string;
  readonly serviceType: SocketProxyServiceType;
  readonly userDataRoot: string;
}): string => `${socketProxyUnitHeader(input.userDataRoot)}
[Unit]
Description=${input.description}
Requires=${input.socket}
After=${input.socket}

[Service]
Type=${input.serviceType}
ExecStart=${input.binary} ${input.target}
User=${input.user}
PrivateTmp=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
Restart=on-failure
`;

const renderSocketProxyUnits = (input: {
  readonly user: string;
  readonly userDataRoot: string;
  readonly binary: string;
  readonly serviceType: SocketProxyServiceType;
  readonly httpTarget: number;
  readonly httpsTarget: number;
}): Readonly<Record<(typeof SOCKET_UNIT_NAMES)[number], string>> => ({
  "lando-proxy-http.socket": renderSocketUnit({
    description: "Lando proxy HTTP socket",
    listen: "127.0.0.1:80",
    user: input.user,
    userDataRoot: input.userDataRoot,
  }),
  "lando-proxy-http.service": renderServiceUnit({
    description: "Lando proxy HTTP forwarder",
    socket: "lando-proxy-http.socket",
    binary: input.binary,
    target: `127.0.0.1:${input.httpTarget}`,
    user: input.user,
    userDataRoot: input.userDataRoot,
    serviceType: input.serviceType,
  }),
  "lando-proxy-https.socket": renderSocketUnit({
    description: "Lando proxy HTTPS socket",
    listen: "127.0.0.1:443",
    user: input.user,
    userDataRoot: input.userDataRoot,
  }),
  "lando-proxy-https.service": renderServiceUnit({
    description: "Lando proxy HTTPS forwarder",
    socket: "lando-proxy-https.socket",
    binary: input.binary,
    target: `127.0.0.1:${input.httpsTarget}`,
    user: input.user,
    userDataRoot: input.userDataRoot,
    serviceType: input.serviceType,
  }),
});

const heredoc = (path: string, body: string): string =>
  `cat > ${path} <<'LANDO_PROXY_EOF'\n${body}LANDO_PROXY_EOF`;

export const buildInstallScript = (input: {
  readonly user: string;
  readonly userDataRoot: string;
  readonly binary: string;
  readonly serviceType: SocketProxyServiceType;
  readonly httpTarget: number;
  readonly httpsTarget: number;
  /** Digests of unit/polkit content observed before elevate; pins the classified prior state. */
  readonly priorDigests?: SocketProxyPriorDigests;
  /** When true, existing foreign stamps matching prior digests may be replaced. */
  readonly replaceForeign?: boolean;
  readonly priorOwnerRoot?: string;
}): string => {
  const units = renderSocketProxyUnits(input);
  const writes = SOCKET_UNIT_NAMES.map((name) => heredoc(`${SYSTEMD_UNIT_DIR}/${name}`, units[name]));
  const priorRoot = input.priorOwnerRoot ?? input.userDataRoot;
  const unitHeader = socketProxyUnitHeader(priorRoot);
  const polkitHeader = socketProxyPolkitHeader(priorRoot);
  const prior = input.priorDigests ?? {};
  const checks = [...SOCKET_UNIT_PATHS, POLKIT_RULE_PATH].map((path) => {
    const header = path === POLKIT_RULE_PATH ? polkitHeader : unitHeader;
    return socketProxyArtifactRecheck({
      path,
      header,
      priorDigest: prior[path],
      allowUnknownDigest: path === POLKIT_RULE_PATH,
      allowUnattributed: input.replaceForeign === true && input.priorOwnerRoot === undefined,
    });
  });
  return [
    ...socketProxyLockPreamble,
    ...(input.replaceForeign === true && input.priorOwnerRoot !== undefined
      ? [`[ ! -e ${shQuote(input.priorOwnerRoot)} ] && [ ! -L ${shQuote(input.priorOwnerRoot)} ] || exit 3`]
      : []),
    ...checks,
    ...(input.replaceForeign === true
      ? [
          "systemctl stop lando-proxy-http.socket lando-proxy-https.socket lando-proxy-http.service lando-proxy-https.service",
        ]
      : []),
    `mkdir -p ${SYSTEMD_UNIT_DIR} /etc/polkit-1/rules.d`,
    ...writes,
    heredoc(POLKIT_RULE_PATH, renderPolkitRule(input.user, input.userDataRoot)),
    `if getent group polkitd >/dev/null 2>&1; then chown root:polkitd ${POLKIT_RULE_PATH}; else chown root:root ${POLKIT_RULE_PATH}; fi`,
    `chmod 0644 ${POLKIT_RULE_PATH}`,
    `chown root:root ${SOCKET_UNIT_PATHS.join(" ")}`,
    `chmod 0644 ${SOCKET_UNIT_PATHS.join(" ")}`,
    "systemctl daemon-reload",
    "systemctl try-restart lando-proxy-http.service lando-proxy-https.service",
    "systemctl start lando-proxy-http.socket lando-proxy-https.socket",
  ].join("\n");
};

export const buildUninstallScript = (input: {
  readonly unitPaths: ReadonlyArray<string>;
  readonly polkitPath: string;
  readonly canonicalUserDataRoot: string;
  readonly priorDigests?: SocketProxyPriorDigests;
}): string => {
  const unitHeader = socketProxyUnitHeader(input.canonicalUserDataRoot);
  const polkitHeader = socketProxyPolkitHeader(input.canonicalUserDataRoot);
  const candidates = [...input.unitPaths, input.polkitPath];
  const prior = input.priorDigests ?? {};
  const checks = candidates.map((path) => {
    const header = path === input.polkitPath ? polkitHeader : unitHeader;
    return socketProxyArtifactRecheck({
      path,
      header,
      priorDigest: prior[path],
      allowUnknownDigest: path === input.polkitPath,
      allowUnattributed: false,
    });
  });
  return [
    ...socketProxyLockPreamble,
    ...checks,
    ...SOCKET_UNIT_NAMES.flatMap((name, index) => {
      const path = input.unitPaths[index];
      return path === undefined
        ? []
        : [`if [ -e ${shQuote(path)} ]; then systemctl stop ${shQuote(name)}; fi`];
    }),
    ...candidates.map((path) => `rm -f -- ${shQuote(path)}`),
    "systemctl daemon-reload",
  ].join("\n");
};
