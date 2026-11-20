/**
 * Site-recipe prelude for phpcs, phpcbf, and phpstan. Hints when the vendor
 * binary is missing and, with no arguments, targets custom modules and themes
 * under the recipe webroot when those directories exist. Drupal contrib keeps
 * its own no-arg argv tools; do not share this prelude with it.
 */
export const phpQualityToolingCommand = (
  binary: "phpcs" | "phpcbf" | "phpstan",
  missing: string,
  options: { readonly defaultArgs?: ReadonlyArray<string>; readonly webroot?: string } = {},
): string => {
  const webroot = options.webroot ?? "{{ recipe.webroot }}";
  const varName = `lando_${binary}_webroot`;
  const defaultArgs = options.defaultArgs ?? [];
  return [
    `if [ ! -e vendor/bin/${binary} ]; then printf "%s\\n" "${missing}" >&2; exit 1; fi`,
    `${varName}="${webroot}"`,
    "if [ $# -eq 0 ]; then",
    ...(defaultArgs.length === 0 ? [] : [`set -- ${defaultArgs.map((arg) => `"${arg}"`).join(" ")}`]),
    `if [ -d "$${varName}/modules/custom" ]; then set -- "$@" "$${varName}/modules/custom"; fi`,
    `if [ -d "$${varName}/themes/custom" ]; then set -- "$@" "$${varName}/themes/custom"; fi`,
    "fi",
    `exec vendor/bin/${binary} "$@"`,
  ].join("\n");
};

export const PHPCS_MISSING_HINT =
  "vendor/bin/phpcs is not installed. Require drupal/coder, then run lando composer install.";
export const PHPCBF_MISSING_HINT =
  "vendor/bin/phpcbf is not installed. Require drupal/coder, then run lando composer install.";
export const PHPSTAN_MISSING_HINT =
  "vendor/bin/phpstan is not installed. Require phpstan/phpstan or drupal/core-dev, then run lando composer install.";

export const PHPCS_TOOLING_COMMAND = phpQualityToolingCommand("phpcs", PHPCS_MISSING_HINT);
export const PHPCBF_TOOLING_COMMAND = phpQualityToolingCommand("phpcbf", PHPCBF_MISSING_HINT);
export const PHPSTAN_TOOLING_COMMAND = phpQualityToolingCommand("phpstan", PHPSTAN_MISSING_HINT, {
  defaultArgs: ["analyse"],
});
