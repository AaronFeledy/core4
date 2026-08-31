import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";

export const UNIT_MARKER = "# lando-proxy-socket-helper" as const;
export const POLKIT_RULE_PATH = "/etc/polkit-1/rules.d/10-lando-proxy.rules" as const;
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

export const SOCKET_UNIT_PATHS = SOCKET_UNIT_NAMES.map((name) => `${SYSTEMD_UNIT_DIR}/${name}`);

export type SocketProxyServiceType = "notify" | "simple";

const UNIT_REGEX_SOURCE = "/^lando-proxy-[a-z0-9_-]+\\.(socket|service)$/";
const VERB_REGEX_SOURCE = "/^(start|stop|restart|try-restart|reload|reload-or-restart)$/";

export const renderPolkitRule = (user: string): string => `polkit.addRule(function (action, subject) {
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
}): string => `${UNIT_MARKER}
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
}): string => `${UNIT_MARKER}
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
  readonly binary: string;
  readonly serviceType: SocketProxyServiceType;
  readonly httpTarget: number;
  readonly httpsTarget: number;
}): Readonly<Record<(typeof SOCKET_UNIT_NAMES)[number], string>> => ({
  "lando-proxy-http.socket": renderSocketUnit({
    description: "Lando proxy HTTP socket",
    listen: "127.0.0.1:80",
    user: input.user,
  }),
  "lando-proxy-http.service": renderServiceUnit({
    description: "Lando proxy HTTP forwarder",
    socket: "lando-proxy-http.socket",
    binary: input.binary,
    target: `127.0.0.1:${input.httpTarget}`,
    user: input.user,
    serviceType: input.serviceType,
  }),
  "lando-proxy-https.socket": renderSocketUnit({
    description: "Lando proxy HTTPS socket",
    listen: "127.0.0.1:443",
    user: input.user,
  }),
  "lando-proxy-https.service": renderServiceUnit({
    description: "Lando proxy HTTPS forwarder",
    socket: "lando-proxy-https.socket",
    binary: input.binary,
    target: `127.0.0.1:${input.httpsTarget}`,
    user: input.user,
    serviceType: input.serviceType,
  }),
});

const heredoc = (path: string, body: string): string =>
  `cat > ${path} <<'LANDO_PROXY_EOF'\n${body}LANDO_PROXY_EOF`;

export const buildInstallScript = (input: {
  readonly user: string;
  readonly binary: string;
  readonly serviceType: SocketProxyServiceType;
  readonly httpTarget?: number;
  readonly httpsTarget?: number;
}): string => {
  const units = renderSocketProxyUnits({
    user: input.user,
    binary: input.binary,
    serviceType: input.serviceType,
    httpTarget: input.httpTarget ?? TRAEFIK_HTTP_PORT,
    httpsTarget: input.httpsTarget ?? TRAEFIK_HTTPS_PORT,
  });
  const writes = SOCKET_UNIT_NAMES.map((name) => heredoc(`${SYSTEMD_UNIT_DIR}/${name}`, units[name]));
  return [
    "set -eu",
    `mkdir -p ${SYSTEMD_UNIT_DIR} /etc/polkit-1/rules.d`,
    ...writes,
    heredoc(POLKIT_RULE_PATH, renderPolkitRule(input.user)),
    `if getent group polkitd >/dev/null 2>&1; then chown root:polkitd ${POLKIT_RULE_PATH}; else chown root:root ${POLKIT_RULE_PATH}; fi`,
    `chmod 0644 ${POLKIT_RULE_PATH}`,
    `chown root:root ${SOCKET_UNIT_PATHS.join(" ")}`,
    `chmod 0644 ${SOCKET_UNIT_PATHS.join(" ")}`,
    "systemctl daemon-reload",
    "systemctl try-restart lando-proxy-http.service lando-proxy-https.service",
  ].join("\n");
};
