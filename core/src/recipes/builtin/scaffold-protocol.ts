/**
 * Pure string factory for the staged scaffold protocol shared by
 * `drupal-scaffold`, `drupal-cms-scaffold`, and `create-project`. It lives
 * apart from the renderer so the published snapshot can carry the same text
 * without importing renderer machinery.
 *
 * The protocol never overwrites a path that already exists. It stages a
 * complete project under a temporary directory, records one durable manifest
 * entry per top-level path, and promotes each entry atomically into the app
 * root. An empty directory at a target (a mounted `vendor`, `node_modules`, or
 * working-directory shadow) is filled in place through a nested partial, a
 * non-empty path is left untouched, and an interrupted promotion resumes from
 * the manifest on the next run. Recovery normalizes the manifest but keeps it
 * until a replacement manifest is published, so a later staging failure never
 * leaves promoted files without their evidence.
 */

export interface ScaffoldProtocolOptions {
  /** Human-readable name used in every failure message. */
  readonly label: string;
  /** Marker and manifest namespace, e.g. `.lando-drupal-scaffold`; all scaffolds share one app-root lock. */
  readonly markerPrefix: string;
  /** Keep a completion marker for refusal and repair on later runs (default true). */
  readonly keepCompletionMarker?: boolean;
  /** Marked file inside the staging directory that promotion ignores. */
  readonly stagingMarker: string;
  /** Env var overriding the container app root. */
  readonly appRootEnv: string;
  /** Env var overriding the staging parent directory. */
  readonly stagingRootEnv: string;
  /** App root used when the env override is absent. */
  readonly defaultAppRoot: string;
  /**
   * Env var that supplies the app root when the explicit override is absent,
   * used by a recipe whose app mount has an authored target.
   */
  readonly defaultAppRootEnv?: string;
  /** Mktemp stem for the staging directory, e.g. `lando-drupal-`. */
  readonly stagingPrefix: string;
  /** Message emitted when the completion marker and its outputs are present. */
  readonly completeMessage: string;
  /** What a completed app root contains, named in the final validation message. */
  readonly outputs: string;
  /** Predicate lines over `$app_root` that prove the app root is complete. */
  readonly complete: readonly string[];
  /** Lines run before the app root is touched, for argument parsing. */
  readonly prepare?: readonly string[];
  /** Lines run under the lock before recovery, for refusal rules. */
  readonly preflight?: readonly string[];
  /** Lines that fill `$staging_root` with the complete project. */
  readonly generate: readonly string[];
  /** Lines that run in `$app_root` after promotion, before the completion marker. */
  readonly afterPromote?: readonly string[];
}

