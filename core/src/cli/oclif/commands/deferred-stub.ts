import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandNamespace, type LandoCommandSpec } from "../command-base.ts";

interface DeferredStubInput {
  readonly id: string;
  readonly summary: string;
}

const namespaceFor = (commandId: string): LandoCommandNamespace => {
  const head = commandId.split(":", 1)[0] ?? "";
  if (head === "app" || head === "apps" || head === "meta") return head;
  throw new Error(`Deferred-stub command id must start with app|apps|meta: got ${commandId}`);
};

export const makeDeferredStubCommand = (input: DeferredStubInput): typeof LandoCommandBase => {
  const spec: LandoCommandSpec<never> = {
    id: input.id,
    summary: input.summary,
    namespace: namespaceFor(input.id),
    bootstrap: "minimal",
    run: () => Effect.die(`not yet implemented: ${input.id}`),
  };

  return class extends LandoCommandBase {
    static override description = spec.summary;
    static override landoSpec: LandoCommandSpec = spec;
    static override bootstrap = spec.bootstrap;

    override async run(): Promise<void> {
      await this.runEffect(spec);
    }
  };
};
