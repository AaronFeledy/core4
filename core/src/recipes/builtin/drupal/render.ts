import type { RecipeRenderer } from "../registry.ts";
import { DRUPAL_RECIPE_ID } from "./manifest.ts";

export const DRUPAL_SCAFFOLD_COMMAND = [
  "set -eu",
  "app_root=/app",
  "if printenv LANDO_DRUPAL_APP_ROOT >/dev/null 2>&1; then app_root=$(printenv LANDO_DRUPAL_APP_ROOT); fi",
  "staging_root=/tmp/lando-drupal-scaffold",
  "if printenv LANDO_DRUPAL_STAGING_ROOT >/dev/null 2>&1; then staging_root=$(printenv LANDO_DRUPAL_STAGING_ROOT); fi",
  'complete_marker="$app_root/.lando-drupal-scaffold-complete"',
  'copy_state="$app_root/.lando-drupal-scaffold-copying"',
  'test ! -e "$complete_marker" || { echo "Drupal is already scaffolded at $app_root." >&2; exit 1; }',
  'mkdir -p "$app_root"',
  'if test -f "$copy_state"; then while IFS= read -r path; do case "$path" in ""|"."|".."|*/*) echo "Invalid Drupal scaffold recovery path: $path" >&2; exit 1;; esac; rm -rf -- "$app_root/$path"; done < "$copy_state"; rm -f "$copy_state"; fi',
  'rm -rf "$staging_root"',
  'mkdir -p "$staging_root"',
  "trap 'rm -rf \"$staging_root\"' EXIT",
  "composer create-project 'drupal/recommended-project:^11' \"$staging_root\"",
  'composer --working-dir="$staging_root" require drush/drush',
  'test -f "$staging_root/composer.json"',
  'test -x "$staging_root/vendor/bin/drush"',
  'touch "$staging_root/.lando-drupal-stage-complete"',
  'state_tmp="$copy_state.tmp"',
  'find "$staging_root" -mindepth 1 -maxdepth 1 ! -name .lando-drupal-stage-complete -printf "%f\\n" > "$state_tmp"',
  'mv "$state_tmp" "$copy_state"',
  'test -f "$staging_root/.lando-drupal-stage-complete"',
  'cp -R "$staging_root"/. "$app_root"/',
  'rm -f "$app_root/.lando-drupal-stage-complete"',
  'test -f "$app_root/composer.json"',
  'test -x "$app_root/vendor/bin/drush"',
  'touch "$complete_marker"',
  'rm -f "$copy_state"',
].join("; ");

const renderLandofile = (appName: string, php: string, database: string): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${DRUPAL_RECIPE_ID}`,
    "services:",
    "  appserver:",
    `    type: php:${php}`,
    "    framework: drupal",
    "    webroot: /app/web",
    "    allowOverride: true",
    "    port: 80",
    "    dependsOn:",
    "      - database",
    "  database:",
    `    type: ${database}`,
    "tooling:",
    "  drush:",
    "    service: appserver",
    "    description: Run Drush inside the appserver service.",
    "    cmds:",
    "      - vendor/bin/drush",
    "  composer:",
    "    service: appserver",
    "    description: Run Composer inside the appserver service.",
    "    cmds:",
    "      - composer",
    "  drupal-scaffold:",
    "    service: appserver",
    "    description: Scaffold Drupal 11 and project-local Drush into the mounted app root.",
    `    cmd: ${JSON.stringify(DRUPAL_SCAFFOLD_COMMAND)}`,
    "",
  ].join("\n");

export const drupalRenderer: RecipeRenderer = {
  id: DRUPAL_RECIPE_ID,
  render: ({ appName, answers }) => {
    const php = typeof answers.php === "string" ? answers.php : "8.3";
    const database = typeof answers.database === "string" ? answers.database : "mariadb";
    return new Map([[".lando.yml", renderLandofile(appName, php, database)]]);
  },
};
