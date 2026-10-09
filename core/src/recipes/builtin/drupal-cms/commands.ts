/**
 * Readable source for the Drupal CMS tooling commands. They live apart from the
 * renderer so the published snapshot can carry the same text without importing
 * renderer machinery.
 */
/** Upstream drupal/svg_image composer.json at the merge request 65 patch commit, verbatim. */
const SVG_IMAGE_UPSTREAM_METADATA = {
  name: "drupal/svg_image",
  description: "Overrides the standard image formatter and widget to support SVG files.",
  type: "drupal-module",
  license: "GPL-2.0-or-later",
  "minimum-stability": "dev",
  homepage: "https://drupal.org/project/svg_image",
  authors: [
    { name: "Yaroslav Lushnikov", homepage: "https://www.drupal.org/u/imyaro", role: "Maintainer" },
    { name: "See contributors", homepage: "https://www.drupal.org/node/2887125/committers" },
  ],
  support: {
    issues: "https://www.drupal.org/project/issues/svg_image",
    source: "https://git.drupalcode.org/project/svg_image",
  },
  require: { "enshrined/svg-sanitize": "^1.0" },
} as const;
/**
 * Lando-authored root package projection: `version` names the merge request's 3.x
 * development target and `source` pins the exact patch commit. Every other field
 * is the upstream metadata above, so no published release metadata is restated.
 */
const SVG_IMAGE_REPOSITORY = JSON.stringify({
  type: "package",
  package: {
    ...SVG_IMAGE_UPSTREAM_METADATA,
    version: "3.x-dev",
    source: {
      type: "git",
      url: "https://git.drupalcode.org/issue/svg_image-3629505.git",
      reference: "c788b1e2f2be29f62c9812b2b0558472afa61d6d",
    },
  },
});
/** Proves the root pin, the first repository, the lock, and the installed source match the reviewed projection. */
const SVG_IMAGE_VERIFIER = [
  '[$root, $phase, $expected] = array_slice($argv, 1); $expected = json_decode($expected, true, 512, JSON_THROW_ON_ERROR); $package = $expected["package"];',
  '$read = fn($file) => json_decode(file_get_contents($root . "/" . $file), true, 512, JSON_THROW_ON_ERROR);',
  '$reject = function($reason) { fwrite(STDERR, "drupal/svg_image $reason\\n"); exit(1); };',
  '$upstream = $package; unset($upstream["version"], $upstream["source"]);',
  '$reviewed = $upstream; unset($reviewed["minimum-stability"]); $reviewed["license"] = (array) $reviewed["license"];',
  '$forbidden = array_flip(["autoload", "autoload-dev", "extra", "bin", "scripts", "include-path", "target-dir", "replace", "provide", "conflict", "dist"]);',
  '$root_json = $read("composer.json");',
  'if (($root_json["require"]["drupal/svg_image"] ?? null) !== "3.x-dev" || ($root_json["require"]["enshrined/svg-sanitize"] ?? null) !== "^1.0") $reject("root requirement changed");',
  '$repositories = $root_json["repositories"] ?? []; $repository_key = array_key_first($repositories); $repository = $repository_key === null ? [] : $repositories[$repository_key];',
  'if (($repository["name"] ?? $repository_key) !== "lando-svg-image") $reject("repository is not first"); unset($repository["name"]);',
  'if ($repository != $expected) $reject("repository projection changed");',
  '$lock = $read("composer.lock"); $locked = array_values(array_filter(array_merge($lock["packages"] ?? [], $lock["packages-dev"] ?? []), fn($entry) => ($entry["name"] ?? null) === "drupal/svg_image"));',
  'if (count($locked) !== 1) $reject("lock entry is missing"); $entry = $locked[0]; $entry["license"] = (array) ($entry["license"] ?? []);',
  'if (($entry["version"] ?? null) !== "3.x-dev" || ($entry["source"] ?? null) != $package["source"] || array_intersect_key($entry, $forbidden) !== []) $reject("lock source changed");',
  'foreach ($reviewed as $key => $value) if (($entry[$key] ?? null) != $value) $reject("lock metadata changed: $key");',
  'if (array_filter($lock["aliases"] ?? [], fn($alias) => ($alias["package"] ?? null) === "drupal/svg_image") !== []) $reject("lock alias present");',
  'if ($phase === "locked") exit(0);',
  'if ($read("web/modules/contrib/svg_image/composer.json") != $upstream) $reject("installed metadata changed");',
  '$records = array_values(array_filter($read("vendor/composer/installed.json")["packages"] ?? [], fn($record) => ($record["name"] ?? null) === "drupal/svg_image"));',
  'if (count($records) !== 1 || ($records[0]["source"] ?? null) != $package["source"] || ($records[0]["installation-source"] ?? null) !== "source") $reject("installed source changed");',
].join(" ");

