// Workflow codegen reads these before the SDK is built.
export const ELASTICSEARCH_DEFAULT_IMAGE = "docker.elastic.co/elasticsearch/elasticsearch:8.19.25";
export const NGINX_DEFAULT_IMAGE = "nginx:1.30-alpine";

export const PHP_VIA_MODES = ["apache", "fpm", "cli"] as const;
export type PhpVia = (typeof PHP_VIA_MODES)[number];
export const SUPPORTED_PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] as const;
export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];
export const phpImageFor = (version: string, via: PhpVia): string => `php:${version}-${via}-bookworm`;

export const VARNISH_IMAGES = {
  "6": "varnish:6",
  "7": "varnish:7",
} as const;
