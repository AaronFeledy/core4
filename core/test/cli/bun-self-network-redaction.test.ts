import { expect, test } from "bun:test";
import { RedactionService, makeRedactionOwner } from "@lando/redaction/service";
import { Effect } from "effect";
import { bunSelfRun } from "../../src/cli/commands/bun-self-runner";
import { withProcess } from "../_support/process-runner";

test.each([false, true])(
  "projected proxy credentials are masked before child observation with runtime service %s",
  async (registered) => {
    const owner = makeRedactionOwner();
    const password = "projected-proxy-credential-canary";
    const effect = bunSelfRun({
      argv: ["install"],
      output: "quiet",
      networkPlan: {
        trustHost: true,
        caCertPaths: [],
        proxy: { https: `http://proxy-user:${password}@proxy.invalid:8080`, noProxy: [] },
      },
    }).pipe(
      withProcess(async () => {
        if (registered) {
          const redactor = await Effect.runPromise(owner.service.forProfile("secrets"));
          expect(redactor.redactString(password)).not.toContain(password);
        }
        return { exitCode: 1, stderr: `Connection failed: ${password}` };
      }),
    );
    try {
      const result = await Effect.runPromise(
        registered ? effect.pipe(Effect.provideService(RedactionService, owner.service)) : effect,
      );
      expect(result.mode).toBe("collected");
      expect(JSON.stringify(result)).not.toContain(password);
    } finally {
      owner.dispose();
    }
  },
);
