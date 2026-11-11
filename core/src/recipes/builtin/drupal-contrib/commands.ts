/**
 * Readable source for Drupal contrib tooling commands. They live apart from the
 * renderer so the published snapshot can carry the same text without importing
 * renderer machinery.
 */

export const DRUPAL_CONTRIB_CHROME_IMAGE = "selenium/standalone-chromium:155.0-20261010";

export const DRUPAL_CONTRIB_MINK_DRIVER_ARGS =
  '["chrome", {"browserName":"chrome","goog:chromeOptions":{"w3c":true,"args":["--headless=new","--disable-gpu","--no-sandbox"]}}, "http://chrome:4444"]';

export const contribMountRel = (type: string, project: string): string => `web/${type}s/custom/${project}`;

export const contribMountTarget = (type: string, project: string): string =>
  `/app/${contribMountRel(type, project)}`;

export const mysqlSimpletestDb =
  "mysql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database/{{ services.database.creds.database }}";

export const pgsqlSimpletestDb =
  "pgsql://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database/{{ url.encodeComponent(services.database.creds.database) }}";

const phpMergeModuleDeps = [
  "$site = $argv[1]; $module = $argv[2]; $mount = $argv[3];",
  "$read = function($file) { return json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR); };",
  '$root = $read($site . "/composer.json");',
  '$module_json = is_file($module . "/composer.json") ? $read($module . "/composer.json") : [];',
  '$self = is_string($module_json["name"] ?? null) ? $module_json["name"] : "";',
  '$skip = ["php" => true, "composer-plugin-api" => true, "composer-runtime-api" => true, "drupal/core" => true, "drupal/core-recommended" => true, "drupal/core-dev" => true, "drupal/core-composer-scaffold" => true];',
  'if ($self !== "") $skip[$self] = true;',
  'foreach (["require", "require-dev"] as $bucket) {',
  "  if (!isset($module_json[$bucket]) || !is_array($module_json[$bucket])) continue;",
  "  foreach ($module_json[$bucket] as $package => $version) {",
  '    if (!is_string($package) || !is_string($version) || isset($skip[$package]) || str_starts_with($package, "ext-")) continue;',
  '    if (isset($root["require"][$package]) || isset($root["require-dev"][$package])) continue;',
  '    $target = $bucket === "require-dev" ? "require-dev" : "require";',
  "    $root[$target][$package] = $version;",
  "  }",
  "}",
  '$path = ["type" => "path", "url" => $mount, "options" => ["symlink" => false]];',
  "$repositories = [];",
  'if (is_array($root["repositories"] ?? null)) { foreach ($root["repositories"] as $key => $repository) {',
  '  if (is_array($repository) && ($repository["type"] ?? null) === "path" && ($repository["url"] ?? null) === $mount) continue;',
  "  $repositories[$key] = $repository;",
  "} }",
  '$root["repositories"] = ["lando-contrib" => $path] + $repositories;',
  'file_put_contents($site . "/composer.json", json_encode($root, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\\n");',
].join(" ");

const phpUpdateCoreConstraint = [
  "$file = $argv[1]; $constraint = $argv[2];",
  "$root = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);",
  'if (!is_array($root["require"] ?? null) || !is_array($root["require-dev"] ?? null)) { fwrite(STDERR, "Site composer.json is missing require or require-dev.\\n"); exit(1); }',
  '$root["require"]["drupal/core-recommended"] = $constraint;',
  'if (isset($root["require"]["drupal/core-composer-scaffold"])) $root["require"]["drupal/core-composer-scaffold"] = $constraint;',
  '$root["require-dev"]["drupal/core-dev"] = $constraint;',
  'file_put_contents($file, json_encode($root, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\\n");',
].join(" ");

const phpUpdateLandofileConstraint = [
  "$file = $argv[1]; $constraint = $argv[2];",
  'if (!is_file($file)) { fwrite(STDERR, "Landofile not found at $file\\n"); exit(1); }',
  "$text = file_get_contents($file);",
  "$encoded = json_encode($constraint, JSON_UNESCAPED_SLASHES);",
  'if (!is_string($encoded)) { fwrite(STDERR, "Unable to encode the Drupal constraint.\\n"); exit(1); }',
  '$updated = preg_replace("/^(\\s+drupal:\\s*).+$/m", "$1" . $encoded, $text, 1, $count);',
  'if ($count !== 1) { fwrite(STDERR, "Unable to update recipe.options.drupal in $file\\n"); exit(1); }',
  "file_put_contents($file, $updated);",
].join(" ");

