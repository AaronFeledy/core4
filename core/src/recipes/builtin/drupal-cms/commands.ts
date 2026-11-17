/** Composer installs the pinned drupal/svg_image patch from its git source, so the appserver image needs Git. */
export const DRUPAL_CMS_GIT_ARTIFACT = {
  run: "apt-get update && apt-get install -y --no-install-recommends git",
  user: "root",
} as const;

/** Repair only Drupal public:// after root-run install on Windows Unix-owned app mounts.
 * Landofile authoring parses shell brace expansions as expressions, so use bare $VAR. */
const windowsPublicFilesOwnership = [
  'if test "$LANDO_HOST_OS" = win32; then',
  "  for lando_path in web web/sites web/sites/default web/sites/default/files; do",
  '    test ! -L "$lando_path" || { echo "Drupal public files path must not contain a symlink: $lando_path" >&2; exit 1; }',
  "  done",
  "  lando_root=$(pwd -P)",
  "  lando_public=$(realpath -e -- web/sites/default/files)",
  '  test "$lando_public" = "$lando_root/web/sites/default/files" || { echo "Drupal public files path escaped the app root." >&2; exit 1; }',
  '  lando_mount_owner=$(stat -c %u:%g -- "$lando_root") || { echo "Drupal app mount owner could not be read." >&2; exit 1; }',
  '  case "$lando_mount_owner" in *[!0-9:]*|:*|*:|*:*:*) echo "Drupal app mount has invalid uid:gid ownership." >&2; exit 1;; esac',
  '  lando_mount_uid=$(printf "%s" "$lando_mount_owner" | cut -d: -f1)',
  '  lando_mount_gid=$(printf "%s" "$lando_mount_owner" | cut -d: -f2)',
  '  if test "$lando_mount_uid" -ne 0 && test "$lando_mount_gid" -ne 0; then',
  "    lando_worker_user=$APACHE_RUN_USER",
  '    test -n "$lando_worker_user" || lando_worker_user=www-data',
  "    lando_worker_group=$APACHE_RUN_GROUP",
  '    test -n "$lando_worker_group" || lando_worker_group=www-data',
  '    lando_worker_uid=$(id -u "$lando_worker_user") || { echo "Drupal PHP worker user is unavailable." >&2; exit 1; }',
  '    lando_worker_gid=$(getent group "$lando_worker_group" | cut -d: -f3)',
  '    test -n "$lando_worker_gid" || { echo "Drupal PHP worker group is unavailable." >&2; exit 1; }',
  '    if test "$lando_worker_user" = www-data && test "$lando_worker_group" = www-data; then',
  '      test "$lando_worker_uid:$lando_worker_gid" = "$lando_mount_owner" || { echo "Drupal PHP worker does not own the Windows app mount." >&2; exit 1; }',
  "    fi",
  '    chown -hR -P -- "$lando_worker_user:$lando_worker_group" web/sites/default/files',
  "  fi",
  "fi",
].join("\n");

export const drupalCmsInstallCommand = (driver: "mysql" | "pgsql", appName: string): string => {
  const password =
    driver === "pgsql" ? `$(printf '%s' '${appName}' | sha256sum | cut -c1-16 | sed 's/^/lando-/')` : "lando";
  return [
    "mkdir -p web/sites/default/files",
    `vendor/bin/drush site:install recipes/drupal_cms_starter --db-url="${driver}://lando:${password}@database/${appName}" -y`,
    'vendor/bin/drush php:eval \'if (!\\Drupal::service("file.htaccess_writer")->write("public://", FALSE)) { throw new \\RuntimeException("Could not protect the Drupal public files directory."); }\'',
    windowsPublicFilesOwnership,
    ":",
  ].join(" && ");
};
