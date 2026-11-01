import type { LogSource, ServiceConfig } from "@lando/sdk/schema";
import { LogSourceId } from "@lando/sdk/schema";
import type { ServiceBuildStepIntent } from "@lando/sdk/services";

import { ServiceConfigIssue } from "./_feature-helpers.ts";
import type { ListenerContract } from "./_port-helpers.ts";
import { apacheDirectivePath } from "./apache.ts";
import { apacheErrorPageDirectives } from "./http-errors.ts";

export const PHP_VIA_MODES = ["apache", "fpm", "cli"] as const;
export type PhpVia = (typeof PHP_VIA_MODES)[number];
export const SUPPORTED_PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] as const;
export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

export const APACHE_DEFAULT_SITE_BUILD_STEP_ID = "service-lando.php:apache-default-site" as const;

export const PHP_FPM_PORT = 9000;
export const PHP_APACHE_PORT = 80;
export const PHP_LISTENERS = {
  apache: {
    port: PHP_APACHE_PORT,
    daemon: "Apache",
    launcher: { setting: (port: number) => `Listen ${port}` },
    image: { setting: (port: number) => `Listen ${port}` },
  },
  fpm: {
    port: PHP_FPM_PORT,
    daemon: "php-fpm",
    launcher: { setting: (port: number) => `listen = ${port}` },
    image: { setting: (port: number) => `listen = ${port}` },
  },
} as const satisfies Readonly<Record<"apache" | "fpm", ListenerContract>>;
export const PHP_LISTENER = PHP_LISTENERS.apache;
export const PHP_CLI_KEEP_ALIVE: ReadonlyArray<string> = ["tail", "-f", "/dev/null"];

export const PHP_FPM_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("access"),
    label: "php-fpm access (shared stderr)",
    stream: "stderr",
    strategy: "console",
  },
  {
    id: LogSourceId.make("error"),
    label: "php-fpm error (shared stderr)",
    stream: "stderr",
    strategy: "console",
  },
];

export const PHP_APACHE_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("access"),
    label: "Apache access log",
    stream: "stdout",
    strategy: "console",
  },
  {
    id: LogSourceId.make("error"),
    label: "Apache error log",
    stream: "stderr",
    strategy: "console",
  },
];

export const phpLogSources = (
  mode: "apache-console" | "fpm-shared-stderr" | "console-only",
): ReadonlyArray<LogSource> => {
  switch (mode) {
    case "apache-console":
      return PHP_APACHE_LOG_SOURCES;
    case "fpm-shared-stderr":
      return PHP_FPM_LOG_SOURCES;
    case "console-only":
      return [];
  }
};

const VIA_REMEDIATION = "Set via: apache, via: fpm, or via: cli.";

const isPhpVia = (value: string): value is PhpVia => (PHP_VIA_MODES as ReadonlyArray<string>).includes(value);

export const resolvePhpVia = (value: unknown): PhpVia => {
  if (value === undefined) return "apache";
  if (typeof value === "string" && isPhpVia(value)) return value;
  throw new ServiceConfigIssue(
    ["via"],
    `Unsupported PHP serving mode ${JSON.stringify(value)}.`,
    VIA_REMEDIATION,
  );
};

// Official Hub publishes PHP 8.6 as RC bookworm tags until GA. Other minors use the GA tag.
const phpUpstreamVersion = (version: string): string => (version === "8.6" ? "8.6-rc" : version);

export const phpImageFor = (version: string, via: PhpVia): string =>
  `php:${phpUpstreamVersion(version)}-${via}-bookworm`;

export const phpListenPort = (via: Exclude<PhpVia, "cli">, authoredPort: number | undefined): number => {
  if (authoredPort !== undefined) return authoredPort;
  switch (via) {
    case "apache":
      return PHP_APACHE_PORT;
    case "fpm":
      return PHP_FPM_PORT;
    default: {
      const exhaustive: never = via;
      return exhaustive;
    }
  }
};

