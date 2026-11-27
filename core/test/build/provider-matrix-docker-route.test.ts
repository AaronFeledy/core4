import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProviderMatrixWorkflow } from "../../../scripts/build-provider-matrix-workflow.ts";

test.skipIf(process.platform === "win32" || Bun.which("jq") === null)(
  "Docker fallback smoke probes the exact active route at the reported port",
  async () => {
    const smokeStep = renderProviderMatrixWorkflow().match(
      /- name: Start routed Docker fixture and curl through the router\n.*\n {8}run: \|\n((?: {10}.*\n)+)/u,
    )?.[1];
    if (smokeStep === undefined) throw new Error("Missing Docker fallback smoke step");
    const root = await mkdtemp(join(tmpdir(), "lando-docker-smoke-"));
    try {
      const hostname = "docker-fallback.lndo.site";
      const route = {
        host: hostname,
        binding: "assigned",
        state: "active",
        hostMatch: "exact",
        protocol: "https",
        url: `https://${hostname}:8443/docs`,
        port: 8443,
      };
      const input = {
        result: {
          services: [
            { service: "other", routes: [{ ...route, port: 7443, url: `https://${hostname}:7443` }] },
            {
              service: "web",
              routes: [
                { ...route, state: "inactive", url: `https://${hostname}:9443`, port: 9443 },
                { ...route, hostMatch: "pattern", url: undefined },
                { ...route, host: `other.${hostname}`, url: `https://other.${hostname}:8443` },
                route,
              ],
            },
          ],
        },
      };
      await Bun.write(join(root, "info.json"), JSON.stringify(input));
      const script = `
        bun() {
          case "$2" in
            start) return 0 ;;
            info) cat "$RUNNER_TEMP/info.json" ;;
            *) command bun "$@" ;;
          esac
        }
        curl() {
          printf '%s\\n' "\${@: -2}" > "$RUNNER_TEMP/probe-arguments"
          printf '%s\\n' 'Welcome to nginx!'
        }
        ${smokeStep}
      `;
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
        env: { ...process.env, GITHUB_WORKSPACE: root, RUNNER_TEMP: root },
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(root, "probe-arguments")).text()).toBe(
        `${hostname}:8443:127.0.0.1\nhttps://${hostname}:8443/docs\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
