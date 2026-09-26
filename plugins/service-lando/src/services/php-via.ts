import type { LogSource, ServiceConfig } from "@lando/sdk/schema";
import { AbsolutePath, LogSourceId } from "@lando/sdk/schema";
import type { ServiceBuildStepIntent } from "@lando/sdk/services";

import { apacheDirectivePath } from "./apache.ts";
import { apacheErrorPageDirectives } from "./http-errors.ts";

export const PHP_VIA_MODES = ["apache", "fpm", "cli"] as const;
export type PhpVia = (typeof PHP_VIA_MODES)[number];

export const APACHE_DEFAULT_SITE_BUILD_STEP_ID = "service-lando.php:apache-default-site" as const;

export const PHP_FPM_PORT = 9000;
export const PHP_APACHE_PORT = 80;
export const PHP_CLI_KEEP_ALIVE: ReadonlyArray<string> = ["sh", "-c", "tail -f /dev/null"];

export const PHP_FPM_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("access"),
    label: "php-fpm access log",
    path: AbsolutePath.make("/var/log/php-fpm/access.log"),
    stream: "stdout",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
  {
    id: LogSourceId.make("error"),
    label: "php-fpm error log",
    path: AbsolutePath.make("/var/log/php-fpm/error.log"),
    stream: "stderr",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
];

export const PHP_APACHE_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("access"),
    label: "Apache access log",
    path: AbsolutePath.make("/var/log/apache2/access.log"),
    stream: "stdout",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
  {
    id: LogSourceId.make("error"),
    label: "Apache error log",
    path: AbsolutePath.make("/var/log/apache2/error.log"),
    stream: "stderr",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
];

export const phpLogSources = (via: PhpVia): ReadonlyArray<LogSource> => {
  switch (via) {
    case "apache":
      return PHP_APACHE_LOG_SOURCES;
    case "fpm":
      return PHP_FPM_LOG_SOURCES;
    case "cli":
      return [];
  }
};

const VIA_REMEDIATION = "Set via: apache, via: fpm, or via: cli.";

const isPhpVia = (value: string): value is PhpVia => (PHP_VIA_MODES as ReadonlyArray<string>).includes(value);

export const resolvePhpVia = (value: unknown): PhpVia => {
  if (value === undefined) return "apache";
  if (typeof value === "string" && isPhpVia(value)) return value;
  throw new Error(`Unsupported PHP serving mode ${JSON.stringify(value)}. ${VIA_REMEDIATION}`);
};

// Official Hub publishes PHP 8.6 as RC bookworm tags until GA. Other minors use the GA tag.
const phpUpstreamVersion = (version: string): string => (version === "8.6" ? "8.6-rc" : version);

export const phpImageFor = (version: string, via: PhpVia): string =>
  `php:${phpUpstreamVersion(version)}-${via}-bookworm`;

export const hasCustomPhpImage = (service: ServiceConfig): boolean => {
  if (service.image === undefined) return false;
  const version = service.type?.startsWith("php:") === true ? service.type.slice("php:".length) : undefined;
  return version === undefined || service.image !== phpImageFor(version, "apache");
};

export const phpListenPort = (via: PhpVia, authoredPort: number | undefined): number => {
  if (authoredPort !== undefined) return authoredPort;
  switch (via) {
    case "apache":
      return PHP_APACHE_PORT;
    case "fpm":
      return PHP_FPM_PORT;
    case "cli":
      return PHP_APACHE_PORT;
    default: {
      const exhaustive: never = via;
      return exhaustive;
    }
  }
};

export const phpEndpointProtocol = (via: PhpVia): "http" | "tcp" => (via === "fpm" ? "tcp" : "http");

export const assertPhpViaKeys = (via: PhpVia, service: ServiceConfig): void => {
  if ((via === "fpm" || via === "cli") && service.allowOverride !== undefined) {
    throw new Error(
      `allowOverride: is Apache-only. Remove allowOverride: from this ${via} service. ${VIA_REMEDIATION}`,
    );
  }
  if (via === "cli" && service.routes !== undefined) {
    throw new Error(
      `HTTP routes: are not valid for via: cli. Remove routes: or use via: apache / via: fpm. ${VIA_REMEDIATION}`,
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
 * during the image build leaves the main server answering every request, which
 * is the configuration the launcher's directives then describe in full.
 */
export const apacheDefaultSiteRemovalBuildStep = (): ServiceBuildStepIntent => ({
  id: APACHE_DEFAULT_SITE_BUILD_STEP_ID,
  phase: "build",
  user: "root",
  // `rm -f` rather than `a2dissite`, which fails when the site is already gone.
  command: ["rm", "-f", "/etc/apache2/sites-enabled/000-default.conf"],
});

/**
 * Shell prelude that, on a Windows host, re-maps `www-data` to the uid:gid
 * owning the project mount so the PHP worker can write bind-mounted files.
 * `preserveExplicitApacheIdentity` leaves an authored
 * `APACHE_RUN_USER`/`APACHE_RUN_GROUP` alone.
 */
export const windowsBindWorkerIdentity = (
  fallbackMount: string,
  preserveExplicitApacheIdentity = false,
): ReadonlyArray<string> => [
  `if test "\${LANDO_HOST_OS:-}" = win32${preserveExplicitApacheIdentity ? ' && test "${APACHE_RUN_USER:-www-data}" = www-data && test "${APACHE_RUN_GROUP:-www-data}" = www-data' : ""}; then`,
  `  lando_mount_owner=$(stat -c '%u:%g' -- "\${LANDO_PROJECT_MOUNT:-${fallbackMount}}")`,
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
 * An authored non-root service user runs the same directives directly.
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
    ...(listenPort === undefined
      ? site
      : [`Listen ${String(listenPort)}`, `<VirtualHost *:${String(listenPort)}>`, ...site, "</VirtualHost>"]),
  ];
  const flags = directives.flatMap((directive) => ["-c", directive]);
  if (!mapWindowsWorker) return ["apache2-foreground", ...flags];
  return [
    "sh",
    "-c",
    ["set -eu", ...windowsBindWorkerIdentity("/app", true), 'exec apache2-foreground "$@"'].join("\n"),
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
    ...(mapWindowsWorker ? windowsBindWorkerIdentity("/app") : []),
    `printf 'include=/usr/local/etc/php-fpm.conf\\n[www]\\nlisten = ${String(port)}\\n' > ${PHP_FPM_CONFIG_PATH}`,
    `exec php-fpm -y ${PHP_FPM_CONFIG_PATH}`,
  ].join("\n"),
];
