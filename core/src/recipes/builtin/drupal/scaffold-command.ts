import { scaffoldProtocol } from "../scaffold-protocol.ts";

/**
 * Readable source for the Drupal scaffold tooling command. It lives apart from
 * the renderer so the published snapshot can carry the same text without
 * importing renderer machinery.
 *
 * Drupal stages a complete project (Drupal plus project-local Drush) and
 * promotes it with the shared scaffold protocol.
 */
export const drupalScaffoldCommand = (major: string): string =>
  scaffoldProtocol({
    label: "Drupal",
    markerPrefix: ".lando-drupal-scaffold",
    stagingMarker: ".lando-drupal-stage-complete",
    appRootEnv: "LANDO_DRUPAL_APP_ROOT",
    stagingRootEnv: "LANDO_DRUPAL_STAGING_ROOT",
    defaultAppRoot: "/app",
    stagingPrefix: "lando-drupal-",
    completeMessage: "Drupal is already scaffolded at $app_root.",
    outputs: "composer.json, vendor/bin/drush, and web/",
    complete: [
      'test -f "$app_root/composer.json"',
      'test -x "$app_root/vendor/bin/drush"',
      'test -d "$app_root/web"',
    ],
    generate: [
      `composer create-project 'drupal/recommended-project:^${major}' "$staging_root"`,
      'composer --working-dir="$staging_root" require drush/drush',
      'test -f "$staging_root/composer.json"',
      'test -x "$staging_root/vendor/bin/drush"',
      'test -d "$staging_root/web"',
    ],
  });

export const DRUPAL_SCAFFOLD_COMMAND = drupalScaffoldCommand("11");
