export {
  GuideFrontmatter,
  GuideId,
  decodeGuideFrontmatter,
  decodeGuideFrontmatterEither,
} from "../docs/guide-frontmatter.ts";
export { DeprecationNotice, DeprecationSeverity, structuralDeprecationKey } from "./deprecation.ts";
export type { StructuralDeprecationKey } from "./deprecation.ts";
export {
  CleanupProps,
  GuideProps,
  HiddenProps,
  InlineProps,
  InspectProps,
  MatcherAnyOf,
  MatcherNot,
  MatcherPartialObject,
  MatcherRegex,
  MatcherScalar,
  MatcherSchema,
  MatcherSchemaRef,
  RunProps,
  ScenarioProps,
  SkipProps,
  StepProps,
  TabProps,
  TabsProps,
  UseFixtureProps,
  VariableProps,
  VerifyProps,
} from "../docs/components/props.ts";
export {
  PublicTranscript,
  PublicTranscriptFrame,
  Transcript,
  TranscriptCleanupFrame,
  TranscriptFixtureFrame,
  TranscriptFrame,
  TranscriptInlineFrame,
  TranscriptInspectFrame,
  TranscriptRunFrame,
  TranscriptVerifyFrame,
} from "../docs/transcript.ts";
