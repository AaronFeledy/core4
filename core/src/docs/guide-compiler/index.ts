/** Guide authoring compiler surface shared by generation and docs presentation. */
export { firstYaml, parseFrontmatter, processor, propsOf } from "./mdx.ts";
export { parseGuideRoot, parseGuideScenarioAst } from "./parser.ts";
export { projectGuidePresentation } from "./presentation.ts";
export type { GuidePresentation, PresentationContext } from "./presentation.ts";
