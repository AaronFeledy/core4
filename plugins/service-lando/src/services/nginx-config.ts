import type { ServiceBuildStepIntent } from "@lando/sdk/services";

/**
 * Where a generated nginx launcher writes its configuration.
 *
 * `/tmp` is mode `1777` in every nginx image Lando ships, so the planned
 * service user can always write here. The image's own `/etc/nginx` tree stays
 * read-only to the running process, and nothing widens permissions on it.
 */
export const NGINX_CONFIG_PATH = "/tmp/lando-nginx.conf" as const;

/** Where the master process writes its pid; the image default is root-owned. */
export const NGINX_PID_PATH = "/tmp/lando-nginx.pid" as const;

const NGINX_CONFIG_HEREDOC = "LANDO_NGINX_CONF" as const;

/**
 * nginx creates each temp directory with a single `mkdir`, not `mkdir -p`, so
 * every path here is a leaf directly under `/tmp`. A nested path fails at
 * startup with `mkdir() ... failed (2: No such file or directory)`.
 */
const NGINX_TEMP_PATHS: ReadonlyArray<readonly [directive: string, path: string]> = [
  ["client_body_temp_path", "/tmp/lando-nginx-client-body"],
  ["proxy_temp_path", "/tmp/lando-nginx-proxy"],
  ["fastcgi_temp_path", "/tmp/lando-nginx-fastcgi"],
  ["uwsgi_temp_path", "/tmp/lando-nginx-uwsgi"],
  ["scgi_temp_path", "/tmp/lando-nginx-scgi"],
];

export const NGINX_DEFAULT_SITE_BUILD_STEP_ID = "service-lando.nginx:default-site" as const;

/**
 * Retires the image's own `conf.d/default.conf` during the image build.
 *
 * A generated launcher owns the main configuration and declares its server
 * block there, but it still includes the rest of `conf.d` so an author's own
 * drop-in keeps working. The stock file would otherwise claim `localhost` on
 * the same port and answer requests from `/usr/share/nginx/html`.
 */
export const nginxDefaultSiteRemovalBuildStep = (): ServiceBuildStepIntent => ({
  id: NGINX_DEFAULT_SITE_BUILD_STEP_ID,
  phase: "build",
  user: "root",
  command: ["rm", "-f", "/etc/nginx/conf.d/default.conf"],
});

/**
 * Whether the planned identity is the superuser, and so whether nginx can act
 * on a `user` directive at all.
 *
 * `user:` is an unrestricted string, so accept every spelling of root a
 * container accepts: the bare name, any numeric zero, and either with a group
 * suffix.
 */
const runsAsRoot = (user: string | undefined): boolean => {
  if (user === undefined) return true;
  const principal = (user.split(":")[0] ?? "").trim();
  return principal === "" || principal === "root" || /^0+$/u.test(principal);
};

const rejectUnquotableLine = (line: string): void => {
  if (/[\r\n]/u.test(line)) {
    throw new Error("nginx configuration lines cannot contain a line break.");
  }
  if (line.trim() === NGINX_CONFIG_HEREDOC) {
    throw new Error(`nginx configuration lines cannot be the literal ${NGINX_CONFIG_HEREDOC}.`);
  }
};

/**
 * The complete nginx configuration a generated launcher runs.
 *
 * `nginx -c` replaces the main configuration file rather than adding a
 * `conf.d` drop-in, so this reproduces the image's own `nginx.conf` and then
 * differs from it in exactly three places: the pid path and the temp paths
 * move under `/tmp`, and the caller's server block is declared here instead of
 * arriving through the retired stock `default.conf`. The rest of `conf.d` is
 * still included. `-c` makes this file's own directory the configuration
 * prefix, so every `include` here names an absolute path; a bare
 * `fastcgi_params` would resolve under `/tmp` and nginx would refuse to start.
 */
export const renderNginxConfig = (input: {
  readonly user: string | undefined;
  readonly serverBlock: ReadonlyArray<string>;
}): string => {
  for (const line of input.serverBlock) rejectUnquotableLine(line);
  return [
    // A non-root master cannot change worker identity, and nginx warns twice
    // when asked to; emit the directive only where it can be honored.
    ...(runsAsRoot(input.user) ? ["user nginx;"] : []),
    "worker_processes auto;",
    "error_log /var/log/nginx/error.log notice;",
    `pid ${NGINX_PID_PATH};`,
    "events {",
    "  worker_connections 1024;",
    "}",
    "http {",
    "  include /etc/nginx/mime.types;",
    "  default_type application/octet-stream;",
    `  log_format main '$remote_addr - $remote_user [$time_local] "$request" '`,
    `                  '$status $body_bytes_sent "$http_referer" '`,
    `                  '"$http_user_agent" "$http_x_forwarded_for"';`,
    "  access_log /var/log/nginx/access.log main;",
    ...NGINX_TEMP_PATHS.map(([directive, path]) => `  ${directive} ${path};`),
    "  sendfile on;",
    "  keepalive_timeout 65;",
    ...input.serverBlock,
    "  include /etc/nginx/conf.d/*.conf;",
    "}",
  ].join("\n");
};

/**
 * The launcher a Lando-owned nginx service runs as PID 1.
 *
 * The configuration is written where the planned user can write and nginx is
 * pointed at it explicitly, so the command needs no permission on any path the
 * image owns and runs unchanged as a non-root `user:`.
 */
export const nginxLauncherCommand = (input: {
  readonly user: string | undefined;
  readonly serverBlock: ReadonlyArray<string>;
}): ReadonlyArray<string> => [
  "sh",
  "-c",
  [
    "set -eu",
    `cat > ${NGINX_CONFIG_PATH} <<'${NGINX_CONFIG_HEREDOC}'`,
    renderNginxConfig(input),
    NGINX_CONFIG_HEREDOC,
    `exec nginx -c ${NGINX_CONFIG_PATH} -g 'daemon off;'`,
  ].join("\n"),
];
