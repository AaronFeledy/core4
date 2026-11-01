import { Effect } from "effect";
import type { NpmCredential } from "../../recipes/npm-credentials";
import { type BunSelfRunOptions, bunSelfRun } from "./bun-self-runner";
import { npmPublishRemoveEnv, publishRegistryConfig } from "./npm-publish-config";

export const publishWithCredential = Effect.fn("NpmPublishRunner.publish")(function* (
  credential: NpmCredential,
  target: { readonly registry: string; readonly packageName: string; readonly tag: string },
  options: Omit<BunSelfRunOptions, "argv" | "env" | "removeEnv">,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const config = yield* publishRegistryConfig(target.registry, target.packageName, credential.kind);
      let argv: readonly string[];
      let env: Readonly<Record<string, string>>;
      switch (credential.kind) {
        case "bearer":
          argv = ["publish", `--config=${config}`, "--tag", target.tag, "--registry", target.registry];
          env = { BUN_CONFIG_TOKEN: credential.token };
          break;
        case "basic": {
          argv = ["publish", `--config=${config}`, "--tag", target.tag];
          env = {
            LANDO_NPM_BASIC_USERNAME: credential.username,
            LANDO_NPM_BASIC_PASSWORD: credential.password,
          };
          break;
        }
        default:
          return credential satisfies never;
      }
      return yield* bunSelfRun({
        ...options,
        argv,
        env,
        removeEnv: npmPublishRemoveEnv.filter((key) => !Object.hasOwn(env, key)),
      });
    }),
  );
});
