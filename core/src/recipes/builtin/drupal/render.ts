import {
  composerToolingLines,
  renderDatabaseLines,
  renderNginxEdgeLines,
  renderPhpAppserverLines,
  resolvePhpStackAnswers,
} from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { DRUPAL_RECIPE_ID } from "./manifest";

const DRUPAL_DEFAULTS = {
  php: "8.3",
  database: "mariadb:11.4",
  webroot: "/app/web",
  composer: "2",
} as const;

export const drupalScaffoldCommand = (major: string): string =>
  [
    "set -eu",
    "app_root=/app",
    "if printenv LANDO_DRUPAL_APP_ROOT >/dev/null 2>&1; then app_root=$(printenv LANDO_DRUPAL_APP_ROOT); fi",
    'staging_parent=$(printenv TMPDIR 2>/dev/null || true); if test -z "$staging_parent"; then staging_parent=/tmp; fi',
    "if printenv LANDO_DRUPAL_STAGING_ROOT >/dev/null 2>&1; then staging_parent=$(printenv LANDO_DRUPAL_STAGING_ROOT); fi",
    'complete_marker="$app_root/.lando-drupal-scaffold-complete"',
    'manifest="$app_root/.lando-drupal-scaffold-manifest"',
    'lock_dir="$app_root/.lando-drupal-scaffold-lock"',
    "lock_owned=0",
    "staging_root=",
    'cleanup() { if test -n "$staging_root"; then rm -rf "$staging_root"; fi; if test "$lock_owned" -eq 1; then rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true; fi; }',
    "trap cleanup EXIT",
    "trap 'exit 1' HUP INT TERM",
    'fail() { echo "$1" >&2; exit 1; }',
    'valid_name() { case "$1" in ""|"."|".."|*[!A-Za-z0-9._-]*) return 1;; *) return 0;; esac; }',
    'scaffold_valid() { test -f "$app_root/composer.json" && test -x "$app_root/vendor/bin/drush" && test -d "$app_root/web"; }',
    'mkdir -p "$app_root"',
    'if ! mkdir "$lock_dir" 2>/dev/null; then lock_pid=; if test -f "$lock_dir/pid"; then IFS= read -r lock_pid < "$lock_dir/pid" || lock_pid=; fi; case "$lock_pid" in ""|*[!0-9]*) fail "Drupal scaffold lock at $lock_dir has no recoverable owner.";; esac; if kill -0 "$lock_pid" 2>/dev/null; then fail "Drupal scaffold is already running for $app_root."; fi; rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || fail "Drupal scaffold lock at $lock_dir is not safely recoverable."; mkdir "$lock_dir" 2>/dev/null || fail "Unable to acquire Drupal scaffold lock for $app_root."; fi',
    'lock_owned=1; printf "%s\n" "$$" > "$lock_dir/pid"',
    'if test -e "$complete_marker" && scaffold_valid; then fail "Drupal is already scaffolded at $app_root."; fi',
    'repair=0; if test -e "$complete_marker"; then repair=1; fi',
    'if test -f "$manifest"; then while IFS=: read -r state entry; do valid_name "$entry" || fail "Invalid Drupal scaffold recovery path: $entry"; case "$state" in incomplete|ready|complete|preexisting) ;; *) fail "Invalid Drupal scaffold manifest state: $state";; esac; partial="$app_root/$entry.lando-partial"; if test -e "$partial" || test -L "$partial"; then rm -rf "$partial"; fi; done < "$manifest"; rm -f "$manifest"; fi',
    'mkdir -p "$staging_parent"',
    'app_key=$(basename "$app_root" | tr -c "A-Za-z0-9._-" "_")',
    'staging_root=$(mktemp -d "$staging_parent/lando-drupal-$app_key.XXXXXX") || fail "Unable to create a Drupal scaffold staging directory."',
    `composer create-project 'drupal/recommended-project:^${major}' "$staging_root"`,
    'composer --working-dir="$staging_root" require drush/drush',
    'test -f "$staging_root/composer.json"',
    'test -x "$staging_root/vendor/bin/drush"',
    'test -d "$staging_root/web"',
    'touch "$staging_root/.lando-drupal-stage-complete"',
    'manifest_tmp="$manifest.tmp.$$"',
    '(cd "$staging_root"; for entry in * .[!.]* ..?*; do if ! test -e "$entry" && ! test -L "$entry"; then continue; fi; test "$entry" = .lando-drupal-stage-complete && continue; valid_name "$entry" || fail "Invalid Drupal scaffold entry: $entry"; printf "incomplete:%s\n" "$entry"; done) > "$manifest_tmp"',
    'mv "$manifest_tmp" "$manifest"',
    'if test "$repair" -eq 1; then rm -f "$complete_marker"; fi',
    'write_state() { next_state=$1; wanted=$2; state_tmp="$manifest.tmp.$$"; while IFS=: read -r state entry; do if test "$entry" = "$wanted"; then printf "%s:%s\n" "$next_state" "$entry"; else printf "%s:%s\n" "$state" "$entry"; fi; done < "$manifest" > "$state_tmp"; mv "$state_tmp" "$manifest"; }',
    'while IFS=: read -r state entry; do test "$state" = incomplete || continue; target="$app_root/$entry"; partial="$target.lando-partial"; if test -e "$target" || test -L "$target"; then if test -d "$target" && ! test -L "$target" && test -z "$(ls -A "$target" 2>/dev/null)"; then cp -R "$staging_root/$entry/." "$target/"; write_state complete "$entry"; continue; fi; write_state preexisting "$entry"; continue; fi; if test -e "$partial" || test -L "$partial"; then fail "Drupal scaffold partial path already exists: $partial"; fi; cp -R "$staging_root/$entry" "$partial"; write_state ready "$entry"; mv "$partial" "$target"; write_state complete "$entry"; done < "$manifest"',
    'scaffold_valid || fail "Drupal scaffold did not produce composer.json, vendor/bin/drush, and web/."',
    'touch "$complete_marker"',
    'rm -f "$manifest"',
  ].join("\n");

