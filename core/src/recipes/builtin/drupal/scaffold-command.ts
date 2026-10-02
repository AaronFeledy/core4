/**
 * Readable source for the Drupal scaffold tooling command. It lives apart from
 * the renderer so the published snapshot can carry the same text without
 * importing renderer machinery.
 */
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
    'promote_no_replace() { source=$1; destination=$2; mv -T -n "$source" "$destination" || true; if test -e "$source" || test -L "$source"; then fail "Drupal scaffold found an ambiguous target during promotion: $destination"; fi; if ! test -e "$destination" && ! test -L "$destination"; then fail "Drupal scaffold promotion did not create its target: $destination"; fi; }',
    'write_state() { next_state=$1; wanted=$2; state_tmp="$manifest.tmp.$$"; while IFS=: read -r current_state current_entry; do if test "$current_entry" = "$wanted"; then printf "%s:%s\n" "$next_state" "$current_entry"; else printf "%s:%s\n" "$current_state" "$current_entry"; fi; done < "$manifest" > "$state_tmp"; mv "$state_tmp" "$manifest"; }',
    'promote_nested() { promoted_entry=$1; promoted_target=$2; promoted_partial=$3; test -d "$promoted_partial" && ! test -L "$promoted_partial" || fail "Drupal scaffold nested partial path is unavailable: $promoted_partial"; for child in "$promoted_partial"/* "$promoted_partial"/.[!.]* "$promoted_partial"/..?*; do if ! test -e "$child" && ! test -L "$child"; then continue; fi; child_name=$(basename -- "$child"); if test "$child_name" = .lando-owned; then continue; fi; destination="$promoted_target/$child_name"; if test -e "$destination" || test -L "$destination"; then fail "Drupal scaffold cannot overwrite ambiguous recovery path: $destination"; fi; promote_no_replace "$child" "$destination"; done; write_state nested-complete "$promoted_entry"; test -f "$promoted_partial/.lando-owned" && test "$(cat "$promoted_partial/.lando-owned")" = v1 || fail "Drupal scaffold nested partial ownership is invalid: $promoted_partial"; rm -f "$promoted_partial/.lando-owned"; rmdir "$promoted_partial" || fail "Drupal scaffold nested partial path is not empty: $promoted_partial"; write_state complete "$promoted_entry"; }',
    'valid_name() { case "$1" in ""|"."|".."|*[!A-Za-z0-9._-]*) return 1;; *) return 0;; esac; }',
    'empty_dir() { test -d "$1" && ! test -L "$1" && test -r "$1" && test -x "$1" || return 1; for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do if test -e "$child" || test -L "$child"; then return 1; fi; done; return 0; }',
    'scaffold_valid() { test -f "$app_root/composer.json" && test -x "$app_root/vendor/bin/drush" && test -d "$app_root/web"; }',
    'mkdir -p "$app_root"',
    'if ! mkdir "$lock_dir" 2>/dev/null; then lock_pid=; if test -f "$lock_dir/pid"; then IFS= read -r lock_pid < "$lock_dir/pid" || lock_pid=; fi; case "$lock_pid" in ""|*[!0-9]*) fail "Drupal scaffold lock at $lock_dir has no recoverable owner.";; esac; if kill -0 "$lock_pid" 2>/dev/null; then fail "Drupal scaffold is already running for $app_root."; fi; rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || fail "Drupal scaffold lock at $lock_dir is not safely recoverable."; mkdir "$lock_dir" 2>/dev/null || fail "Unable to acquire Drupal scaffold lock for $app_root."; fi',
    'lock_owned=1; printf "%s\n" "$$" > "$lock_dir/pid"',
    'if test -e "$complete_marker" && scaffold_valid; then fail "Drupal is already scaffolded at $app_root."; fi',
    'repair=0; if test -e "$complete_marker"; then repair=1; fi',
    'if test -f "$manifest"; then while IFS=: read -r state entry; do valid_name "$entry" || fail "Invalid Drupal scaffold recovery path: $entry"; case "$state" in incomplete|ready|complete|preexisting|sibling-incomplete|sibling-ready|nested-incomplete|nested-ready|nested-complete) ;; *) fail "Invalid Drupal scaffold manifest state: $state";; esac; target="$app_root/$entry"; partial="$target.lando-partial"; nested_partial="$target/.lando-partial"; case "$state" in incomplete) if test -e "$partial" || test -L "$partial"; then fail "Drupal scaffold found an ambiguous legacy partial path: $partial"; fi; if test -e "$target" || test -L "$target"; then empty_dir "$target" || fail "Drupal scaffold found ambiguous contents after an interrupted legacy copy: $target"; fi;; ready) fail "Drupal scaffold found an ambiguous legacy ready state: $entry";; sibling-ready|sibling-incomplete) owner="$partial.lando-owner"; test -d "$owner" && ! test -L "$owner" && test -f "$owner/version" && test "$(cat "$owner/version")" = v1 || fail "Drupal scaffold sibling partial ownership is invalid: $partial"; if test -e "$target" || test -L "$target"; then if test "$state" = sibling-ready && ! test -e "$partial" && ! test -L "$partial"; then rm -rf "$owner"; else fail "Drupal scaffold found an ambiguous target after an interrupted copy: $target"; fi; elif test -e "$partial" || test -L "$partial"; then rm -rf "$partial"; rm -rf "$owner"; else rm -rf "$owner"; fi;; complete) owner="$partial.lando-owner"; if test -e "$owner" || test -L "$owner"; then test -d "$owner" && ! test -L "$owner" && test -f "$owner/version" && test "$(cat "$owner/version")" = v1 || fail "Drupal scaffold sibling partial ownership is invalid: $partial"; rm -rf "$owner"; fi;; nested-incomplete) test -d "$nested_partial" && ! test -L "$nested_partial" && test -f "$nested_partial/.lando-owned" && test "$(cat "$nested_partial/.lando-owned")" = v1 || fail "Drupal scaffold nested partial ownership is invalid: $nested_partial"; rm -rf "$nested_partial"; empty_dir "$target" || fail "Drupal scaffold found ambiguous contents after an interrupted copy: $target";; nested-ready) test -f "$nested_partial/.lando-owned" && test "$(cat "$nested_partial/.lando-owned")" = v1 || fail "Drupal scaffold nested partial ownership is invalid: $nested_partial"; promote_nested "$entry" "$target" "$nested_partial";; nested-complete) if test -L "$nested_partial" || { test -e "$nested_partial" && ! test -d "$nested_partial"; }; then fail "Drupal scaffold nested partial path is not safely recoverable: $nested_partial"; fi; if test -d "$nested_partial"; then if test -e "$nested_partial/.lando-owned" || test -L "$nested_partial/.lando-owned"; then test -f "$nested_partial/.lando-owned" && ! test -L "$nested_partial/.lando-owned" && test "$(cat "$nested_partial/.lando-owned")" = v1 || fail "Drupal scaffold nested partial ownership is invalid: $nested_partial"; rm -f "$nested_partial/.lando-owned"; fi; rmdir "$nested_partial" 2>/dev/null || fail "Drupal scaffold nested partial path is not safely recoverable: $nested_partial"; fi; esac; done < "$manifest"; rm -f "$manifest"; fi',
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
    '(cd "$staging_root"; for entry in * .[!.]* ..?*; do if ! test -e "$entry" && ! test -L "$entry"; then continue; fi; test "$entry" = .lando-drupal-stage-complete && continue; valid_name "$entry" || fail "Invalid Drupal scaffold entry: $entry"; target="$app_root/$entry"; state=incomplete; if test -e "$target" || test -L "$target"; then if ! { empty_dir "$target"; }; then state=preexisting; fi; fi; printf "%s:%s\n" "$state" "$entry"; done) > "$manifest_tmp"',
    'mv "$manifest_tmp" "$manifest"',
    'if test "$repair" -eq 1; then rm -f "$complete_marker"; fi',
    'while IFS=: read -r state entry; do test "$state" = incomplete || continue; target="$app_root/$entry"; partial="$target.lando-partial"; if test -e "$target" || test -L "$target"; then if empty_dir "$target"; then nested_partial="$target/.lando-partial"; mkdir "$nested_partial"; printf "v1\n" > "$nested_partial/.lando-owned"; write_state nested-incomplete "$entry"; cp -R "$staging_root/$entry/." "$nested_partial/"; write_state nested-ready "$entry"; promote_nested "$entry" "$target" "$nested_partial"; continue; fi; fail "Drupal scaffold found an ambiguous target after manifest snapshot: $target"; fi; if test -e "$partial" || test -L "$partial"; then fail "Drupal scaffold partial path already exists: $partial"; fi; owner="$partial.lando-owner"; mkdir "$owner"; printf "v1\n" > "$owner/version"; write_state sibling-incomplete "$entry"; cp -R "$staging_root/$entry" "$partial"; write_state sibling-ready "$entry"; promote_no_replace "$partial" "$target"; write_state complete "$entry"; rm -rf "$owner"; done < "$manifest"',
    'scaffold_valid || fail "Drupal scaffold did not produce composer.json, vendor/bin/drush, and web/."',
    'touch "$complete_marker"',
    'rm -f "$manifest"',
  ].join("\n");

export const DRUPAL_SCAFFOLD_COMMAND = drupalScaffoldCommand("11");