/** Composer installs the pinned drupal/svg_image patch from its git source, so the appserver image needs Git. */
export const DRUPAL_CMS_GIT_ARTIFACT = {
  run: "apt-get update && apt-get install -y --no-install-recommends git",
  user: "root",
} as const;

export const DRUPAL_CMS_SCAFFOLD_COMMAND = [
  "set -eu",
  "app_root=/app",
  "if printenv LANDO_DRUPAL_CMS_APP_ROOT >/dev/null 2>&1; then app_root=$(printenv LANDO_DRUPAL_CMS_APP_ROOT); fi",
  'staging_parent=$(printenv TMPDIR 2>/dev/null || true); if test -z "$staging_parent"; then staging_parent=/tmp; fi',
  "if printenv LANDO_DRUPAL_CMS_STAGING_ROOT >/dev/null 2>&1; then staging_parent=$(printenv LANDO_DRUPAL_CMS_STAGING_ROOT); fi",
  'complete_marker="$app_root/.lando-drupal-cms-scaffold-complete"',
  'manifest="$app_root/.lando-drupal-cms-scaffold-manifest"',
  'lock_dir="$app_root/.lando-drupal-cms-scaffold-lock"',
  "lock_owned=0",
  "staging_root=",
  'cleanup() { if test -n "$staging_root"; then rm -rf "$staging_root"; fi; if test "$lock_owned" -eq 1; then rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true; fi; }',
  "trap cleanup EXIT",
  "trap 'exit 1' HUP INT TERM",
  'fail() { echo "$1" >&2; exit 1; }',
  'promote_no_replace() { source=$1; destination=$2; mv -T -n "$source" "$destination" || true; if test -e "$source" || test -L "$source"; then fail "Drupal CMS scaffold found an ambiguous target during promotion: $destination"; fi; if ! test -e "$destination" && ! test -L "$destination"; then fail "Drupal CMS scaffold promotion did not create its target: $destination"; fi; }',
  'valid_name() { case "$1" in ""|"."|".."|*[!A-Za-z0-9._-]*) return 1;; *) return 0;; esac; }',
  'empty_dir() { test -d "$1" && ! test -L "$1" && test -r "$1" && test -x "$1" || return 1; for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do if test -e "$child" || test -L "$child"; then return 1; fi; done; return 0; }',
  'write_state() { next_state=$1; wanted=$2; state_tmp="$manifest.tmp.$$"; while IFS=: read -r current_state current_entry; do if test "$current_entry" = "$wanted"; then printf "%s:%s\n" "$next_state" "$current_entry"; else printf "%s:%s\n" "$current_state" "$current_entry"; fi; done < "$manifest" > "$state_tmp"; mv "$state_tmp" "$manifest"; }',
  'promote_nested() { promoted_entry=$1; promoted_target=$2; promoted_partial=$3; test -d "$promoted_partial" && ! test -L "$promoted_partial" || fail "Drupal CMS scaffold nested partial path is unavailable: $promoted_partial"; for child in "$promoted_partial"/* "$promoted_partial"/.[!.]* "$promoted_partial"/..?*; do if ! test -e "$child" && ! test -L "$child"; then continue; fi; child_name=$(basename -- "$child"); if test "$child_name" = .lando-owned; then continue; fi; destination="$promoted_target/$child_name"; if test -e "$destination" || test -L "$destination"; then fail "Drupal CMS scaffold cannot overwrite ambiguous recovery path: $destination"; fi; promote_no_replace "$child" "$destination"; done; write_state nested-complete "$promoted_entry"; test -f "$promoted_partial/.lando-owned" && test "$(cat "$promoted_partial/.lando-owned")" = v1 || fail "Drupal CMS scaffold nested partial ownership is invalid: $promoted_partial"; rm -f "$promoted_partial/.lando-owned"; rmdir "$promoted_partial" || fail "Drupal CMS scaffold nested partial path is not empty: $promoted_partial"; write_state complete "$promoted_entry"; }',
  'scaffold_valid() { test -f "$app_root/composer.json" && test -x "$app_root/vendor/bin/drush" && test -d "$app_root/web"; }',
  'mkdir -p "$app_root"',
  'if ! mkdir "$lock_dir" 2>/dev/null; then lock_pid=; if test -f "$lock_dir/pid"; then IFS= read -r lock_pid < "$lock_dir/pid" || lock_pid=; fi; case "$lock_pid" in ""|*[!0-9]*) fail "Drupal CMS scaffold lock at $lock_dir has no recoverable owner.";; esac; if kill -0 "$lock_pid" 2>/dev/null; then fail "Drupal CMS scaffold is already running for $app_root."; fi; rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || fail "Drupal CMS scaffold lock at $lock_dir is not safely recoverable."; mkdir "$lock_dir" 2>/dev/null || fail "Unable to acquire Drupal CMS scaffold lock for $app_root."; fi',
  'lock_owned=1; printf "%s\n" "$$" > "$lock_dir/pid"',
  'if test -e "$complete_marker" && scaffold_valid; then fail "Drupal CMS is already scaffolded at $app_root."; fi',
  'repair=0; if test -e "$complete_marker"; then repair=1; fi',
  'if test -f "$manifest"; then while IFS=: read -r state entry; do valid_name "$entry" || fail "Invalid Drupal CMS scaffold recovery path: $entry"; case "$state" in incomplete|ready|complete|preexisting|sibling-incomplete|sibling-ready|nested-incomplete|nested-ready|nested-complete) ;; *) fail "Invalid Drupal CMS scaffold manifest state: $state";; esac; target="$app_root/$entry"; partial="$target.lando-partial"; nested_partial="$target/.lando-partial"; case "$state" in incomplete) if test -e "$partial" || test -L "$partial"; then fail "Drupal CMS scaffold found an ambiguous legacy partial path: $partial"; fi; if test -e "$target" || test -L "$target"; then empty_dir "$target" || fail "Drupal CMS scaffold found ambiguous contents after an interrupted legacy copy: $target"; fi;; ready) fail "Drupal CMS scaffold found an ambiguous legacy ready state: $entry";; sibling-ready|sibling-incomplete) owner="$partial.lando-owner"; test -d "$owner" && ! test -L "$owner" && test -f "$owner/version" && test "$(cat "$owner/version")" = v1 || fail "Drupal CMS scaffold sibling partial ownership is invalid: $partial"; if test -e "$target" || test -L "$target"; then if test "$state" = sibling-ready && ! test -e "$partial" && ! test -L "$partial"; then rm -rf "$owner"; else fail "Drupal CMS scaffold found an ambiguous target after an interrupted copy: $target"; fi; elif test -e "$partial" || test -L "$partial"; then rm -rf "$partial"; rm -rf "$owner"; else rm -rf "$owner"; fi;; complete) owner="$partial.lando-owner"; if test -e "$owner" || test -L "$owner"; then test -d "$owner" && ! test -L "$owner" && test -f "$owner/version" && test "$(cat "$owner/version")" = v1 || fail "Drupal CMS scaffold sibling partial ownership is invalid: $partial"; rm -rf "$owner"; fi;; nested-incomplete) test -d "$nested_partial" && ! test -L "$nested_partial" && test -f "$nested_partial/.lando-owned" && test "$(cat "$nested_partial/.lando-owned")" = v1 || fail "Drupal CMS scaffold nested partial ownership is invalid: $nested_partial"; rm -rf "$nested_partial"; empty_dir "$target" || fail "Drupal CMS scaffold found ambiguous contents after an interrupted copy: $target";; nested-ready) test -f "$nested_partial/.lando-owned" && test "$(cat "$nested_partial/.lando-owned")" = v1 || fail "Drupal CMS scaffold nested partial ownership is invalid: $nested_partial"; promote_nested "$entry" "$target" "$nested_partial";; nested-complete) if test -L "$nested_partial" || { test -e "$nested_partial" && ! test -d "$nested_partial"; }; then fail "Drupal CMS scaffold nested partial path is not safely recoverable: $nested_partial"; fi; if test -d "$nested_partial"; then if test -e "$nested_partial/.lando-owned" || test -L "$nested_partial/.lando-owned"; then test -f "$nested_partial/.lando-owned" && ! test -L "$nested_partial/.lando-owned" && test "$(cat "$nested_partial/.lando-owned")" = v1 || fail "Drupal CMS scaffold nested partial ownership is invalid: $nested_partial"; rm -f "$nested_partial/.lando-owned"; fi; rmdir "$nested_partial" 2>/dev/null || fail "Drupal CMS scaffold nested partial path is not safely recoverable: $nested_partial"; fi; esac; done < "$manifest"; rm -f "$manifest"; fi',
  'mkdir -p "$staging_parent"',
  'app_key=$(basename "$app_root" | tr -c "A-Za-z0-9._-" "_")',
  'staging_root=$(mktemp -d "$staging_parent/lando-drupal-cms-$app_key.XXXXXX") || fail "Unable to create a Drupal CMS scaffold staging directory."',
  "composer create-project 'drupal/cms' \"$staging_root\" --no-install --no-scripts --no-interaction",
  `svg_repository='${SVG_IMAGE_REPOSITORY}'`,
  'composer --working-dir="$staging_root" config repositories.lando-svg-image --json "$svg_repository"',
  "composer --working-dir=\"$staging_root\" require --no-update 'drupal/svg_image:3.x-dev' 'enshrined/svg-sanitize:^1.0'",
  `svg_verifier='${SVG_IMAGE_VERIFIER}'`,
  'verify_svg_image() { php -r "$svg_verifier" "$staging_root" "$1" "$svg_repository" || fail "Drupal CMS scaffold rejected the pinned drupal/svg_image security patch."; }',
  'composer --working-dir="$staging_root" update --no-install --no-scripts --no-plugins --no-interaction',
  "verify_svg_image locked",
  'composer --working-dir="$staging_root" audit --locked --no-interaction',
  'composer --working-dir="$staging_root" install --no-interaction',
  'svg_dir="$staging_root/web/modules/contrib/svg_image"',
  'verify_svg_checkout() { verify_svg_image installed; test "$(git -C "$svg_dir" rev-parse HEAD)" = c788b1e2f2be29f62c9812b2b0558472afa61d6d && test -z "$(git -C "$svg_dir" status --porcelain)" || fail "Drupal CMS scaffold installed an unexpected drupal/svg_image checkout."; }',
  "verify_svg_checkout",
  'composer --working-dir="$staging_root" run-script post-update-cmd --no-interaction',
  'composer --working-dir="$staging_root" run-script post-create-project-cmd --no-interaction',
  "verify_svg_checkout",
  'composer --working-dir="$staging_root" audit --locked --no-interaction',
  'test -f "$staging_root/composer.lock"',
  'test -f "$staging_root/composer.json"',
  'test -x "$staging_root/vendor/bin/drush"',
  'test -d "$staging_root/web"',
  'touch "$staging_root/.lando-drupal-cms-stage-complete"',
  'manifest_tmp="$manifest.tmp.$$"',
  '(cd "$staging_root"; for entry in * .[!.]* ..?*; do if ! test -e "$entry" && ! test -L "$entry"; then continue; fi; test "$entry" = .lando-drupal-cms-stage-complete && continue; valid_name "$entry" || fail "Invalid Drupal CMS scaffold entry: $entry"; target="$app_root/$entry"; state=incomplete; if test -e "$target" || test -L "$target"; then if ! { empty_dir "$target"; }; then state=preexisting; fi; fi; printf "%s:%s\n" "$state" "$entry"; done) > "$manifest_tmp"',
  'mv "$manifest_tmp" "$manifest"',
  'if test "$repair" -eq 1; then rm -f "$complete_marker"; fi',
  'while IFS=: read -r state entry; do test "$state" = incomplete || continue; target="$app_root/$entry"; partial="$target.lando-partial"; if test -e "$target" || test -L "$target"; then if empty_dir "$target"; then nested_partial="$target/.lando-partial"; mkdir "$nested_partial"; printf "v1\n" > "$nested_partial/.lando-owned"; write_state nested-incomplete "$entry"; cp -R "$staging_root/$entry/." "$nested_partial/"; write_state nested-ready "$entry"; promote_nested "$entry" "$target" "$nested_partial"; continue; fi; fail "Drupal CMS scaffold found an ambiguous target after manifest snapshot: $target"; fi; if test -e "$partial" || test -L "$partial"; then fail "Drupal CMS scaffold partial path already exists: $partial"; fi; owner="$partial.lando-owner"; mkdir "$owner"; printf "v1\n" > "$owner/version"; write_state sibling-incomplete "$entry"; cp -R "$staging_root/$entry" "$partial"; write_state sibling-ready "$entry"; promote_no_replace "$partial" "$target"; write_state complete "$entry"; rm -rf "$owner"; done < "$manifest"',
  'scaffold_valid || fail "Drupal CMS scaffold did not produce composer.json, vendor/bin/drush, and web/."',
  'touch "$complete_marker"',
  'rm -f "$manifest"',
].join("\n");

export const drupalCmsInstallCommand = (driver: "mysql" | "pgsql", appName: string): string => {
  const password =
    driver === "pgsql" ? `$(printf '%s' '${appName}' | sha256sum | cut -c1-16 | sed 's/^/lando-/')` : "lando";
  return [
    "mkdir -p web/sites/default/files",
    `vendor/bin/drush site:install recipes/drupal_cms_starter --db-url="${driver}://lando:${password}@database/${appName}" -y`,
    'vendor/bin/drush php:eval \'if (!\\Drupal::service("file.htaccess_writer")->write("public://", FALSE)) { throw new \\RuntimeException("Could not protect the Drupal public files directory."); }\'',
  ].join(" && ");
};