/** CLI has no listener. Apache must retain whether its port was explicitly authored. */
export const phpServingMode = (via: PhpVia, authoredPort: number | undefined) => {
  switch (via) {
    case "apache":
      return {
        via,
        listener: { port: phpListenPort(via, authoredPort), protocol: "http" },
        authoredApachePort: authoredPort,
      } as const;
    case "fpm":
      return { via, listener: { port: phpListenPort(via, authoredPort), protocol: "tcp" } } as const;
    case "cli":
      return { via, listener: undefined } as const;
    default: {
      const exhaustive: never = via;
      return exhaustive;
    }
  }
};

export const assertPhpViaKeys = (via: PhpVia, service: ServiceConfig): void => {
  if ((via === "fpm" || via === "cli") && service.allowOverride !== undefined) {
    throw new ServiceConfigIssue(
      ["allowOverride"],
      "allowOverride: is Apache-only.",
      `Remove allowOverride: from this ${via} service. ${VIA_REMEDIATION}`,
    );
  }
  if (via === "cli" && service.routes !== undefined) {
    throw new ServiceConfigIssue(
      ["routes"],
      "HTTP routes: are not valid for via: cli.",
      `Remove routes: or use via: apache / via: fpm. ${VIA_REMEDIATION}`,
    );
  }
};

/**
 * Debian's Apache reads `IncludeOptional sites-enabled/*.conf` and ships
 * `000-default.conf` enabled, whose `<VirtualHost *:80>` pins
 * `DocumentRoot /var/www/html`. Command-line directives are applied after the
 * configuration tree is read, but they land on the main server, and a virtual
 * host keeps its own `DocumentRoot` through the merge — so a directive alone
 * cannot move the document root while that site is enabled. Retiring the site
 * during the image build lets the launcher own the document root. Debian's
 * additive access-log config must also be retired so only the launcher's
 * inherited-stream logger remains, including for its generated virtual host.
 */
export const apacheDefaultSiteRemovalBuildStep = (): ServiceBuildStepIntent => ({
  id: APACHE_DEFAULT_SITE_BUILD_STEP_ID,
  phase: "build",
  user: "root",
  // `rm -f` rather than `a2dissite`, which fails when the site is already gone.
  command: [
    "sh",
    "-c",
    "a2enmod rewrite env && rm -f /etc/apache2/sites-enabled/000-default.conf /etc/apache2/conf-enabled/other-vhosts-access-log.conf",
  ],
});

/**
 * Shell prelude that, on a Windows host, re-maps `www-data` to the uid:gid
 * owning the project mount so the PHP worker can write bind-mounted files.
 * `preserveExplicitApacheIdentity` leaves an authored
 * `APACHE_RUN_USER`/`APACHE_RUN_GROUP` alone.
 */
export const windowsBindWorkerIdentity = (preserveExplicitApacheIdentity = false): ReadonlyArray<string> => [
  `if test "\${LANDO_HOST_OS:-}" = win32 && test -n "\${LANDO_PROJECT_MOUNT:-}"${preserveExplicitApacheIdentity ? ' && test "${APACHE_RUN_USER:-www-data}" = www-data && test "${APACHE_RUN_GROUP:-www-data}" = www-data' : ""}; then`,
  `  lando_mount_owner=$(stat -c '%u:%g' -- "$LANDO_PROJECT_MOUNT")`,
  "  lando_mount_uid=${lando_mount_owner%%:*}",
  "  lando_mount_gid=${lando_mount_owner#*:}",
  '  case "$lando_mount_owner" in *[!0-9:]*|:*|*:|*:*:*) echo "Windows project mount must have numeric uid:gid ownership; got $lando_mount_owner." >&2; exit 1;; esac',
  '  if test "$lando_mount_uid" -ne 0 && test "$lando_mount_gid" -ne 0; then',
  '    lando_uid_owner=$(getent passwd "$lando_mount_uid" | cut -d: -f1 || true)',
  '    lando_gid_owner=$(getent group "$lando_mount_gid" | cut -d: -f1 || true)',
  '    test -z "$lando_uid_owner" || test "$lando_uid_owner" = www-data || { echo "Windows project mount uid $lando_mount_uid is already owned by $lando_uid_owner." >&2; exit 1; }',
  '    test -z "$lando_gid_owner" || test "$lando_gid_owner" = www-data || { echo "Windows project mount gid $lando_mount_gid is already owned by $lando_gid_owner." >&2; exit 1; }',
  '    if test "$(id -g www-data)" != "$lando_mount_gid"; then groupmod --gid "$lando_mount_gid" www-data; fi',
  '    if test "$(id -u www-data)" != "$lando_mount_uid" || test "$(id -g www-data)" != "$lando_mount_gid"; then usermod --uid "$lando_mount_uid" --gid "$lando_mount_gid" www-data; fi',
  "  fi",
  "fi",
];

