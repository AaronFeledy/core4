# Documentation acceptance review

Use this checklist with [SKILL.md](SKILL.md). Check technical truth and the reader's experience separately. Build/link/lint success does not prove the page is usable or factually complete.

## Technical pass

- Verify commands, paths, flags, versions, defaults, and side effects against sources. Record the revision reviewed.
- Run the applicable docs checks and safe examples when authorized and feasible. Use the verification commands in [SKILL.md](SKILL.md#verification) and applicable repository instructions.
- Never run destructive, account-changing, costly, or production actions just to validate prose without authorization.
- Distinguish tested behavior, source-reviewed behavior, expected output, and unverified assumptions. Never invent a successful transcript.
- Check generated-reference ownership. Update authoritative metadata/templates and regenerate only within scope; report sources outside scope.
- Check public URLs, anchors, identifiers, navigation, and relative links before changing them.

### Repository requirements

- [ ] Transcripts are real isolated-home captures, or the page does not claim captured output. No placeholder stdout, empty `<Inspect output />`, or `TODO: capture` on a user page.
- [ ] No hand-edits to generated reference output, `dist/transcripts/**`, or `test/scenarios/generated/**`.
- [ ] No Traefik-by-hand; default provider is `lando` (managed Podman), with documented platform exceptions and supported Docker fallback preserved.
- [ ] No leftover Lando 3 product facts; no CI/NDJSON/`LANDO_TEST_*`/job-name leaks on user pages.
- [ ] Readiness/support limits, published runtime-bundle facts, and recipe README/scaffold ownership are preserved.
- [ ] If executable: prose survives stripping JSX; no vars-only scenarios, sentence-valued component props, or shell fences inside scenarios; fixtures are referenced and relevant gates pass.
- [ ] A guide has one `<Guide>` element containing all scenarios. Confirm the scenario count; focused tests require success and a positive test count.
- [ ] Object-valued guide props contain no single quotes in strings/regexes. Boxed TTY command output is asserted through `--format=json`.
- [ ] Scenarios use isolated resources, hold on a host with Lando already installed, and never run destructive commands.
- [ ] If owned: PRD `## Guide Coverage`, `Shipped` INDEX row, coverage/transcript/drift checks, and any required static-test phrases remain correct.

## Editorial pass

- Read the page as the stated reader, without relying on your implementation knowledge.
- At each instruction ask: "What must I already know? What do I do? Where? How will I know it worked?"
- Read only the title, opening, and headings. Is the reader's route clear?
- Read the explanatory prose without decorative components. Does it still make sense?
- Remove details that interrupt this reader's goal, but retain prerequisites and safety information.
- Check adjacent docs for duplication and contradictory terminology.

### Record the acceptance result

Do not approve a rewrite with a vague quality score. For each dimension, record **PASS / NEEDS REVISION / UNVERIFIED** with one concrete location or reason. Treat unverified as different from incorrect. Fix consequential issues before declaring completion. Keep review records in the task result, not in user documentation.

| Dimension | Acceptance question | Status and location/reason |
| --- | --- | --- |
| Purpose | Does the page answer the editorial brief with one dominant form, or route readers clearly from a landing page? | |
| Starting state | Are the reader, assumed knowledge, prerequisites, and relevant platform/provider choices clear? | |
| Sequence | Is the happy path and its success check near the top of task pages, with prerequisites and risks before affected actions? For explanation/reference, is the direct answer or useful lookup first? | |
| Actionability | Does each action say what to do and where, define placeholders, and supply the required context? | |
| Observability | Does the reader have a verified result or expected state, know what it means, and distinguish completion from working behavior? | |
| Recovery | Does the likely relevant failure have a symptom, diagnosis, and next action? | |
| Terminology | Are technical terms introduced, consistent, and precise about host/container, user/contributor, and configured/running? | |
| Scope | Are useful advanced material, public links, ownership, and neighboring pages considered without expanding the task? | |
| Prose | Do connected paragraphs answer reader questions, name actors/actions, and use appropriate headings and lists without empty introductions, unsupported absolutes, or promotional language? | |
| Truth | Are behavioral claims supported, sources/revision recorded, transcripts honest, and unverified assumptions explicit? | |

### Voice checks

- [ ] H1 is the goal or question; opening gives the outcome or direct answer.
- [ ] You + imperative for steps; no first-person-plural lecture.
- [ ] Zero em dashes in user-facing prose; no throat-clearing or marketing adjectives prohibited by the skill.
- [ ] Humor is optional, at most one line next to a real command; no added forced jokes or decorative analogies.
- [ ] Warnings precede destructive actions; the happy path does not hide risks or required choices.

## Return a reviewable result

For audit mode: prioritized findings with exact locations, reader impact, and proposed correction. Do not change files.

For revision/new-page mode: the finished content or authorized patch, plus:

- What changed for the reader, in a few bullets.
- Important content moved or preserved and why.
- Sources/checks used; passed, failed, and not-run checks.
- Remaining factual questions or scope blockers.

Do not claim repository-wide improvement from one page. Pilot this contract on a small set, inspect the before/after result, and expand only after the pattern works.
