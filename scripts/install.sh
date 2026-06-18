#!/usr/bin/env sh
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

resolve_config_file_root() {
  if [ -n "${LANDO_CONFIG__user_conf_root:-}" ]; then
    printf '%s\n' "${LANDO_CONFIG__user_conf_root}"
    return
  fi
  if [ -n "${LANDO_USER_CONF_ROOT:-}" ]; then
    printf '%s\n' "$LANDO_USER_CONF_ROOT"
    return
  fi
  printf '%s\n' "${HOME:-.}/.lando"
}

read_config_user_data_root() {
  conf_root=$1
  config="${conf_root}/config.yml"
  [ -r "$config" ] || return 0
  awk '
    function ltrim(s) { sub(/^ +/, "", s); return s }
    function rtrim(s) { sub(/[ \t]+$/, "", s); return s }
    function trim(s) { return rtrim(ltrim(s)) }
    function parse_scalar(s, trimmed) {
      trimmed = trim(s)
      if (trimmed == "") return "string:\n"
      if (trimmed == "null") return "nonstring:\n"
      if (trimmed == "true") return "nonstring:\n"
      if (trimmed == "false") return "nonstring:\n"
      if (trimmed ~ /^\[/ || trimmed ~ /^\{/) fail = 1
      if (fail) return ""
      if ((trimmed ~ /^".*"$/) || (trimmed ~ /^'\''.*'\''$/)) {
        trimmed = substr(trimmed, 2, length(trimmed) - 2)
      }
      return "string:" trimmed "\n"
    }
    BEGIN { depth = 0; indent_stack[0] = -1; root_stack[0] = 1; seen = 0; kind = ""; value = "" }
    {
      line = $0
      sub(/[ \t]+#.*/, "", line)
      trimmed_line = trim(line)
      if (trimmed_line == "" || trimmed_line ~ /^#/) next
      indent = match(line, /[^ ]/) - 1
      if (indent < 0) indent = 0
      if (trimmed_line !~ /^[A-Za-z0-9_-]+:/) { fail = 1; exit }
      key = trimmed_line
      sub(/:.*/, "", key)
      raw = trimmed_line
      sub(/^[A-Za-z0-9_-]+:/, "", raw)
      while (depth > 0 && indent <= indent_stack[depth]) depth--
      if (indent <= indent_stack[depth]) { fail = 1; exit }
      parent_is_root = root_stack[depth]
      if (trim(raw) == "") {
        if (parent_is_root && key == "userDataRoot") { seen = 1; kind = "object"; value = "" }
        depth++
        indent_stack[depth] = indent
        root_stack[depth] = 0
        next
      }
      parsed = parse_scalar(raw)
      if (fail) exit
      parsed_kind = parsed
      sub(/:.*/, "", parsed_kind)
      parsed_value = parsed
      sub(/^[^:]*:/, "", parsed_value)
      sub(/\n$/, "", parsed_value)
      if (parent_is_root && key == "userDataRoot") {
        seen = 1
        kind = parsed_kind
        value = parsed_value
      }
    }
    END {
      if (fail || !seen || kind != "string" || value == "") exit 0
      print value
    }
  ' "$config" 2>/dev/null || true
}

default_user_data_root() {
  if [ -n "${LANDO_USER_DATA_ROOT:-}" ]; then
    printf '%s\n' "$LANDO_USER_DATA_ROOT"
    return
  fi
  configured=$(read_config_user_data_root "$(resolve_config_file_root)")
  if [ -n "$configured" ]; then
    printf '%s\n' "$configured"
    return
  fi
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    printf '%s\n' "${XDG_DATA_HOME}/lando"
  else
    printf '%s\n' "${HOME:-.}/.local/share/lando"
  fi
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

print_path_guidance() {
  user_data_root=$(default_user_data_root)
  printf '\nRun this command to add Lando to PATH:\n'
  printf 'eval "$("%s/lando" shellenv)"\n' "$install_dir"
  printf 'The command prints:\n'
  printf 'export LANDO_USER_DATA_ROOT=%s\n' "$(posix_quote "$user_data_root")"
  printf 'export PATH="${LANDO_USER_DATA_ROOT}/bin:${PATH}"\n'
}

print_setup_skipped() {
  printf 'post-install setup: skipped\n'
  printf 'Run setup later with: "%s/lando" setup\n' "$install_dir"
}

run_post_install_setup() {
  if [ "${LANDO_INSTALL_RUN_SETUP:-}" = "1" ]; then
    "$install_dir/lando" setup --yes
    printf 'post-install setup: completed\n'
    return
  fi

  if [ "${LANDO_INSTALL_SKIP_SETUP:-}" = "1" ] || [ "${LANDO_INSTALL_NONINTERACTIVE:-}" = "1" ] || [ ! -t 0 ]; then
    print_setup_skipped
    return
  fi

  printf 'Run lando setup now? [y/N] ' >&2
  read -r answer || answer=
  case "$answer" in
    y|Y|yes|YES)
      "$install_dir/lando" setup --yes
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
  case "${LANDO_INSTALL_OS:-$(uname -s)}" in
    Darwin)
      need shasum
      actual=$(shasum -a 256 "$binary" | awk '{ print $1 }')
      ;;
    *)
      need sha256sum
      actual=$(sha256sum "$binary" | awk '{ print $1 }')
      ;;
  esac
  [ "$actual" = "$expected" ] || fail "Checksum mismatch for $artifact"
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

platform=$(detect_platform)
base_url=${LANDO_INSTALL_BASE_URL:-https://update.lando.dev/v4}
manifest_url=${LANDO_INSTALL_MANIFEST_URL:-${base_url%/}/$channel.json}
install_dir=$(default_install_dir)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

manifest=$tmp/manifest.json
sums=$tmp/SHA256SUMS
binary=$tmp/lando

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
cp "$binary" "$install_dir/lando"
chmod 0755 "$install_dir/lando"

printf 'channel: %s\n' "$channel"
printf 'platform: %s\n' "$platform"
printf 'installed: %s\n' "$install_dir/lando"
print_path_guidance
run_post_install_setup
