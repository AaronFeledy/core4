const DRUPAL_STANDARD = "Drupal,DrupalPractice";
const DRUPAL_EXTENSIONS = "engine,inc,info,install,module,php,profile,test,theme,yml";
const DRUPAL_IGNORE = "*/node_modules/*,*/vendor/*";
const PHPCS_RULESETS = [".phpcs.xml", "phpcs.xml", ".phpcs.xml.dist", "phpcs.xml.dist"] as const;
const PHPSTAN_CONFIGS = [
  ".phpstan.neon",
  "phpstan.neon",
  ".phpstan.neon.dist",
  "phpstan.neon.dist",
  ".phpstan.dist.neon",
  "phpstan.dist.neon",
] as const;

type QualityTool = "phpcs" | "phpcbf" | "phpstan";
type QualityTarget = {
  readonly binary: string;
  readonly targets: readonly string[];
  readonly missing: string;
};

// Keep shell expansions unbraced so the emitted Landofile does not interpolate them.
const phpQualityToolingCommand = (tool: QualityTool, { binary, targets, missing }: QualityTarget): string => {
  const phpstan = tool === "phpstan";
  const passthrough = `exec ${binary} "$@"`;
  const configExec = phpstan
    ? `exec ${binary} analyse --configuration="$lando_dir/$lando_file"`
    : passthrough;
  const configNames = phpstan ? PHPSTAN_CONFIGS : PHPCS_RULESETS;
  const noTargets = `No custom code to ${phpstan ? "analyse" : "check"} in ${targets.join(", ")}. Pass paths or add ${phpstan ? "phpstan.neon.dist" : "phpcs.xml.dist"}.`;
  const addTargets = [
    `for lando_target in ${targets.map((target) => `"${target}"`).join(" ")}; do`,
    '  if [ -d "$lando_target" ]; then set -- "$@" "$lando_target"; fi',
    "done",
    `if [ "$#" -eq 0 ]; then printf '%s\\n' "${noTargets}" >&2; exit 1; fi`,
  ];
  const prelude = [
    `if [ ! -e ${binary} ]; then printf '%s\\n' '${missing}' >&2; exit 1; fi`,
    ...(phpstan ? [`if [ "$#" -ne 0 ]; then ${passthrough}; fi`] : []),
    'lando_dir="$PWD"',
    "while :; do",
    '  if [ "$lando_dir" = / ]; then lando_dir=; fi',
    `  for lando_file in ${configNames.join(" ")}; do`,
    `    if [ -f "$lando_dir/$lando_file" ]; then ${configExec}; fi`,
    "  done",
    '  if [ -z "$lando_dir" ]; then break; fi',
    '  lando_dir=$(dirname "$lando_dir")',
    "done",
  ];
  if (phpstan) return [...prelude, ...addTargets, `exec ${binary} analyse "$@"`].join("\n");

  return [
    ...prelude,
    'if [ "$#" -eq 0 ]; then',
    ...addTargets.map((line) => `  ${line}`),
    "fi",
    "lando_extensions=default",
    "lando_ignore=default",
    "for lando_arg do",
    '  case "$lando_arg" in',
    `    --standard=*) ${passthrough} ;;`,
    "    --extensions=*) lando_extensions=explicit ;;",
    "    --ignore=*) lando_ignore=explicit ;;",
    "  esac",
    "done",
    `if [ "$lando_ignore" = default ]; then set -- '--ignore=${DRUPAL_IGNORE}' "$@"; fi`,
    `if [ "$lando_extensions" = default ]; then set -- '--extensions=${DRUPAL_EXTENSIONS}' "$@"; fi`,
    `exec ${binary} '--standard=${DRUPAL_STANDARD}' "$@"`,
  ].join("\n");
};

const qualityTool = (description: string, tool: QualityTool, target: QualityTarget) =>
  ({
    service: "appserver",
    description,
    cmds: [phpQualityToolingCommand(tool, target)],
    wrapper: true,
  }) as const;

const siteTarget = (tool: QualityTool): QualityTarget => ({
  binary: `"$LANDO_APP_ROOT/vendor/bin/${tool}"`,
  targets: [
    "$LANDO_WEBROOT/modules/custom",
    "$LANDO_WEBROOT/themes/custom",
    "$LANDO_WEBROOT/profiles/custom",
  ],
  missing: `vendor/bin/${tool} is not installed. Run lando composer require --dev ${tool === "phpstan" ? "phpstan/phpstan mglaman/phpstan-drupal phpstan/extension-installer" : "drupal/coder"}.`,
});

const contribTarget = (tool: QualityTool): QualityTarget => {
  const binary = `/app/vendor/bin/${tool}`;
  return {
    binary,
    targets: ["$LANDO_APP_ROOT"],
    missing:
      tool === "phpstan"
        ? `${binary} is not installed. Add phpstan/phpstan to require-dev in the extension composer.json, then run lando drupal-contrib-sync.`
        : `${binary} is not installed. Run lando drupal-contrib-sync.`,
  };
};

export const siteQualityTooling = {
  phpcs: qualityTool("Run PHP_CodeSniffer inside the appserver service.", "phpcs", siteTarget("phpcs")),
  phpcbf: qualityTool("Run phpcbf inside the appserver service.", "phpcbf", siteTarget("phpcbf")),
  phpstan: qualityTool("Run PHPStan inside the appserver service.", "phpstan", siteTarget("phpstan")),
} as const;

export const contribQualityTooling = {
  phpcs: qualityTool(
    "Run PHP_CodeSniffer with Drupal Coder from your current directory.",
    "phpcs",
    contribTarget("phpcs"),
  ),
  phpcbf: qualityTool(
    "Run phpcbf with Drupal Coder from your current directory.",
    "phpcbf",
    contribTarget("phpcbf"),
  ),
  phpstan: qualityTool("Run PHPStan from your current directory.", "phpstan", contribTarget("phpstan")),
} as const;
