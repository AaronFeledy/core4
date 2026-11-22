const PHPCS_RULESETS = [".phpcs.xml", "phpcs.xml", ".phpcs.xml.dist", "phpcs.xml.dist"] as const;
const PHPSTAN_CONFIGS = [
  ".phpstan.neon",
  "phpstan.neon",
  ".phpstan.neon.dist",
  "phpstan.neon.dist",
  ".phpstan.dist.neon",
  "phpstan.dist.neon",
] as const;
const DRUPAL_STANDARD = "Drupal,DrupalPractice";
const DRUPAL_EXTENSIONS = "engine,inc,info,install,module,php,profile,test,theme,yml";
const DRUPAL_IGNORE = "*/node_modules/*,*/vendor/*";
const DRUSH_URI_HINT = "Run lando open --print, or set DRUSH_OPTIONS_URI.";

const script = `lando_find_ancestor_file() {
  lando_scan_dir=\${1%/}
  shift
  while :; do
    for lando_file do
      if [ -f "$lando_scan_dir/$lando_file" ]; then
        printf '%s\\n' "$lando_scan_dir/$lando_file"
        return 0
      fi
    done
    if [ -z "$lando_scan_dir" ]; then return 1; fi
    lando_scan_dir=\${lando_scan_dir%/*}
  done
}

if [ -z "$1" ]; then
  printf '%s\\n' 'drupal-local: a tool is required.' >&2
  exit 1
fi
lando_tool=$1
shift
lando_app_root=\${LANDO_APP_ROOT:-/}
lando_webroot=\${LANDO_WEBROOT:-$lando_app_root}
lando_webroot=\${lando_webroot%/}
if lando_composer=$(lando_find_ancestor_file "$lando_webroot" composer.json); then
  lando_site_root=\${lando_composer%/*}
else
  lando_site_root=\${lando_app_root%/}
fi
lando_binary="$lando_site_root/vendor/bin/$lando_tool"
lando_contrib=false
case "\${lando_app_root%/}" in
  "$lando_webroot"/*) lando_contrib=true ;;
esac

if [ ! -f "$lando_binary" ] || [ ! -x "$lando_binary" ]; then
  lando_hint=
  lando_display_binary=$lando_binary
  case "$lando_contrib:$lando_tool" in
    true:phpstan) lando_hint=' Add phpstan/phpstan to require-dev in the extension composer.json, then run lando drupal-contrib-sync.' ;;
    true:phpcs|true:phpcbf|true:drush) lando_hint=' Run lando drupal-contrib-sync.' ;;
    false:phpcs|false:phpcbf) lando_hint=' Run lando composer require --dev drupal/coder.' ;;
    false:phpstan) lando_hint=' Run lando composer require --dev phpstan/phpstan mglaman/phpstan-drupal phpstan/extension-installer.' ;;
    false:drush) lando_hint=' Run lando composer require drush/drush.' ;;
  esac
  if [ "$lando_contrib" = false ] && [ -n "$lando_hint" ]; then
    lando_display_binary="vendor/bin/$lando_tool"
  fi
  printf '%s is not installed.%s\\n' "$lando_display_binary" "$lando_hint" >&2
  exit 1
fi

case "$lando_tool" in
  drush)
    if [ -n "$DRUSH_OPTIONS_URI" ]; then exec "$lando_binary" "$@"; fi
    for lando_arg do
      case "$lando_arg" in --) break ;; --uri|--uri=*|-l*) exec "$lando_binary" "$@" ;; esac
    done
    lando_json=$(lando app:open --print --format=json) || {
      printf '%s\\n' 'Could not resolve this app URL for Drush. ${DRUSH_URI_HINT}' >&2
      exit 1
    }
    lando_uri=$(printf '%s' "$lando_json" | php -r '
      $data = json_decode(stream_get_contents(STDIN), true);
      $url = $data["result"]["targets"][0]["url"] ?? null;
      if (($data["ok"] ?? false) !== true || !is_string($url)) exit(1);
      if (filter_var($url, FILTER_VALIDATE_URL) === false
        || !in_array(parse_url($url, PHP_URL_SCHEME), ["http", "https"], true)
        || preg_match("/[[:space:]]/", $url)) exit(1);
      echo $url;
    ') || {
      printf '%s\\n' 'Lando returned an invalid app URL for Drush. ${DRUSH_URI_HINT}' >&2
      exit 1
    }
    DRUSH_OPTIONS_URI="$lando_uri" exec "$lando_binary" "$@"
    ;;
  phpcs|phpcbf)
    if lando_find_ancestor_file "$PWD" ${PHPCS_RULESETS.join(" ")} >/dev/null; then
      exec "$lando_binary" "$@"
    fi
    lando_action=check
    lando_default_config=phpcs.xml.dist
    ;;
  phpstan)
    case "$#:$1" in
      0:|*:analyse|*:analyze)
        for lando_arg do
          case "$lando_arg" in --) break ;; -c*|--configuration|--configuration=*) exec "$lando_binary" "$@" ;; esac
        done
        if lando_config=$(lando_find_ancestor_file "$PWD" ${PHPSTAN_CONFIGS.join(" ")}); then
          lando_subcommand=\${1:-analyse}
          if [ "$#" -gt 0 ]; then shift; fi
          exec "$lando_binary" "$lando_subcommand" "--configuration=$lando_config" "$@"
        fi
        ;;
    esac
    if [ "$#" -gt 0 ]; then exec "$lando_binary" "$@"; fi
    lando_action=analyse
    lando_default_config=phpstan.neon.dist
    ;;
  *) exec "$lando_binary" "$@" ;;
esac

if [ "$#" -eq 0 ]; then
  if [ "$lando_contrib" = true ]; then
    lando_target_list=$lando_app_root
    if [ -d "$lando_app_root" ]; then set -- "$lando_app_root"; fi
  else
    lando_target_list="$lando_webroot/modules/custom, $lando_webroot/themes/custom, $lando_webroot/profiles/custom"
    for lando_kind in modules themes profiles; do
      lando_target="$lando_webroot/$lando_kind/custom"
      if [ -d "$lando_target" ]; then set -- "$@" "$lando_target"; fi
    done
  fi
  if [ "$#" -eq 0 ]; then
    printf 'No custom code to %s in %s. Pass paths or add %s.\\n' "$lando_action" "$lando_target_list" "$lando_default_config" >&2
    exit 1
  fi
fi

if [ "$lando_tool" = phpstan ]; then exec "$lando_binary" analyse "$@"; fi

lando_extensions=default
lando_ignore=default
for lando_arg do
  case "$lando_arg" in
    --) break ;;
    --standard=*) exec "$lando_binary" "$@" ;;
    --extensions=*) lando_extensions=explicit ;;
    --ignore=*) lando_ignore=explicit ;;
  esac
done
if [ "$lando_ignore" = default ]; then set -- '--ignore=${DRUPAL_IGNORE}' "$@"; fi
if [ "$lando_extensions" = default ]; then set -- '--extensions=${DRUPAL_EXTENSIONS}' "$@"; fi
exec "$lando_binary" '--standard=${DRUPAL_STANDARD}' "$@"`;

export const drupalLocalLauncher = ["sh", "-c", script, "drupal-local"] as const;
