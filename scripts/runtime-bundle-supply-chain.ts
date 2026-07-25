export const RUNTIME_BUNDLE_ACTION_PINS = {
  checkout: "actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955",
  downloadArtifact: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  rustToolchain: "dtolnay/rust-toolchain@4e529fb27e59237866a6523e61ab248308c068b4",
  setupBun: "oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76",
  setupGo: "actions/setup-go@d35c59abb061a4a6fb18e82ac0862c26744d6ab5",
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  uploadArtifact: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
} as const;

export const RUNTIME_BUNDLE_UBUNTU_SNAPSHOT = "20260701T000000Z";

export const RUNTIME_BUNDLE_UBUNTU_PREREQUISITE_SCRIPT = [
  "set -euo pipefail",
  `UBUNTU_SNAPSHOT=${RUNTIME_BUNDLE_UBUNTU_SNAPSHOT}`,
  `printf 'APT::Snapshot "%s";\\n' "$UBUNTU_SNAPSHOT" | sudo tee /etc/apt/apt.conf.d/50lando-runtime-bundle-snapshot`,
  "sudo apt-get update",
  "PACKAGES=(build-essential libbtrfs-dev libcap-dev libdevmapper-dev libglib2.0-dev libseccomp-dev libsqlite3-dev libsystemd-dev patch pkg-config protobuf-compiler uidmap)",
  'sudo apt-get install -y --no-install-recommends --allow-downgrades --reinstall "${PACKAGES[@]}"',
  'for PACKAGE in "${PACKAGES[@]}"; do',
  `  INSTALLED_VERSION="$(dpkg-query -W -f='\${Version}' "$PACKAGE")"`,
  '  POLICY="$(apt-cache policy "$PACKAGE")"',
  `  CANDIDATE_VERSION="$(awk '/Candidate:/ { print $2 }' <<< "$POLICY")"`,
  '  test "$INSTALLED_VERSION" = "$CANDIDATE_VERSION"',
  `  if ! awk -v candidate="$CANDIDATE_VERSION" -v snapshot="https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT" '`,
  '    $1 == "***" && $2 == candidate { candidate_block = 1; next }',
  "    candidate_block && $1 ~ /^[0-9]+$/ { if ($2 == snapshot) found = 1; next }",
  "    candidate_block { candidate_block = 0 }",
  "    END { exit found ? 0 : 1 }",
  `  ' <<< "$POLICY"; then`,
  '    echo "::error title=runtime-bundle-apt-snapshot::$PACKAGE candidate $CANDIDATE_VERSION did not resolve from Ubuntu snapshot $UBUNTU_SNAPSHOT"',
  "    exit 1",
  "  fi",
  "done",
].join("\n          ");
