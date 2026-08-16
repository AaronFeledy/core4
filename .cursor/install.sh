#!/usr/bin/env bash
# Cloud Agent bootstrap for the Lando v4 (core4) Bun monorepo.
#
# Idempotent: safe to run repeatedly and against cached/partial state. It only
# installs what is missing, then refreshes workspace dependencies and generated
# sources from the checked-out revision.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# Pinned Bun version is the single source of truth for the toolchain.
BUN_VERSION="$(tr -d '[:space:]' < "${REPO_ROOT}/.bun-version")"
export BUN_INSTALL="${HOME}/.bun"
export PATH="${BUN_INSTALL}/bin:${PATH}"

install_bun() {
  if command -v bun >/dev/null 2>&1 && [ "$(bun --version)" = "${BUN_VERSION}" ]; then
    echo "[install] bun ${BUN_VERSION} already present"
  else
    echo "[install] installing bun ${BUN_VERSION}"
    curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
  fi
  # Expose bun on the default PATH for every (non-login) lifecycle shell.
  sudo ln -sf "${BUN_INSTALL}/bin/bun" /usr/local/bin/bun
  sudo ln -sf "${BUN_INSTALL}/bin/bun" /usr/local/bin/bunx
}

install_powershell() {
  # The Windows installer test suite (core/test/scripts/install-windows.test.ts)
  # shells out to `pwsh`; install it so `bun run test:unit` is fully green.
  if command -v pwsh >/dev/null 2>&1; then
    echo "[install] pwsh already present ($(pwsh --version))"
    return
  fi
  echo "[install] installing PowerShell (pwsh)"
  . /etc/os-release
  sudo apt-get update -qq
  sudo apt-get install -y -qq wget apt-transport-https ca-certificates >/dev/null
  local deb="/tmp/packages-microsoft-prod.deb"
  wget -q "https://packages.microsoft.com/config/ubuntu/${VERSION_ID}/packages-microsoft-prod.deb" -O "${deb}"
  sudo dpkg -i "${deb}" >/dev/null 2>&1 || true
  sudo apt-get update -qq
  sudo apt-get install -y -qq powershell >/dev/null 2>&1
  rm -f "${deb}"
}

install_bun
install_powershell

echo "[install] bun install --frozen-lockfile"
bun install --frozen-lockfile

echo "[install] bun run codegen"
bun run codegen

echo "[install] done: bun $(bun --version), pwsh $(pwsh --version 2>/dev/null || echo 'n/a')"
