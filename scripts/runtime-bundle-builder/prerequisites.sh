#!/bin/bash
set -euo pipefail
UBUNTU_SNAPSHOT=20261019T000000Z
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
cat > /etc/apt/sources.list.d/runtime-bundle.sources <<EOF
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT/
Suites: noble noble-updates noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Check-Valid-Until: no
EOF
printf 'Acquire::Retries "3";\n' > /etc/apt/apt.conf.d/50lando-runtime-bundle-snapshot
for DELAY in 0 5 15 45; do
  if [ "$DELAY" -gt 0 ]; then sleep "$DELAY"; fi
  if apt-get update --error-on=any; then break; fi
  if [ "$DELAY" -eq 45 ]; then
    echo "::error title=runtime-bundle-apt-snapshot::Failed to update Ubuntu snapshot $UBUNTU_SNAPSHOT indexes after 4 attempts"
    exit 1
  fi
done
PACKAGES=(build-essential ca-certificates libbtrfs-dev libcap-dev libdevmapper-dev libglib2.0-dev libseccomp-dev libsqlite3-dev libsystemd-dev patch pkg-config protobuf-compiler uidmap unzip xz-utils)
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${PACKAGES[@]}"
for PACKAGE in "${PACKAGES[@]}"; do
  INSTALLED_VERSION="$(dpkg-query -W -f='${Version}' "$PACKAGE")"
  POLICY="$(apt-cache policy "$PACKAGE")"
  CANDIDATE_VERSION="$(awk '/Candidate:/ { print $2 }' <<< "$POLICY")"
  test "$INSTALLED_VERSION" = "$CANDIDATE_VERSION"
  if ! awk -v candidate="$CANDIDATE_VERSION" -v snapshot="https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT" '
    $1 == "***" && $2 == candidate { candidate_block = 1; next }
    candidate_block && $1 ~ /^[0-9]+$/ { if ($2 == snapshot) found = 1; next }
    candidate_block { candidate_block = 0 }
    END { exit found ? 0 : 1 }
  ' <<< "$POLICY"; then
    echo "::error title=runtime-bundle-apt-snapshot::$PACKAGE candidate $CANDIDATE_VERSION did not resolve from Ubuntu snapshot $UBUNTU_SNAPSHOT"
    exit 1
  fi
done
rm -rf /var/lib/apt/lists/*
