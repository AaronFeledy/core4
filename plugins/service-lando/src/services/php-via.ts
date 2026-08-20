import type { LogSource, ServiceConfig } from "@lando/sdk/schema";
import { AbsolutePath, LogSourceId } from "@lando/sdk/schema";

export const PHP_VIA_MODES = ["apache", "fpm", "cli"] as const;
export type PhpVia = (typeof PHP_VIA_MODES)[number];

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

const VIA_REMEDIATION = "Set via: apache, via: fpm, or via: cli.";

const isPhpVia = (value: string): value is PhpVia => (PHP_VIA_MODES as ReadonlyArray<string>).includes(value);

export const resolvePhpVia = (value: unknown): PhpVia => {
  if (value === undefined) return "apache";
  if (typeof value === "string" && isPhpVia(value)) return value;
  throw new Error(`Unsupported PHP serving mode ${JSON.stringify(value)}. ${VIA_REMEDIATION}`);
};

export const phpImageFor = (version: string, via: PhpVia): string => `php:${version}-${via}-bookworm`;

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

export const apacheStartCommand = (webroot: string, allowOverride: boolean): ReadonlyArray<string> => {
  const override = allowOverride ? "All" : "None";
  return [
    "sh",
    "-c",
    [
      "set -eu",
      "cat > /etc/apache2/sites-available/000-default.conf <<'LANDO_APACHE_SITE'",
      "<VirtualHost *:80>",
      `  DocumentRoot ${webroot}`,
      `  <Directory ${webroot}>`,
      "    Options -Indexes +FollowSymLinks",
      `    AllowOverride ${override}`,
      "    Require all granted",
      "  </Directory>",
      "</VirtualHost>",
      "LANDO_APACHE_SITE",
      "exec apache2-foreground",
    ].join("\n"),
  ];
};
