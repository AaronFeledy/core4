export const HUGO_BUILD_ARTIFACT = [
  "apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar gzip && rm -rf /var/lib/apt/lists/*",
  [
    "set -eu",
    `case "$(dpkg --print-architecture)" in amd64) arch=amd64; checksum=0163f5c3deddac1f494a1629ddc40c65d18de9d5794facd98f7f96ac2c7d8957 ;; arm64) arch=arm64; checksum=c73eaba13738754b50de4d07606670d5c0cd2eaaf2057af657cec9efd3b01876 ;; *) printf '%s\\n' 'Unsupported Hugo Linux architecture' >&2; exit 1 ;; esac`,
    'archive="hugo_extended_0.167.0_linux-$arch.tar.gz"',
    'work="$(mktemp -d)"',
    `trap 'rm -rf "$work"' EXIT`,
    `curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "https://github.com/gohugoio/hugo/releases/download/v0.167.0/$archive" -o "$work/$archive"`,
    `printf '%s  %s\\n' "$checksum" "$work/$archive" | sha256sum --check --strict -`,
    'tar -xzf "$work/$archive" -C "$work" hugo',
    'install -m 0755 "$work/hugo" /usr/local/bin/hugo',
    "hugo version",
  ].join("; "),
] as const;
