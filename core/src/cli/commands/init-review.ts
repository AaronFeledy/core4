import { RedactionService } from "@lando/redaction/service";
import { REMEDY_ARROW, resolveSummaryWidth, wrapToWidth } from "@lando/renderer/console-layout";
import { formatQuietSummary } from "@lando/renderer/summary";
import { InteractionCancelledError } from "@lando/sdk/errors";
import { ConfigService, InteractionService, Renderer } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import type { RecipeInitReview } from "../../recipes/prepared-init";
import { type ResultFormat, isEnvelopeResultFormat } from "../format-flags";
import type { InitAppOptions } from "./init-options";
import type { InitReviewRoutes } from "./init-review-routes";

export const initUsesMachineOutput = (format: ResultFormat, rendererId: string): boolean =>
  rendererId === "json" || isEnvelopeResultFormat(format) || format === "ndjson";

const routeNotes = (routes: InitReviewRoutes): readonly string[] => {
  switch (routes.status) {
    case "candidate":
      return ["Provisional configured URLs; reachability and router ports are not verified."];
    case "none":
      return ["No explicit URL is determined by this configuration; routes may be supplied at startup."];
    case "unresolved":
      return ["Configured URLs depend on unresolved configuration."];
    case "disabled":
      return ["Routing is disabled by configuration."];
    case "unavailable":
      return ["Configured URLs are unavailable without the invocation's configuration context."];
    default:
      return routes.status satisfies never;
  }
};

export const renderInitReview = (input: {
  readonly review: RecipeInitReview;
  readonly routes: InitReviewRoutes;
  readonly decorated: boolean;
  readonly columns?: number;
  readonly redact: (value: string) => string;
}): string => {
  const { review, routes, redact } = input;
  const header = input.decorated
    ? formatQuietSummary(
        { title: `Initialize ${review.appName}`, sections: [] },
        { columns: input.columns, redact },
      )
    : redact(`Initialize ${review.appName}`);
  // Paths and commands bypass prose wrapping: significant spaces and copyable bytes survive.
  const lines = [
    header,
    "",
    "Destination",
    `  ${redact(review.appRoot)}`,
    "",
    "Will write",
    ...review.outputs.map(({ destination }) => `  ${redact(destination)}`),
  ];
  if (review.skippedScaffold.length > 0) {
    lines.push(
      "",
      "Scaffold withheld; existing files stay unchanged",
      ...review.skippedScaffold.map((path) => `  ${redact(path)}`),
      "  Only the Landofile will be created; executable post-init actions are withheld.",
    );
  }
  lines.push(
    "",
    "Services",
    ...routes.services.map(
      ({ name, type }) => `  ${redact(name)}${type === undefined ? "" : `  ${redact(type)}`}`,
    ),
  );
  if (routes.services.length === 0) lines.push("  No concrete service declarations to display.");
  lines.push(
    "",
    "Configured URL candidates",
    ...routes.candidates.map(({ service, url }) => `  ${redact(service)}  ${redact(url)}`),
    ...routeNotes(routes).map((note) => `  ${note}`),
  );
  if (routes.status === "candidate" && routes.unresolved > 0)
    lines.push(`  ${routes.unresolved} additional route declaration(s) remain unresolved.`);
  if (routes.truncated) lines.push("  Preview limit reached; additional declarations are not shown.");
  const executable = review.actions.filter(({ type, authorized }) => type !== "message" && authorized).length;
  if (executable > 0) lines.push("", `After writing: ${executable} authorized post-init action(s).`);
  if (review.diagnostics.length > 0) {
    const width = resolveSummaryWidth(input.columns);
    lines.push("", "Preparation notes");
    for (const diagnostic of review.diagnostics) {
      lines.push(...wrapToWidth(redact(diagnostic.message), width - 2).map((line) => `  ${line}`));
      const remediation =
        diagnostic.remediation ?? "After initialization, review .lando.yml with lando app:config.";
      const [first, ...rest] = wrapToWidth(redact(remediation), width - 4);
      lines.push(`  ${REMEDY_ARROW}${first ?? ""}`, ...rest.map((line) => `    ${line}`));
    }
  }
  return `${lines.join("\n")}\n\n`;
};

const cancelled = () =>
  new InteractionCancelledError({
    message: "Initialization cancelled before writing files.",
    remediation: "Choose a different destination or re-run init when ready.",
  });

export const makeInitReview = Effect.fnUntraced(function* (input: {
  readonly format: ResultFormat;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly columns?: number;
}): Effect.fn.Return<InitAppOptions["onPrepared"], never, Renderer | RedactionService | InteractionService> {
  const renderer = yield* Renderer;
  if (input.yes || input.nonInteractive || initUsesMachineOutput(input.format, renderer.id)) return undefined;
  const interaction = yield* InteractionService;
  if (!(yield* interaction.isInteractive)) return undefined;
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
  const config = yield* Effect.serviceOption(ConfigService);
  const onPrepared: NonNullable<InitAppOptions["onPrepared"]> = async (review, context) => {
    if (context.signal?.aborted) throw cancelled();
    const snapshot = Option.isSome(config)
      ? await Effect.runPromise(
          config.value.load,
          context.signal === undefined ? undefined : { signal: context.signal },
        )
      : undefined;
    if (context.signal?.aborted) throw cancelled();
    const { projectInitReviewRoutes } = await import("./init-review-routes");
    const routes = projectInitReviewRoutes(review, snapshot);
    await Effect.runPromise(
      renderer.output.stderr(
        renderInitReview({
          review,
          routes,
          decorated: renderer.id === "lando" && renderer.capabilities.color,
          ...(input.columns === undefined ? {} : { columns: input.columns }),
          redact: redactor.redactString,
        }),
      ),
      context.signal === undefined ? undefined : { signal: context.signal },
    );
    if (review.skippedScaffold.length > 0) {
      const proceed = await context.interaction.confirm({
        name: "init-reduced-scaffold",
        message: "Create only the Landofile?",
        default: false,
        mode: "interactive",
      });
      if (!proceed) throw cancelled();
    }
    if (context.signal?.aborted) throw cancelled();
  };
  return onPrepared;
});

export const renderInitReviewNext = (directory: string): string =>
  `Next\n  In this directory:\n  ${directory}\n  Inspect the generated configuration:\n  lando app:config`;