export const drupalContribScaffoldCommand = (constraint: string, project: string, type: string): string =>
  [
    "set -eu",
    `constraint='${constraint}'`,
    `project='${project}'`,
    `type='${type}'`,
    "app_root=/app",
    "if printenv LANDO_DRUPAL_CONTRIB_APP_ROOT >/dev/null 2>&1; then app_root=$(printenv LANDO_DRUPAL_CONTRIB_APP_ROOT); fi",
    'staging_parent=$(printenv TMPDIR 2>/dev/null || true); if test -z "$staging_parent"; then staging_parent=/tmp; fi',
    "if printenv LANDO_DRUPAL_CONTRIB_STAGING_ROOT >/dev/null 2>&1; then staging_parent=$(printenv LANDO_DRUPAL_CONTRIB_STAGING_ROOT); fi",
    'mount_rel="web/${type}s/custom/${project}"',
    'mount_path="$app_root/$mount_rel"',
    'complete_marker="$app_root/.lando-drupal-contrib-scaffold-complete"',
    'lock_dir="$app_root/.lando-drupal-contrib-scaffold-lock"',
    "lock_owned=0",
    "staging_root=",
    'cleanup() { if test -n "$staging_root"; then rm -rf "$staging_root"; fi; if test "$lock_owned" -eq 1; then rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true; fi; }',
    "trap cleanup EXIT",
    "trap 'exit 1' HUP INT TERM",
    'fail() { echo "$1" >&2; exit 1; }',
    "valid_project() { printf '%s' \"$1\" | grep -Eq '^[a-z][a-z0-9_]*$'; }",
    'valid_type() { case "$1" in module|theme|profile) return 0;; *) return 1;; esac; }',
    "valid_constraint() { printf '%s' \"$1\" | grep -Eq '^[v0-9^~<>=*.,@| a-zA-Z-]+$'; }",
    'skipped_rel() { case "$1" in "$mount_rel"|"$mount_rel"/*) return 0;; *) return 1;; esac; }',
    'fill_tree() ( src=$1; dest=$2; rel=$3; for child in "$src"/* "$src"/.[!.]* "$src"/..?*; do if ! test -e "$child" && ! test -L "$child"; then continue; fi; name=$(basename -- "$child"); if test "$name" = .lando-drupal-contrib-stage-complete; then continue; fi; child_rel=$name; if test -n "$rel"; then child_rel="$rel/$name"; fi; if skipped_rel "$child_rel"; then continue; fi; target="$dest/$name"; if test -d "$child" && ! test -L "$child"; then mkdir -p "$target"; fill_tree "$child" "$target" "$child_rel"; continue; fi; if test -e "$target" || test -L "$target"; then continue; fi; cp -a "$child" "$target"; done )',
    'scaffold_valid() { test -f "$app_root/composer.json" && test -x "$app_root/vendor/bin/drush" && test -d "$app_root/web/core" && test -f "$app_root/web/index.php"; }',
    'valid_project "$project" || fail "Drupal contrib project must be a machine name matching the root *.info.yml."',
    'valid_type "$type" || fail "Drupal contrib type must be module, theme, or profile."',
    'valid_constraint "$constraint" || fail "Drupal contrib core constraint is invalid."',
    'mkdir -p "$app_root"',
    'if ! mkdir "$lock_dir" 2>/dev/null; then lock_pid=; if test -f "$lock_dir/pid"; then IFS= read -r lock_pid < "$lock_dir/pid" || lock_pid=; fi; case "$lock_pid" in ""|*[!0-9]*) fail "Drupal contrib scaffold lock at $lock_dir has no recoverable owner.";; esac; if kill -0 "$lock_pid" 2>/dev/null; then fail "Drupal contrib scaffold is already running for $app_root."; fi; rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || fail "Drupal contrib scaffold lock at $lock_dir is not safely recoverable."; mkdir "$lock_dir" 2>/dev/null || fail "Unable to acquire Drupal contrib scaffold lock for $app_root."; fi',
    'lock_owned=1; printf "%s\\n" "$$" > "$lock_dir/pid"',
    'if test -e "$complete_marker" && scaffold_valid; then fail "Drupal contrib is already scaffolded at $app_root."; fi',
    'test -d "$mount_path" || fail "Extension mount is missing at $mount_path. Start the app so the nested bind is present, then rerun the scaffold."',
    "info_count=0",
    'info_file=; for candidate in "$mount_path"/*.info.yml; do if test -e "$candidate" || test -L "$candidate"; then info_count=$((info_count + 1)); info_file=$candidate; fi; done',
    'test "$info_count" -eq 1 || fail "Expected exactly one *.info.yml at the extension root."',
    'info_name=$(basename -- "$info_file" .info.yml)',
    'test "$info_name" = "$project" || fail "Root info.yml machine name ($info_name) does not match recipe.project ($project). Re-init with --answer=project=$info_name."',
    "info_type=$(sed -n 's/^type:[[:space:]]*//p' \"$info_file\" | head -n 1 | tr -d '[:space:]\"')",
    'test "$info_type" = "$type" || fail "Root info.yml type ($info_type) does not match recipe.type ($type). Re-init with --answer=type=$info_type."',
    'mkdir -p "$staging_parent"',
    'app_key=$(basename "$app_root" | tr -c "A-Za-z0-9._-" "_")',
    'staging_root=$(mktemp -d "$staging_parent/lando-drupal-contrib-$app_key.XXXXXX") || fail "Unable to create a Drupal contrib scaffold staging directory."',
    'composer create-project --no-install --no-scripts --no-interaction "drupal/recommended-project:$constraint" "$staging_root"',
    'composer --working-dir="$staging_root" require --dev --no-update --no-interaction "drupal/core-dev:$constraint" \'drupal/coder:^8.3\'',
    'composer --working-dir="$staging_root" require --no-update --no-interaction drush/drush',
    'composer --working-dir="$staging_root" update --no-interaction',
    'test -f "$staging_root/composer.json"',
    'test -x "$staging_root/vendor/bin/drush"',
    'test -d "$staging_root/web"',
    'test -d "$staging_root/web/core" || fail "Drupal contrib scaffold did not install web/core."',
    'test -f "$staging_root/web/index.php" || fail "Drupal contrib scaffold did not install web/index.php."',
    'touch "$staging_root/.lando-drupal-contrib-stage-complete"',
    'fill_tree "$staging_root" "$app_root" ""',
    'test -f "$mount_path/$project.info.yml" || fail "Drupal contrib scaffold overwrote or lost the extension mount."',
    'test ! -e "$app_root/web/${type}s/contrib/$project" || fail "Drupal contrib scaffold installed the extension into contrib. The path repository must not composer-require the extension package."',
    `php -r '${phpMergeModuleDeps}' "$app_root" "$mount_path" "$mount_rel" || fail "Unable to merge the extension composer.json require and require-dev into the site."`,
    'composer --working-dir="$app_root" update --no-interaction',
    'test -x "$app_root/vendor/bin/phpunit" || fail "Drupal contrib scaffold did not install vendor/bin/phpunit from drupal/core-dev."',
    'test -x "$app_root/vendor/bin/phpcs" || fail "Drupal contrib scaffold did not install vendor/bin/phpcs from drupal/coder."',
    'if test -x "$app_root/vendor/bin/phpcs"; then "$app_root/vendor/bin/phpcs" --config-set installed_paths "$app_root/vendor/drupal/coder/coder_sniffer" >/dev/null || true; fi',
    'mkdir -p "$app_root/web/sites/simpletest/browser_output" "$app_root/web/sites/default/files/simpletest"',
    'if id www-data >/dev/null 2>&1; then chown -R www-data:www-data "$app_root/web/sites/simpletest" "$app_root/web/sites/default/files/simpletest" 2>/dev/null || true; fi',
    'scaffold_valid || fail "Drupal contrib scaffold did not produce composer.json, vendor/bin/drush, web/core, and web/index.php around the extension mount."',
    'touch "$complete_marker"',
  ].join("\n");

