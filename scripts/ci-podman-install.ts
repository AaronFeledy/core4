/**
 * Shared Podman 6 provisioning for generated Linux CI jobs.
 *
 * Ubuntu 24.04 apt ships Podman 4.9.x with Netavark/Aardvark 1.4, and the OBS
 * Kubic xUbuntu_24.04 repository does not publish Podman 6 packages yet, so
 * neither satisfies the Podman >= 6.0.0 host contract. CI installs the
 * Homebrew `podman` formula instead: it ships Podman 6 with Netavark v2 and
 * Aardvark-dns v2 staged in its helper directory and passt/pasta, crun,
 * conmon, and fuse-overlayfs as dependencies. Revisit this choice when a
 * native Ubuntu package line publishes Podman 6 (open packaging question).
 *
 * Every job that starts a Podman service or runs `lando setup` must run the
 * assert step first so a runner with a stale Podman fails fast with
 * remediation instead of failing deep inside provider tests.
 */

export const CI_MINIMUM_PODMAN_VERSION = "6.0.0";

/**
 * Asserts `podman --version` satisfies the floor. Comparison is numeric over
 * major.minor.patch; pre-release/build suffixes are ignored; unparseable or
 * missing output fails closed with remediation in the job log.
 */
export const podmanVersionAssertScript = `MINIMUM="${CI_MINIMUM_PODMAN_VERSION}"
version_output="$(podman --version 2>/dev/null || true)"
numbers="$(printf '%s\\n' "$version_output" | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"
remediation="Install Podman >= $MINIMUM (Homebrew formula: podman) before Podman-backed CI runs."
if test -z "$numbers"; then
  echo "::error title=podman6-contract::Could not parse a Podman version from '\${version_output:-<no podman on PATH>}'. $remediation"
  exit 1
fi
major="\${numbers%%.*}"
minor_patch="\${numbers#*.}"
minor="\${minor_patch%%.*}"
patch="\${minor_patch#*.}"
floor_major="\${MINIMUM%%.*}"
floor_minor_patch="\${MINIMUM#*.}"
floor_minor="\${floor_minor_patch%%.*}"
floor_patch="\${floor_minor_patch#*.}"
observed=$((major * 1000000 + minor * 1000 + patch))
floor=$((floor_major * 1000000 + floor_minor * 1000 + floor_patch))
if test "$observed" -lt "$floor"; then
  echo "::error title=podman6-contract::Podman $numbers (from '$version_output') does not satisfy the >= $MINIMUM host contract. $remediation"
  exit 1
fi
echo "podman6-contract: $numbers satisfies >= $MINIMUM"`;

/**
 * Installs the Podman 6 toolchain on an Ubuntu runner via Homebrew, exposes
 * it to later steps through GITHUB_PATH/GITHUB_ENV, and seeds the minimal
 * /etc/containers policy and registries configuration the distro package
 * would otherwise have provided.
 */
const installPodman6Script = `sudo apt-get update
sudo apt-get install -y uidmap fuse-overlayfs
if ! command -v brew >/dev/null 2>&1; then
  test -x /home/linuxbrew/.linuxbrew/bin/brew
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
fi
brew install podman
BREW_PREFIX="$(brew --prefix)"
echo "$BREW_PREFIX/bin" >> "$GITHUB_PATH"
echo "LANDO_CI_PODMAN_HELPER_DIR=$BREW_PREFIX/opt/podman/libexec/podman" >> "$GITHUB_ENV"
sudo mkdir -p /etc/containers
if ! test -f /etc/containers/policy.json; then
  printf '{"default":[{"type":"insecureAcceptAnything"}]}\\n' | sudo tee /etc/containers/policy.json >/dev/null
fi
if ! grep -qs unqualified-search-registries /etc/containers/registries.conf; then
  printf 'unqualified-search-registries = ["docker.io"]\\n' | sudo tee -a /etc/containers/registries.conf >/dev/null
fi
# A system-level storage.conf left behind by a distro podman install pins the
# rootful runroot/graphroot, which Podman 6 honors literally for rootless
# users. Seed a rootless-safe user-level storage.conf so the default service
# always resolves user paths.
mkdir -p "$HOME/.config/containers"
if ! test -f "$HOME/.config/containers/storage.conf"; then
  printf '[storage]\\ndriver = "overlay"\\nrunroot = "%s"\\ngraphroot = "%s"\\n' \\
    "\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/containers" \\
    "$HOME/.local/share/containers/storage" > "$HOME/.config/containers/storage.conf"
fi
podman --version`;

const indentBlock = (script: string, indent: string): string =>
  script
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${indent}${line}`))
    .join("\n");

interface StepOptions {
  /** Raw workflow `if:` expression (without surrounding `\${{ }}`). */
  readonly condition?: string;
}

const renderStep = (name: string, script: string, options: StepOptions = {}): string => {
  const conditionLine = options.condition === undefined ? "" : `        if: \${{ ${options.condition} }}\n`;
  return `      - name: ${name}
${conditionLine}        run: |
${indentBlock(script, "          ")}`;
};

/**
 * Homebrew-based Podman 6 install step. Ubuntu/OBS packaging is explicitly
 * not used until a native Podman 6 package line exists for Ubuntu 24.04.
 */
export const renderInstallPodman6Step = (options: StepOptions = {}): string =>
  renderStep(
    "Install Podman 6 toolchain (Homebrew; Ubuntu/OBS lack Podman 6)",
    installPodman6Script,
    options,
  );

/** Fail-fast host-contract assertion; must precede any Podman-backed step. */
export const renderAssertPodman6Step = (options: StepOptions = {}): string =>
  renderStep("Assert Podman 6 host contract", podmanVersionAssertScript, options);
