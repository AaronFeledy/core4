/** Resolve Drush's base URL at invocation time, after the router has acquired its ports. */
export const DRUSH_TOOLING_COMMAND = [
  'if [ -n "$DRUSH_OPTIONS_URI" ]; then exec vendor/bin/drush "$@"; fi',
  'for lando_drush_arg do case "$lando_drush_arg" in --uri|--uri=*|-l|-l?*) exec vendor/bin/drush "$@";; esac; done',
  'lando_drush_json=$(lando app:open --print --format=json) || { printf "%s\\n" "Could not resolve this app URL for Drush. Run lando open --print, or set DRUSH_OPTIONS_URI." >&2; exit 1; }',
  `lando_drush_uri=$(printf "%s" "$lando_drush_json" | php -r '$data = json_decode(stream_get_contents(STDIN), true); $url = $data["result"]["targets"][0]["url"] ?? null; if (($data["ok"] ?? false) !== true || !is_string($url) || filter_var($url, FILTER_VALIDATE_URL) === false || !in_array(parse_url($url, PHP_URL_SCHEME), ["http", "https"], true) || preg_match("/[[:space:]]/", $url)) exit(1); echo $url;') || { printf "%s\\n" "Lando returned an invalid app URL for Drush. Run lando open --print, or set DRUSH_OPTIONS_URI." >&2; exit 1; }`,
  'DRUSH_OPTIONS_URI="$lando_drush_uri" exec vendor/bin/drush "$@"',
].join("\n");
