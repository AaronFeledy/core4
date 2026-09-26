/** Drupal CMS installation needs more than the PHP image's 128 MiB default. */
export const DRUPAL_CMS_PHP_INI_PATH = ".lando/php/drupal-cms.ini";
export const DRUPAL_CMS_PHP_INI = "memory_limit = 512M\n";
export const DRUPAL_CMS_PHP_INI_TARGET = "/usr/local/etc/php/conf.d/50-lando-drupal-cms.ini";
