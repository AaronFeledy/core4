import type { ToolingTaskShape } from "@lando/sdk/schema";
import type { ServiceBuildStepIntent } from "@lando/sdk/services";

import type { PhpVia } from "./php-via.ts";

export const PHP_XDEBUG_RELEASE = {
  version: "3.5.3",
  sha256: "f073de91bea046106abf4d6071c963ea71e58571df6ce58948ceca89d121cb2d",
  url: "https://pecl.php.net/get/xdebug-3.5.3.tgz",
} as const;

export const PHP_XDEBUG_PORT = 9003;
export const PHP_XDEBUG_CLIENT_HOST = "host.docker.internal";
export const PHP_XDEBUG_INI = "/usr/local/etc/php/conf.d/zz-lando-xdebug.ini";
export const PHP_XDEBUG_SOURCE_DIR = `xdebug-${PHP_XDEBUG_RELEASE.version}`;

export const PHP_XDEBUG_MODES = [
  "off",
  "develop",
  "coverage",
  "debug",
  "gcstats",
  "profile",
  "trace",
] as const;

export type PhpXdebugMode = (typeof PHP_XDEBUG_MODES)[number];
export type PhpXdebug =
  | false
  | {
      readonly mode: string;
      readonly release: typeof PHP_XDEBUG_RELEASE;
    };

const XDEBUG_REMEDIATION =
  'Set xdebug: true, xdebug: false, or a comma-separated Xdebug 3 mode list such as xdebug: "debug,develop".';

const isXdebugMode = (value: string): value is PhpXdebugMode =>
  (PHP_XDEBUG_MODES as ReadonlyArray<string>).includes(value);

const parseModeString = (value: string): string => {
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.some((token) => !isXdebugMode(token))) {
    throw new Error(`Unsupported Xdebug mode ${JSON.stringify(value)}. ${XDEBUG_REMEDIATION}`);
  }
  return tokens.join(",");
};

export const resolvePhpXdebug = (value: unknown): PhpXdebug => {
  if (value === undefined || value === false) return false;
  if (value === true) return { mode: "debug", release: PHP_XDEBUG_RELEASE };
  if (typeof value === "string") return { mode: parseModeString(value), release: PHP_XDEBUG_RELEASE };
  throw new Error(`Unsupported Xdebug mode ${JSON.stringify(value)}. ${XDEBUG_REMEDIATION}`);
};

export const phpXdebugConfigEnv = (mode: string, customImage: boolean): Readonly<Record<string, string>> => {
  const config = {
    XDEBUG_CONFIG: `client_host=${PHP_XDEBUG_CLIENT_HOST} client_port=${String(PHP_XDEBUG_PORT)}`,
  };
  if (!customImage) return config;
  return { ...config, XDEBUG_MODE: mode };
};

export const phpXdebugBuildStep = (
  phpVersion: string,
  xdebug: Exclude<PhpXdebug, false>,
): ServiceBuildStepIntent => {
  const { mode, release } = xdebug;
  const command = [
    "set -eux",
    "apt-get update",
    "apt-get install -y --no-install-recommends $PHPIZE_DEPS",
    `php -r '$url = "${release.url}"; $target = "/tmp/xdebug.tgz"; if (copy($url, $target) !== true) { exit(1); } $actual = hash_file("sha256", $target); if ($actual === false || !hash_equals("${release.sha256}", $actual)) { fwrite(STDERR, "Xdebug checksum mismatch\\n"); exit(1); }'`,
    "tar -xzf /tmp/xdebug.tgz -C /tmp",
    `( cd /tmp/${PHP_XDEBUG_SOURCE_DIR} && phpize && ./configure --enable-xdebug && make -j"$(nproc)" && make install )`,
    "docker-php-ext-enable xdebug",
    [
      `cat > ${PHP_XDEBUG_INI} <<'LANDO_XDEBUG_INI'`,
      `xdebug.mode=${mode}`,
      `xdebug.client_host=${PHP_XDEBUG_CLIENT_HOST}`,
      `xdebug.client_port=${String(PHP_XDEBUG_PORT)}`,
      "LANDO_XDEBUG_INI",
    ].join("\n"),
    `rm -rf /tmp/xdebug.tgz /tmp/${PHP_XDEBUG_SOURCE_DIR}`,
    "apt-get purge -y $PHPIZE_DEPS",
    "rm -rf /var/lib/apt/lists/*",
  ].join(" && ");

  return {
    id: "service-lando.php:xdebug",
    phase: "build",
    command,
    dependsOn: ["service-lando.php:prerequisites"],
    buildKeyInputs: {
      xdebug: { ...release, phpVersion, mode },
    },
  };
};

const reloadSnippet = (via: PhpVia): string => {
  switch (via) {
    case "apache":
      return "apache2ctl graceful 2>/dev/null || kill -USR1 1 2>/dev/null || true";
    case "fpm":
      return "kill -USR2 1 2>/dev/null || true";
    case "cli":
      return "true";
    default: {
      const exhaustive: never = via;
      return exhaustive;
    }
  }
};

export const phpXdebugTooling = (
  serviceName: string,
  via: PhpVia,
  mode: string,
): Readonly<Record<string, ToolingTaskShape>> => {
  const reload = reloadSnippet(via);
  const script = [
    "set -eu",
    `ini="${PHP_XDEBUG_INI}"`,
    `mode="${mode}"`,
    "cmd=${1:-status}",
    "write_ini() {",
    `  printf "xdebug.mode=%s\nxdebug.client_host=%s\nxdebug.client_port=%s\n" "$1" "${PHP_XDEBUG_CLIENT_HOST}" "${String(PHP_XDEBUG_PORT)}" > "$ini"`,
    "}",
    `reload() { ${reload}; }`,
    'case "$cmd" in',
    '  on) write_ini "$mode"; reload; php -m | grep -i xdebug; php -r \'echo ini_get("xdebug.mode"), "\\n";\' ;;',
    "  off) write_ini off; reload; echo off ;;",
    '  status) php -m | grep -i xdebug || true; php -r \'echo ini_get("xdebug.mode"), "\\n";\' ;;',
    '  *) echo "Use lando xdebug on, lando xdebug off, or lando xdebug status."; exit 1 ;;',
    "esac",
  ].join("\n");

  return {
    xdebug: {
      service: serviceName,
      cmd: ["sh", "-c", script, "xdebug"],
    },
  };
};
