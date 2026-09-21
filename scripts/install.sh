#!/usr/bin/env sh
# allow: SIZE_OK — standalone POSIX download entrypoint cannot depend on adjacent source modules.
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

download() {
  url=$1
  out=$2
  case "$url" in
    file://*) cp "${url#file://}" "$out" ;;
    /*) cp "$url" "$out" ;;
    http://*|https://*)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$out"
      elif command -v wget >/dev/null 2>&1; then
        wget -qO "$out" "$url"
      else
        fail "Missing required command: curl or wget"
      fi
      ;;
    *) fail "Unsupported download URL: $url" ;;
  esac
}

json_compact() {
  tr -d '\n\r' < "$1"
}

json_field_from_object() {
  object=$1
  field=$2
  printf '%s\n' "$object" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

manifest_binary_field() {
  manifest=$1
  platform=$2
  field=$3
  object=$(json_compact "$manifest" | sed -n "s/.*\"$platform\"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p")
  [ -n "$object" ] || fail "Release manifest has no binary entry for $platform"
  value=$(json_field_from_object "$object" "$field")
  [ -n "$value" ] || fail "Release manifest binary entry for $platform is missing $field"
  printf '%s\n' "$value"
}

manifest_checksum_field() {
  manifest=$1
  field=$2
  object=$(json_compact "$manifest" | sed -n 's/.*"checksums"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p')
  [ -n "$object" ] || fail "Release manifest is missing checksums"
  value=$(json_field_from_object "$object" "$field")
  [ -n "$value" ] || fail "Release manifest checksums entry is missing $field"
  printf '%s\n' "$value"
}

cosign_certificate_url() {
  signature_url=$1
  if [ -n "${LANDO_INSTALL_COSIGN_CERTIFICATE_URL:-}" ]; then
    printf '%s\n' "$LANDO_INSTALL_COSIGN_CERTIFICATE_URL"
    return
  fi
  case "$signature_url" in
    *.sig) printf '%s.crt\n' "${signature_url%.sig}" ;;
    *) fail "Cannot derive cosign certificate URL from signature URL: $signature_url" ;;
  esac
}

detect_libc() {
  if [ -n "${LANDO_INSTALL_LIBC:-}" ]; then
    printf '%s\n' "$LANDO_INSTALL_LIBC"
    return
  fi
  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    printf '%s\n' "musl"
    return
  fi
  printf '%s\n' "glibc"
}

detect_platform() {
  os=${LANDO_INSTALL_OS:-$(uname -s)}
  arch=${LANDO_INSTALL_ARCH:-$(uname -m)}

  case "$os" in
    Linux)
      libc=$(detect_libc)
      [ "$libc" = "glibc" ] || fail "Unsupported Linux libc: $libc. Lando release binaries require glibc for the linux platform targets."
      case "$arch" in
        x86_64|amd64) printf '%s\n' "linux-x64" ;;
        aarch64|arm64) printf '%s\n' "linux-arm64" ;;
        *) fail "Unsupported Linux architecture: $arch" ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64|amd64) printf '%s\n' "darwin-x64" ;;
        arm64|aarch64) printf '%s\n' "darwin-arm64" ;;
        *) fail "Unsupported macOS architecture: $arch" ;;
      esac
      ;;
    *) fail "Unsupported POSIX operating system: $os" ;;
  esac
}

default_user_data_root() {
  if [ -n "${LANDO_USER_DATA_ROOT:-}" ]; then
    printf '%s\n' "$LANDO_USER_DATA_ROOT"
    return
  fi
  case "${LANDO_INSTALL_OS:-$(uname -s)}" in
    Darwin) printf '%s\n' "${HOME:-.}/Library/Application Support/Lando" ;;
    *) printf '%s/lando\n' "${XDG_DATA_HOME:-${HOME:-.}/.local/share}" ;;
  esac
}

default_install_dir() {
  if [ -n "${LANDO_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$LANDO_INSTALL_DIR"
    return
  fi
  printf '%s/bin\n' "$(default_user_data_root)"
}

posix_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\"'\"'/g"
  printf "'"
}

# Reproduces the shellenv renderer byte for byte; install-posix.test.ts pins the agreement.
print_path_guidance() {
  user_data_root=$(default_user_data_root)
  bin_dir=$(dirname "$destination")
  printf '\nRun this command to add lando4 to PATH:\n'
  # Expansion belongs to the users shell when they run the printed command.
  # shellcheck disable=SC2016
  printf 'eval "$(%s shellenv)"\n' "$(posix_quote "$destination")"
  printf 'The command prints:\n'
  printf 'export LANDO_USER_DATA_ROOT=%s\n' "$(posix_quote "$user_data_root")"
  # shellcheck disable=SC2016
  printf 'case ":${PATH}:" in *%s*) ;; *) export PATH=%s":${PATH}" ;; esac\n' \
    "$(posix_quote ":$bin_dir:")" "$(posix_quote "$bin_dir")"
}

print_setup_skipped() {
  printf 'post-install setup: skipped\n'
  printf 'Run setup later with: %s setup\n' "$(posix_quote "$destination")"
}

run_post_install_setup() {
  if [ "${LANDO_INSTALL_RUN_SETUP:-}" = "1" ]; then
    "$destination" setup --yes
    printf 'post-install setup: completed\n'
    return
  fi

  if [ "${LANDO_INSTALL_SKIP_SETUP:-}" = "1" ] || [ "${LANDO_INSTALL_NONINTERACTIVE:-}" = "1" ] || [ ! -t 0 ]; then
    print_setup_skipped
    return
  fi

  printf 'Run lando4 setup now? [y/N] ' >&2
  read -r answer || answer=
  case "$answer" in
    y|Y|yes|YES)
      "$destination" setup --yes
      printf 'post-install setup: completed\n'
      ;;
    *)
      print_setup_skipped
      ;;
  esac
}

basename_from_url() {
  path=$1
  path=${path%%\?*}
  path=${path#file://}
  basename "$path"
}

verify_checksum() {
  sums=$1
  binary=$2
  artifact=$3
  expected=$(
    awk -v artifact="$artifact" '
      {
        path = $2
        sub(/^.*\//, "", path)
        if ($2 == artifact || path == artifact) {
          print $1
          exit
        }
      }
    ' "$sums"
  )
  [ -n "$expected" ] || fail "Checksum manifest does not contain $artifact"
  actual=$(file_digest "$binary")
  [ "$actual" = "$expected" ] || fail "Checksum mismatch for $artifact"
}

file_digest() {
  case "${LANDO_INSTALL_OS:-$(uname -s)}" in
    Darwin)
      need shasum
      shasum -a 256 < "$1" | awk '{ print $1 }'
      ;;
    *)
      need sha256sum
      sha256sum < "$1" | awk '{ print $1 }'
      ;;
  esac
}

json_string() {
  printf '%s\n' "$1" | LC_ALL=C awk '
    BEGIN { printf "\""; for (n = 1; n < 32; n++) controls[sprintf("%c", n)] = n }
    { if (NR > 1) printf "\\n"
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "\\" || c == "\"") printf "\\%s", c
        else if (c == "\t") printf "\\t"
        else if (c == "\r") printf "\\r"
        else if (c in controls) printf "\\u%04x", controls[c]
        else printf "%s", c
      }
    }
    END { printf "\"" }
  '
}

reject_destination() {
  fail "Refusing to replace $destination: ownership is unproven. Remove it or set LANDO_INSTALL_DIR to another directory."
}

check_destination() {
  [ ! -L "$destination" ] || reject_destination
  [ ! -e "$destination" ] || {
    [ -f "$destination" ] || reject_destination
    [ ! -L "$record" ] || reject_destination
    [ -f "$record" ] || reject_destination
    [ -r "$record" ] || reject_destination
    # Parse the whole JSON document, rejecting duplicates and trailing garbage.
    # Compare encoded paths, never evaluate file content as shell code.
    RECORD_PATH=$(json_string "$destination") RECORD_SHA="\"$(file_digest "$destination")\"" \
      RECORD_SIZE=$(wc -c < "$destination" | tr -d '[:space:]') LC_ALL=C awk '
      function ws() { while (substr(s, p, 1) ~ /^[ \t\r\n]$/) p++ }
      function bad() { invalid = 1; exit 1 }
      function string( start, c, e) {
        start = p++
        while (p <= length(s)) {
          c = substr(s, p++, 1)
          if (c == "\"") return substr(s, start, p-start)
          if (c ~ /[[:cntrl:]]/) bad()
          if (c == "\\") {
            e = substr(s, p++, 1)
            if (e == "u") {
              if (substr(s, p, 4) !~ /^[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]$/) bad()
              p += 4
            } else if (e !~ /^["\\\/bfnrt]$/) bad()
          }
        }
        bad()
      }
      function value(path, depth, c, endchar, key, n, raw) {
        if (depth > 32 || seen[path]++) bad()
        ws(); c = substr(s, p, 1)
        if (c == "{" || c == "[") {
          endchar = c == "{" ? "}" : "]"; types[path] = c; p++; ws()
          if (substr(s, p, 1) == endchar) { p++; return }
          do {
            ws()
            if (c == "{") {
              if (substr(s, p, 1) != "\"") bad()
              key = string(); ws()
              if (substr(s, p++, 1) != ":") bad()
            } else key = ++n
            value(path "/" key, depth+1); ws()
            raw = substr(s, p++, 1)
            if (raw == endchar) return
            if (raw != ",") bad()
          } while (p <= length(s))
          bad()
        }
        if (c == "\"") raw = string()
        else {
          if (!match(substr(s, p), /^(true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?)/)) bad()
          raw = substr(s, p, RLENGTH); p += RLENGTH
        }
        values[path] = raw
      }
      { s = s $0 "\n"; if (length(s) > 1048576) bad() }
      END {
        if (invalid) exit 1
        p = 1; value("", 0); ws()
        base = "/\"data\"/\"executable\""
        if (p <= length(s) || types[""] != "{" || types["/\"data\""] != "{" || types[base] != "{" ||
            values["/\"version\""] != "1" || values[base "/\"path\""] != ENVIRON["RECORD_PATH"] ||
            values[base "/\"sha256\""] != ENVIRON["RECORD_SHA"] ||
            values[base "/\"size\""] != ENVIRON["RECORD_SIZE"]) exit 1
      }
    ' "$record" || reject_destination
  }
}

write_embedded_gpg_trust_root() {
  cat <<'EOF'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQENBGozgS4BCAC2HRH2E/2UB+QkeVPaVMyoHsXIUsXMB8U8AiX9e2xOZeT4Ys0m
I+uEkpRuVZcRsdXYngNg/hE+SWNN9W9RAxA44jt1rqb3tdqdeN0/Rat36eBSbvPz
rR6gdFuDZcleWz+Gg0ZfliEAp8Mh46hkIVQBzXqxxbQtqhyOWkYCk1cD18eMcgPW
6GGauLZrSJdyL9o94FuHQzmAiZAy/wjt82Pq6+G0auqy00Ztji8WrlPd6j3UAvB+
u60iORlxDOUNbkzs4NOJfS+mqBZ/2nxW4RdstBxR9vT0oMhcrlgahYdV33CEwdZq
SBjiYOLVdte2iEMSyGe680XrutoVgthUU6uvABEBAAG0KUxhbmRvIFJlbGVhc2Ug
U2lnbmluZyA8cmVsZWFzZUBsYW5kby5kZXY+iQFSBBMBCgA8FiEEhdZgEfIx0KVN
RbSc0dVN1wVe5/8FAmozgS4DGy8EBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheA
AAoJENHVTdcFXuf/ye8H/A47NJ1zGMfqgxex+zalMhCDX4X7V2fFlCTkBOF/cpUU
LJVWIU5n2QWQ3PdBZPnC5THoEZ5PVE/1JfTFzNXqVkUJTD1VClY5/D/7jB2ou/N5
aqSXVgtn8P4toXRCw0m7Y48ik4StpD7jKS41feN2piSW4jSk/+06H/j3PryDWm/H
wjg07DNORONJja2VT4HjV7KuOtjDfwc285Rn+Ev3aZRXuiIHRCJqmvL+2qxI1hRX
ijGCeQCsTMup5X6d9tUTJfJpq7J2x8KU5m8yOR5G4Gen9IGBI39GwUv8Gbl3I20M
z3kzteWUtd5HdXZgbQBiSN5BknCw8HHNKmprCZb82Ss=
=ZneC
-----END PGP PUBLIC KEY BLOCK-----
EOF
}

prepare_gpg_trust_root() {
  gpg=$1
  gpg_home=$tmp/gpg-home
  trust_root=$tmp/lando-release-gpg.asc
  mkdir -p "$gpg_home"
  chmod 0700 "$gpg_home"

  if [ -n "${LANDO_INSTALL_GPG_TRUST_ROOT:-}" ]; then
    [ -r "$LANDO_INSTALL_GPG_TRUST_ROOT" ] || fail "Missing or malformed vendored GPG trust root"
    cp "$LANDO_INSTALL_GPG_TRUST_ROOT" "$trust_root"
  else
    write_embedded_gpg_trust_root > "$trust_root"
  fi

  [ -s "$trust_root" ] || fail "Missing or malformed vendored GPG trust root"
  "$gpg" --batch --homedir "$gpg_home" --import "$trust_root" >/dev/null 2>&1 || fail "Missing or malformed vendored GPG trust root"
  printf '%s\n' "$gpg_home"
}

verify_checksums_signature() {
  signature_url=$1
  sums=$2
  signature=$3
  case "$signature_url" in
    *.sig)
      certificate=$tmp/SHA256SUMS.crt
      certificate_url=$(cosign_certificate_url "$signature_url")
      download "$certificate_url" "$certificate"
      cosign=${LANDO_INSTALL_COSIGN:-cosign}
      "$cosign" verify-blob \
        --certificate-identity-regexp "${LANDO_INSTALL_COSIGN_CERTIFICATE_IDENTITY_REGEXP:-^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/.+$}" \
        --certificate-oidc-issuer "${LANDO_INSTALL_COSIGN_CERTIFICATE_OIDC_ISSUER:-https://token.actions.githubusercontent.com}" \
        --signature "$signature" \
        --certificate "$certificate" \
        "$sums" >/dev/null 2>&1 || fail "Signature verification failed for SHA256SUMS"
      ;;
    *)
      gpg=${LANDO_INSTALL_GPG:-gpg}
      gpg_home=$(prepare_gpg_trust_root "$gpg")
      "$gpg" --batch --homedir "$gpg_home" --verify "$signature" "$sums" >/dev/null 2>&1 || fail "Signature verification failed for SHA256SUMS"
      ;;
  esac
}

posix_checksum_signature_url() {
  sums_url=$1
  manifest_signature_url=$2
  case "$manifest_signature_url" in
    *.asc) printf '%s\n' "$manifest_signature_url" ;;
    *) printf '%s.asc\n' "$sums_url" ;;
  esac
}

case "${LANDO_CHANNEL:-stable}" in
  stable|next|dev) channel=${LANDO_CHANNEL:-stable} ;;
  *) fail "Unsupported Lando channel: ${LANDO_CHANNEL:-}" ;;
esac

need basename
need chmod
need cp
need mkdir
need mktemp
need sed
need tr
need awk
need mv
need wc

platform=$(detect_platform)
base_url=${LANDO_INSTALL_BASE_URL:-https://update.lando.dev/v4}
manifest_url=${LANDO_INSTALL_MANIFEST_URL:-${base_url%/}/$channel.json}
install_dir=$(default_install_dir)
case "$install_dir" in /*) ;; *) install_dir="$PWD/$install_dir" ;; esac
user_data_root=$(default_user_data_root)
record="$user_data_root/install/record.json"
destination="$install_dir/lando4"
check_destination
tmp=$(mktemp -d)
install_tmp=
record_tmp=
trap 'rm -rf "$tmp"; [ -z "$install_tmp" ] || rm -f "$install_tmp"; [ -z "$record_tmp" ] || rm -f "$record_tmp"' 0
trap 'exit 1' INT TERM

manifest=$tmp/manifest.json
sums=$tmp/SHA256SUMS
binary=$tmp/lando4

download "$manifest_url" "$manifest"
binary_url=$(manifest_binary_field "$manifest" "$platform" "url")
sums_url=$(manifest_checksum_field "$manifest" "url")
signature_url=$(posix_checksum_signature_url "$sums_url" "$(manifest_checksum_field "$manifest" "signature")")
artifact=$(basename_from_url "$binary_url")
signature=$tmp/$(basename_from_url "$signature_url")

download "$binary_url" "$binary"
download "$sums_url" "$sums"
download "$signature_url" "$signature"

verify_checksums_signature "$signature_url" "$sums" "$signature"
verify_checksum "$sums" "$binary" "$artifact"

mkdir -p "$install_dir"
umask 077
install_tmp=$(mktemp "$install_dir/.lando4.tmp.XXXXXX")
cp "$binary" "$install_tmp"
chmod 0755 "$install_tmp"
check_destination
mv -f "$install_tmp" "$destination"
install_tmp=
mkdir -p "$user_data_root/install"
record_candidate="$record.tmp.$$"
(set -C; : > "$record_candidate")
record_tmp=$record_candidate
printf '{"version":1,"data":{"executable":{"path":%s,"sha256":"%s","size":%s,"channel":%s,"platform":%s},"shellProfiles":[]}}\n' \
  "$(json_string "$destination")" "$actual" "$(wc -c < "$binary" | tr -d '[:space:]')" \
  "$(json_string "$channel")" "$(json_string "$platform")" > "$record_tmp"
mv -f "$record_tmp" "$record"
record_tmp=

printf 'channel: %s\n' "$channel"
printf 'platform: %s\n' "$platform"
printf 'installed: %s\n' "$destination"
print_path_guidance
run_post_install_setup
