import { Effect } from "effect";

import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";

export interface IptablesForwardReaders {
  readonly readIptablesLegacyForward: () => Promise<string | undefined>;
  readonly readIptablesNftForward: () => Promise<string | undefined>;
}

const runCommand = async (command: string, args: string[]): Promise<string | undefined> => {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output;
  } catch {
    return undefined;
  }
};

const readIptablesLegacyForward = async (): Promise<string | undefined> => {
  return await runCommand("iptables-legacy", ["-L", "FORWARD", "-n", "-v"]);
};

const readIptablesNftForward = async (): Promise<string | undefined> => {
  return await runCommand("iptables-nft", ["-L", "FORWARD", "-n", "-v"]);
};

const systemReaders: IptablesForwardReaders = {
  readIptablesLegacyForward,
  readIptablesNftForward,
};

const optionalRead = (read: () => Promise<string | undefined>): Effect.Effect<string | undefined, never> =>
  Effect.tryPromise({ try: read, catch: () => undefined }).pipe(
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

const hasDropPolicy = (output: string | undefined): boolean => {
  if (output === undefined) return false;
  // Check for "Chain FORWARD (policy DROP" or similar
  return /Chain FORWARD \(policy DROP/iu.test(output);
};

const hasDockerRules = (output: string | undefined): boolean => {
  if (output === undefined) return false;
  // Check for docker or lando network rules
  return /docker0|br-|lando/iu.test(output);
};

export const makeIptablesForwardCheck = (
  readers: IptablesForwardReaders = systemReaders,
): PluginDoctorCheckContribution => ({
  id: "docker-iptables-forward-mixed",
  run: (input) =>
    Effect.gen(function* () {
      // Only check on Linux (not WSL, not macOS, not Windows)
      if (input.platform === "wsl" || input.platform === "darwin" || input.platform === "win32") return [];
      if (input.platform !== "linux") return [];

      const legacyOutput = yield* optionalRead(readers.readIptablesLegacyForward);
      const nftOutput = yield* optionalRead(readers.readIptablesNftForward);

      // Check if iptables-legacy has DROP policy and no lando rules
      const legacyHasDropPolicy = hasDropPolicy(legacyOutput);
      const legacyHasLandoRules = hasDockerRules(legacyOutput);
      const nftHasLandoRules = hasDockerRules(nftOutput);

      // Problem: legacy has DROP policy, legacy doesn't have lando rules, but nft does
      // This means Docker is programming nft but packets hit legacy first
      if (legacyHasDropPolicy && !legacyHasLandoRules && nftHasLandoRules) {
        const report = {
          name: "docker-iptables-forward-mixed",
          status: "warn",
          severity: "warn",
          runtimeStatus: "mixed iptables-legacy and iptables-nft detected",
          context: {
            platform: "linux",
            legacyPolicy: "DROP",
            issue: "iptables-legacy FORWARD policy blocks Docker networking",
          },
          solutions: [
            {
              kind: "manual",
              description:
                "Set iptables-legacy FORWARD policy to ACCEPT for the current session. This allows Docker container networking to work.",
              command: "sudo iptables-legacy -P FORWARD ACCEPT",
            },
            {
              kind: "manual",
              description:
                "Persist the setting by adding iptables-legacy rules to your firewall configuration, or switch to using only iptables-nft across the system.",
            },
          ],
        } satisfies PluginDoctorReport;

        return [report];
      }

      return [];
    }),
});
