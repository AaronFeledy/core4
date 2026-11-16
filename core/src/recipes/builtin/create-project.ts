import { scaffoldProtocol } from "./scaffold-protocol.ts";

/**
 * Source of the `lando-create-project` shell program. The PHP service image
 * installs this text as `/usr/local/bin/lando-create-project` (see
 * `scripts/build-php-create-project.ts`), and the Composer recipes expose it as
 * the `create-project` tool, so a Landofile carries only the task declaration.
 *
 * Composer runs a new project's hooks in its own order: the root package is
 * created, dependencies are installed, then the project's console command
 * runs. Staging skips both hooks and dependency installation, so the promoted
 * app root installs `vendor` directly into whatever mount already exists
 * there, and only the hooks this root package actually defines run.
 *
 * Composer 2.10 fails `run-script` for an event with no listeners, so each
 * hook is probed against the root package's own `scripts` declaration before
 * it runs. `composer config` does not report scripts, so the probe reads
 * `composer.json` with the PHP that Composer itself runs on.
 *
 * The program never assumes a privileged identity: every path it writes is
 * inside the app root or the temporary directory it creates.
 */
export const createProjectCommand = (): string =>
  [
    "#!/bin/sh",
    scaffoldProtocol({
      label: "create-project",
      markerPrefix: ".lando-create-project",
      stagingMarker: ".lando-create-project-stage-complete",
      appRootEnv: "LANDO_CREATE_PROJECT_APP_ROOT",
      stagingRootEnv: "LANDO_CREATE_PROJECT_STAGING_ROOT",
      defaultAppRoot: "/app",
      defaultAppRootEnv: "LANDO_PROJECT_MOUNT",
      stagingPrefix: "lando-create-project-",
      completeMessage: "create-project already published a project at $app_root.",
      outputs: "composer.json",
      complete: ['test -f "$app_root/composer.json"'],
      prepare: [
        "no_scripts=0",
        "package=",
        "version=",
        'for lando_argument in "$@"; do case "$lando_argument" in --no-scripts) no_scripts=1;; *) if test -z "$package"; then package=$lando_argument; elif test -z "$version"; then version=$lando_argument; else fail "create-project accepts one package and an optional version."; fi;; esac; done',
        'test -n "$package" || fail "create-project needs a Composer package, for example laravel/laravel."',
        'case "$package" in -*) fail "create-project package names cannot start with a dash: $package";; */*) ;; *) fail "create-project package names use vendor/package syntax: $package";; esac',
        'case "$version" in -*) fail "create-project versions cannot start with a dash: $version";; esac',
      ],
      preflight: [
        'if test -f "$app_root/composer.json" && ! test -f "$manifest"; then fail "create-project refuses $app_root because composer.json already exists; run lando composer install for an existing project, or start from an empty app root."; fi',
      ],
      generate: [
        'if test -n "$version"; then composer create-project "$package" "$staging_root" "$version" --no-install --no-scripts --no-interaction; else composer create-project "$package" "$staging_root" --no-install --no-scripts --no-interaction; fi',
        'test -f "$staging_root/composer.json" || fail "create-project did not stage a composer.json."',
      ],
      afterPromote: [
        'cd "$app_root"',
        'has_script() { LANDO_COMPOSER_EVENT="$1" php -r \'exit(isset(json_decode(file_get_contents("composer.json"), true)["scripts"][getenv("LANDO_COMPOSER_EVENT")]) ? 0 : 1);\'; }',
        'if test "$no_scripts" -eq 0 && has_script post-root-package-install; then composer run-script post-root-package-install || fail "create-project could not run the post-root-package-install hook; fix the hook and rerun lando create-project."; fi',
        'if test "$no_scripts" -eq 1; then composer install --no-interaction --no-scripts || fail "create-project could not install dependencies; fix the Composer error and rerun lando composer install."; else composer install --no-interaction || fail "create-project could not install dependencies; fix the Composer error and rerun lando composer install."; fi',
        'if test "$no_scripts" -eq 0 && has_script post-create-project-cmd; then composer run-script post-create-project-cmd || fail "create-project could not run the post-create-project-cmd hook; fix the hook and rerun lando create-project."; fi',
      ],
    }),
    "",
  ].join("\n");