/** Escape `${` so recipe compilation keeps the shell text instead of parsing it. */
export const recipeShellLiteral = (command: string): string => command.replaceAll("${", () => "$${");

export const DRUPAL_CONTRIB_SCAFFOLD_COMMAND = drupalContribScaffoldCommand(
  "{{ recipe.drupal }}",
  "{{ recipe.project }}",
  "{{ recipe.type }}",
);

export const DRUPAL_CONTRIB_SCAFFOLD_RECIPE_COMMAND = recipeShellLiteral(DRUPAL_CONTRIB_SCAFFOLD_COMMAND);

export const drupalContribCoreVersionCommand = (type: string, project: string): string =>
  [
    "set -eu",
    `type='${type}'`,
    `project='${project}'`,
    "constraint=$1",
    'test -n "$constraint" || { echo "Usage: lando core-version <constraint>" >&2; exit 1; }',
    "printf '%s' \"$constraint\" | grep -Eq '^[v0-9^~<>=*.,@| a-zA-Z-]+$' || { echo \"Drupal core constraint is invalid.\" >&2; exit 1; }",
    "app_root=/app",
    "if printenv LANDO_DRUPAL_CONTRIB_APP_ROOT >/dev/null 2>&1; then app_root=$(printenv LANDO_DRUPAL_CONTRIB_APP_ROOT); fi",
    'test -f "$app_root/composer.json" || { echo "Site composer.json is missing at $app_root. Run lando drupal-contrib-scaffold first." >&2; exit 1; }',
    `php -r '${phpUpdateCoreConstraint}' "$app_root/composer.json" "$constraint"`,
    'landofile="$app_root/web/${type}s/custom/${project}/.lando.yml"',
    `php -r '${phpUpdateLandofileConstraint}' "$landofile" "$constraint"`,
    'composer --working-dir="$app_root" update --with-dependencies --no-interaction drupal/core-recommended drupal/core-dev',
  ].join("\n");

export const DRUPAL_CONTRIB_CORE_VERSION_COMMAND = drupalContribCoreVersionCommand(
  "{{ recipe.type }}",
  "{{ recipe.project }}",
);

export const DRUPAL_CONTRIB_CORE_VERSION_RECIPE_COMMAND = recipeShellLiteral(
  DRUPAL_CONTRIB_CORE_VERSION_COMMAND,
);