export const scaffoldProtocol = (options: ScaffoldProtocolOptions): string => {
  const { label, markerPrefix, stagingMarker } = options;
  return [
    "set -eu",
    `app_root=${options.defaultAppRoot}`,
    ...(options.defaultAppRootEnv === undefined
      ? []
      : [
          `lando_default_app_root=$(printenv ${options.defaultAppRootEnv} 2>/dev/null || true); if test -n "$lando_default_app_root"; then app_root=$lando_default_app_root; fi`,
        ]),
    `if printenv ${options.appRootEnv} >/dev/null 2>&1; then app_root=$(printenv ${options.appRootEnv}); fi`,
    'staging_parent=$(printenv TMPDIR 2>/dev/null || true); if test -z "$staging_parent"; then staging_parent=/tmp; fi',
    `if printenv ${options.stagingRootEnv} >/dev/null 2>&1; then staging_parent=$(printenv ${options.stagingRootEnv}); fi`,
    `complete_marker="$app_root/${markerPrefix}-complete"`,
    `manifest="$app_root/${markerPrefix}-manifest"`,
    'lock_dir="$app_root/.lando-scaffold-lock"',
    "lock_owned=0",
    "staging_root=",
    'cleanup() { if test -n "$staging_root"; then rm -rf "$staging_root"; fi; if test "$lock_owned" -eq 1; then rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true; fi; }',
    "trap cleanup EXIT",
    "trap 'exit 1' HUP INT TERM",
    'fail() { echo "$1" >&2; exit 1; }',
    `promote_no_replace() { source=$1; destination=$2; mv -T -n "$source" "$destination" || true; if test -e "$source" || test -L "$source"; then fail "${label} scaffold found an ambiguous target during promotion: $destination"; fi; if ! test -e "$destination" && ! test -L "$destination"; then fail "${label} scaffold promotion did not create its target: $destination"; fi; }`,
    'write_state() { next_state=$1; wanted=$2; state_tmp="$manifest.tmp.$$"; while IFS=: read -r current_state current_entry; do if test "$current_entry" = "$wanted"; then printf "%s:%s\n" "$next_state" "$current_entry"; else printf "%s:%s\n" "$current_state" "$current_entry"; fi; done < "$manifest" > "$state_tmp"; mv "$state_tmp" "$manifest"; }',
    `promote_nested() { promoted_entry=$1; promoted_target=$2; promoted_partial=$3; test -d "$promoted_partial" && ! test -L "$promoted_partial" || fail "${label} scaffold nested partial path is unavailable: $promoted_partial"; for child in "$promoted_partial"/* "$promoted_partial"/.[!.]* "$promoted_partial"/..?*; do if ! test -e "$child" && ! test -L "$child"; then continue; fi; child_name=$(basename -- "$child"); if test "$child_name" = .lando-owned; then continue; fi; destination="$promoted_target/$child_name"; if test -e "$destination" || test -L "$destination"; then fail "${label} scaffold cannot overwrite ambiguous recovery path: $destination"; fi; promote_no_replace "$child" "$destination"; done; write_state nested-complete "$promoted_entry"; test -f "$promoted_partial/.lando-owned" && test "$(cat "$promoted_partial/.lando-owned")" = v1 || fail "${label} scaffold nested partial ownership is invalid: $promoted_partial"; rm -f "$promoted_partial/.lando-owned"; rmdir "$promoted_partial" || fail "${label} scaffold nested partial path is not empty: $promoted_partial"; write_state complete "$promoted_entry"; }`,
    'valid_name() { case "$1" in ""|"."|".."|*[!A-Za-z0-9._-]*) return 1;; *) return 0;; esac; }',
    'empty_dir() { test -d "$1" && ! test -L "$1" && test -r "$1" && test -x "$1" || return 1; for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do if test -e "$child" || test -L "$child"; then return 1; fi; done; return 0; }',
    `scaffold_valid() { ${options.complete.join(" && ")}; }`,
    ...(options.prepare ?? []),
    'mkdir -p "$app_root"',
    `if ! mkdir "$lock_dir" 2>/dev/null; then lock_pid=; if test -f "$lock_dir/pid"; then IFS= read -r lock_pid < "$lock_dir/pid" || lock_pid=; fi; case "$lock_pid" in ""|*[!0-9]*) fail "${label} scaffold lock at $lock_dir has no recoverable owner.";; esac; if kill -0 "$lock_pid" 2>/dev/null; then fail "Another Lando scaffold is already running for $app_root."; fi; rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || fail "${label} scaffold lock at $lock_dir is not safely recoverable."; mkdir "$lock_dir" 2>/dev/null || fail "Unable to acquire ${label} scaffold lock for $app_root."; fi`,
    'lock_owned=1; printf "%s\n" "$$" > "$lock_dir/pid"',
    ...(options.keepCompletionMarker === false
      ? []
      : [`if test -e "$complete_marker" && scaffold_valid; then fail "${options.completeMessage}"; fi`]),
    ...(options.preflight ?? []),
    'repair=0; if test -e "$complete_marker"; then repair=1; fi',
    `if test -f "$manifest"; then while IFS=: read -r state entry; do valid_name "$entry" || fail "Invalid ${label} scaffold recovery path: $entry"; case "$state" in incomplete|ready|complete|preexisting|sibling-incomplete|sibling-ready|nested-incomplete|nested-ready|nested-complete) ;; *) fail "Invalid ${label} scaffold manifest state: $state";; esac; target="$app_root/$entry"; partial="$target.lando-partial"; nested_partial="$target/.lando-partial"; case "$state" in incomplete) if test -e "$partial" || test -L "$partial"; then fail "${label} scaffold found an ambiguous legacy partial path: $partial"; fi; if test -e "$target" || test -L "$target"; then empty_dir "$target" || fail "${label} scaffold found ambiguous contents after an interrupted legacy copy: $target"; fi;; ready) fail "${label} scaffold found an ambiguous legacy ready state: $entry";; sibling-ready|sibling-incomplete) owner="$partial.lando-owner"; test -d "$owner" && ! test -L "$owner" && test -f "$owner/version" && test "$(cat "$owner/version")" = v1 || fail "${label} scaffold sibling partial ownership is invalid: $partial"; if test -e "$target" || test -L "$target"; then if test "$state" = sibling-ready && ! test -e "$partial" && ! test -L "$partial"; then rm -rf "$owner"; write_state complete "$entry"; else fail "${label} scaffold found an ambiguous target after an interrupted copy: $target"; fi; elif test -e "$partial" || test -L "$partial"; then rm -rf "$partial"; rm -rf "$owner"; write_state incomplete "$entry"; else rm -rf "$owner"; write_state incomplete "$entry"; fi;; complete) owner="$partial.lando-owner"; if test -e "$owner" || test -L "$owner"; then test -d "$owner" && ! test -L "$owner" && test -f "$owner/version" && test "$(cat "$owner/version")" = v1 || fail "${label} scaffold sibling partial ownership is invalid: $partial"; rm -rf "$owner"; fi;; nested-incomplete) test -d "$nested_partial" && ! test -L "$nested_partial" && test -f "$nested_partial/.lando-owned" && test "$(cat "$nested_partial/.lando-owned")" = v1 || fail "${label} scaffold nested partial ownership is invalid: $nested_partial"; rm -rf "$nested_partial"; empty_dir "$target" || fail "${label} scaffold found ambiguous contents after an interrupted copy: $target"; write_state incomplete "$entry";; nested-ready) test -f "$nested_partial/.lando-owned" && test "$(cat "$nested_partial/.lando-owned")" = v1 || fail "${label} scaffold nested partial ownership is invalid: $nested_partial"; promote_nested "$entry" "$target" "$nested_partial";; nested-complete) if test -L "$nested_partial" || { test -e "$nested_partial" && ! test -d "$nested_partial"; }; then fail "${label} scaffold nested partial path is not safely recoverable: $nested_partial"; fi; if test -d "$nested_partial"; then if test -e "$nested_partial/.lando-owned" || test -L "$nested_partial/.lando-owned"; then test -f "$nested_partial/.lando-owned" && ! test -L "$nested_partial/.lando-owned" && test "$(cat "$nested_partial/.lando-owned")" = v1 || fail "${label} scaffold nested partial ownership is invalid: $nested_partial"; rm -f "$nested_partial/.lando-owned"; fi; rmdir "$nested_partial" 2>/dev/null || fail "${label} scaffold nested partial path is not safely recoverable: $nested_partial"; fi; esac; done < "$manifest"; fi`,
    'mkdir -p "$staging_parent"',
    'app_key=$(basename "$app_root" | tr -c "A-Za-z0-9._-" "_")',
    `staging_root=$(mktemp -d "$staging_parent/${options.stagingPrefix}$app_key.XXXXXX") || fail "Unable to create a ${label} scaffold staging directory."`,
    ...options.generate,
    `touch "$staging_root/${stagingMarker}"`,
    'manifest_tmp="$manifest.tmp.$$"',
    `(cd "$staging_root"; for entry in * .[!.]* ..?*; do if ! test -e "$entry" && ! test -L "$entry"; then continue; fi; test "$entry" = ${stagingMarker} && continue; valid_name "$entry" || fail "Invalid ${label} scaffold entry: $entry"; target="$app_root/$entry"; state=incomplete; if test -e "$target" || test -L "$target"; then if ! { empty_dir "$target"; }; then state=preexisting; fi; fi; printf "%s:%s\n" "$state" "$entry"; done) > "$manifest_tmp"`,
    'mv "$manifest_tmp" "$manifest"',
    'if test "$repair" -eq 1; then rm -f "$complete_marker"; fi',
    `while IFS=: read -r state entry; do test "$state" = incomplete || continue; target="$app_root/$entry"; partial="$target.lando-partial"; if test -e "$target" || test -L "$target"; then if empty_dir "$target"; then nested_partial="$target/.lando-partial"; mkdir "$nested_partial"; printf "v1\n" > "$nested_partial/.lando-owned"; write_state nested-incomplete "$entry"; cp -R "$staging_root/$entry/." "$nested_partial/"; write_state nested-ready "$entry"; promote_nested "$entry" "$target" "$nested_partial"; continue; fi; fail "${label} scaffold found an ambiguous target after manifest snapshot: $target"; fi; if test -e "$partial" || test -L "$partial"; then fail "${label} scaffold partial path already exists: $partial"; fi; owner="$partial.lando-owner"; mkdir "$owner"; printf "v1\n" > "$owner/version"; write_state sibling-incomplete "$entry"; cp -R "$staging_root/$entry" "$partial"; write_state sibling-ready "$entry"; promote_no_replace "$partial" "$target"; write_state complete "$entry"; rm -rf "$owner"; done < "$manifest"`,
    `scaffold_valid || fail "${label} scaffold did not produce ${options.outputs}."`,
    ...(options.afterPromote ?? []),
    ...(options.keepCompletionMarker === false ? [] : ['touch "$complete_marker"']),
    'rm -f "$manifest"',
  ].join("\n");
};
