import type { ServiceBuildStepIntent } from "@lando/sdk/services";

export const PHP_WP_CLI = {
  version: "2.12.0",
  sha256: "ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c",
  url: "https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar",
} as const;

const WORDPRESS_INI = {
  path: "/usr/local/etc/php/conf.d/50-lando-wordpress.ini",
  content: "memory_limit = 512M\n",
} as const;

export const PHP_WP_CLI_STEP: ServiceBuildStepIntent = {
  id: "service-lando.php:wp-cli",
  phase: "build",
  command: [
    "set -eux",
    `printf '%s\\n' '${WORDPRESS_INI.content.trimEnd()}' > ${WORDPRESS_INI.path}`,
    `php -r '$url = "${PHP_WP_CLI.url}"; $target = "/tmp/wp-cli.phar"; if (copy($url, $target) !== true) { exit(1); } $actual = hash_file("sha256", $target); if ($actual === false || !hash_equals("${PHP_WP_CLI.sha256}", $actual)) { fwrite(STDERR, "WP-CLI checksum mismatch\\n"); exit(1); }'`,
    "install -m 0755 /tmp/wp-cli.phar /usr/local/bin/wp",
    "rm -f /tmp/wp-cli.phar",
  ].join(" && "),
  user: "root",
  buildKeyInputs: { wpCli: PHP_WP_CLI, wordpressIni: WORDPRESS_INI },
};
