export const RUNTIME_BUNDLE_ACTION_PINS = {
  checkout: "actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8",
  downloadArtifact: "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
  rustToolchain: "dtolnay/rust-toolchain@4e529fb27e59237866a6523e61ab248308c068b4",
  setupBun: "oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76",
  setupGo: "actions/setup-go@d35c59abb061a4a6fb18e82ac0862c26744d6ab5",
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  uploadArtifact: "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
} as const;

export const RUNTIME_BUNDLE_UBUNTU_SNAPSHOT = "20260801T000000Z";

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
