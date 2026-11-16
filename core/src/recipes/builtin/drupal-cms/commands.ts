import { scaffoldProtocol } from "../scaffold-protocol.ts";

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

/**
 * Stages Drupal CMS 2 with the pinned SVG Image patch, verifies the projection,
 * and promotes the tree with the shared scaffold protocol.
 */
export const DRUPAL_CMS_SCAFFOLD_COMMAND = scaffoldProtocol({
  label: "Drupal CMS",
  markerPrefix: ".lando-drupal-cms-scaffold",
  stagingMarker: ".lando-drupal-cms-stage-complete",
  appRootEnv: "LANDO_DRUPAL_CMS_APP_ROOT",
  stagingRootEnv: "LANDO_DRUPAL_CMS_STAGING_ROOT",
  defaultAppRoot: "/app",
  stagingPrefix: "lando-drupal-cms-",
  completeMessage: "Drupal CMS is already scaffolded at $app_root.",
  outputs: "composer.json, vendor/bin/drush, and web/",
  complete: [
    'test -f "$app_root/composer.json"',
    'test -x "$app_root/vendor/bin/drush"',
    'test -d "$app_root/web"',
  ],
  generate: [
    "composer create-project 'drupal/cms:^2' \"$staging_root\" --no-install --no-scripts --no-interaction",
    `svg_repository='${SVG_IMAGE_REPOSITORY}'`,
    'composer --working-dir="$staging_root" config repositories.lando-svg-image --json "$svg_repository"',
    "composer --working-dir=\"$staging_root\" require --no-update 'drupal/svg_image:3.x-dev' 'enshrined/svg-sanitize:^1.0' 'drupal/drupal_cms_starter:^2'",
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
    'test -f "$staging_root/recipes/drupal_cms_starter/recipe.yml" || fail "Drupal CMS scaffold did not install the drupal_cms_starter recipe."',
  ],
});

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
