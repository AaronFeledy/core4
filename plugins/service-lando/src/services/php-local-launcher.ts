const script = `if [ -z "$1" ]; then
  printf '%s\\n' 'php-local: a command is required.' >&2
  exit 1
fi
lando_cmd=$1
shift
case "$lando_cmd" in
  /*) exec "$lando_cmd" "$@" ;;
  */*) lando_bare=false ;;
  *) lando_bare=true ;;
esac

lando_root=\${LANDO_APP_ROOT:-/}
lando_root=\${lando_root%/}
case "$PWD" in
  "$lando_root"|"$lando_root"/*) lando_dir=$PWD ;;
  *) lando_dir=$lando_root ;;
esac
lando_dir=\${lando_dir%/}
while :; do
  lando_vendor="$lando_dir/vendor/bin/$lando_cmd"
  if [ "$lando_bare" = true ] && [ -f "$lando_vendor" ] && [ -x "$lando_vendor" ]; then
    exec "$lando_vendor" "$@"
  fi
  lando_script="$lando_dir/$lando_cmd"
  if [ -f "$lando_script" ]; then exec php "$lando_script" "$@"; fi
  if [ "$lando_dir" = "$lando_root" ]; then break; fi
  lando_dir=\${lando_dir%/*}
done

if [ "$lando_bare" = true ] && command -v -- "$lando_cmd" >/dev/null 2>&1; then
  exec "$lando_cmd" "$@"
fi
printf 'php-local: %s is not in vendor/bin or the app, or on PATH.\\n' "$lando_cmd" >&2
exit 127`;

export const phpLocalLauncher = ["sh", "-c", script, "php-local"] as const;