export const DRUPAL_SCAFFOLD_COMMAND = drupalScaffoldCommand("11");

const renderLandofile = (
  appName: string,
  answers: Parameters<RecipeRenderer["render"]>[0]["answers"],
): string => {
  const stack = resolvePhpStackAnswers(answers, DRUPAL_DEFAULTS);
  const major = typeof answers.drupal === "string" ? answers.drupal : "11";
  const scaffold = drupalScaffoldCommand(major);
  return [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${DRUPAL_RECIPE_ID}`,
    "services:",
    ...renderPhpAppserverLines({
      php: stack.php,
      webroot: stack.webroot,
      composer: stack.composer,
      webserver: stack.webserver,
      allowOverride: true,
      port: 80,
      dependsOn: ["database"],
      framework: "drupal",
    }),
    ...(stack.webserver === "nginx" ? renderNginxEdgeLines() : []),
    ...renderDatabaseLines(stack.database),
    "tooling:",
    "  drush:",
    "    service: appserver",
    "    description: Run Drush inside the appserver service.",
    "    cmds:",
    "      - vendor/bin/drush",
    ...(stack.composer === false ? [] : composerToolingLines()),
    "  drupal-scaffold:",
    "    service: appserver",
    "    description: Scaffold Drupal and project-local Drush into the mounted app root.",
    "    arguments: false",
    `    cmd: ${JSON.stringify(scaffold)}`,
    "",
  ].join("\n");
};

export const drupalRenderer: RecipeRenderer = {
  id: DRUPAL_RECIPE_ID,
  render: ({ appName, answers }) => new Map([[".lando.yml", renderLandofile(appName, answers)]]),
};
