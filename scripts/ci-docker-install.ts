/**
 * Unpinned Docker CE install for the provider-matrix Docker Engine latest cell.
 *
 * GitHub-hosted ubuntu-24.04 ships Docker 28.x, which cannot reproduce Engine
 * 29.6+ exec umask inheritance. This cell installs docker-ce from Docker's apt
 * repo without a version pin so the matrix tracks current Engine.
 */

const installDockerCeScript = `sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
test -S /var/run/docker.sock`;

const indentBlock = (script: string, indent: string): string =>
  script
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${indent}${line}`))
    .join("\n");

interface StepOptions {
  readonly condition?: string;
}

export const renderInstallDockerCeLatestStep = (options: StepOptions = {}): string => {
  const conditionLine = options.condition === undefined ? "" : `        if: \${{ ${options.condition} }}\n`;
  return `      - name: Install unpinned Docker CE from Docker apt repo
${conditionLine}        run: |
${indentBlock(installDockerCeScript, "          ")}`;
};
