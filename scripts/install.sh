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

default_install_dir() {
  if [ -n "${LANDO_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$LANDO_INSTALL_DIR"
    return
  fi

  os=${LANDO_INSTALL_OS:-$(uname -s)}
  case "$os" in
    Darwin) printf '%s\n' "$HOME/Library/Application Support/Lando/bin" ;;
    *) printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/lando/bin" ;;
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
  expected=$(awk -v artifact="$artifact" '($2 == artifact || $2 == "./" artifact || $2 == "dist/" artifact) { print $1; exit }' "$sums")
  [ -n "$expected" ] || fail "Checksum manifest does not contain $artifact"
  actual=$(sha256sum "$binary" | awk '{ print $1 }')
  [ "$actual" = "$expected" ] || fail "Checksum mismatch for $artifact"
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
need sha256sum
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
signature=$tmp/SHA256SUMS.sig
binary=$tmp/lando

download "$manifest_url" "$manifest"
binary_url=$(manifest_binary_field "$manifest" "$platform" "url")
sums_url=$(manifest_checksum_field "$manifest" "url")
signature_url=$(manifest_checksum_field "$manifest" "signature")
artifact=$(basename_from_url "$binary_url")

download "$binary_url" "$binary"
download "$sums_url" "$sums"
download "$signature_url" "$signature"

gpg=${LANDO_INSTALL_GPG:-gpg}
"$gpg" --batch --verify "$signature" "$sums" >/dev/null 2>&1 || fail "Signature verification failed for SHA256SUMS"
verify_checksum "$sums" "$binary" "$artifact"

mkdir -p "$install_dir"
cp "$binary" "$install_dir/lando"
chmod 0755 "$install_dir/lando"

printf 'channel: %s\n' "$channel"
printf 'platform: %s\n' "$platform"
printf 'installed: %s\n' "$install_dir/lando"