/**
 * The launcher for an Apache-served PHP service whose author declared no
 * `command` or `entrypoint`.
 *
 * Every directive is handed to `apache2-foreground` as a repeated `-c`
 * argument instead of being written to a site file at startup. That script ends
 * in `exec apache2 -DFOREGROUND "$@"`, so the arguments reach httpd, which
 * reads them as consecutive lines of one synthetic configuration stream — a
 * `<Directory>` section spans the arguments exactly as it spanned the file's
 * lines. Emitting them directly is what removes the write: the command mutates
 * no filesystem path. For the default image user, a shell prelude maps the
 * www-data worker to the Windows project mount owner before it execs Apache.
 * Every user saves stderr on fd 3 before exec: Apache redirects its main piped
 * logger's stderr to stdout, so that logger must use the saved descriptor.
 *
 * An authored `port:` moves the site into a virtual host bound to that port and
 * declares the matching listener, still in the same directive stream. The
 * default shape stays on the main server, so a service that authored no port
 * keeps the main-server listener.
 */
export const apacheStartCommand = (
  webroot: string,
  allowOverride: boolean,
  listenPort: number | undefined,
  mapWindowsWorker = true,
): ReadonlyArray<string> => {
  const path = apacheDirectivePath(webroot);
  const site = [
    `DocumentRoot "${path}"`,
    `<Directory "${path}">`,
    "Options -Indexes +FollowSymLinks",
    `AllowOverride ${allowOverride ? "All" : "None"}`,
    "Require all granted",
    "</Directory>",
    ...apacheErrorPageDirectives(),
  ];
  const directives = [
    "ServerName localhost",
    `ErrorLog "|/bin/sh -c 'exec /bin/cat >&3'"`,
    'CustomLog "|/bin/cat" vhost_combined',
    ...(listenPort === undefined
      ? site
      : [`Listen ${String(listenPort)}`, `<VirtualHost *:${String(listenPort)}>`, ...site, "</VirtualHost>"]),
  ];
  const flags = directives.flatMap((directive) => ["-c", directive]);
  return [
    "sh",
    "-c",
    [
      "set -eu",
      "exec 3>&2",
      ...(mapWindowsWorker ? windowsBindWorkerIdentity(true) : []),
      'exec apache2-foreground "$@"',
    ].join("\n"),
    "lando-apache",
    ...flags,
  ];
};

/** Where an FPM launcher writes its pool override; `/tmp` is mode `1777`. */
export const PHP_FPM_CONFIG_PATH = "/tmp/lando-php-fpm.conf" as const;

/**
 * The launcher for an FPM-served PHP service whose author declared no
 * `command` or `entrypoint`.
 *
 * php-fpm takes a configuration file, not directives, so the override is
 * written where the planned user can write and php-fpm is pointed at it with
 * `-y` instead of dropping a file into the image's root-owned pool directory.
 * The image's own `php-fpm.conf` is a `[global]` section plus an absolute
 * include of that directory, so pulling it in first keeps every bundled
 * setting; re-opening `[www]` merges into the pool the bundled files already
 * declare three times over, and the later `listen` wins.
 */
export const fpmStartCommand = (port: number, mapWindowsWorker = true): ReadonlyArray<string> => [
  "sh",
  "-c",
  [
    "set -eu",
    ...(mapWindowsWorker ? windowsBindWorkerIdentity() : []),
    `printf 'include=/usr/local/etc/php-fpm.conf\\n[www]\\nlisten = ${String(port)}\\n' > ${PHP_FPM_CONFIG_PATH}`,
    `exec php-fpm -y ${PHP_FPM_CONFIG_PATH}`,
  ].join("\n"),
];
