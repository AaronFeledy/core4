# IR gaps implementation order

Priorities continue the global sequence in `../config-translation/`. Every implementation story runs focused tests with a positive count, typecheck, tests, lint, codegen check, and boundaries. A user-visible story also runs its executable guide, guide coverage/drift, public transcripts, and real provider/runtime evidence where the test provider cannot prove semantics.

| Priority | Story | Scope | Depends on |
|---:|---|---|---|
| 21 | US-613 | normalized tooling and execution | US-607 |
| 22 | US-614 | dynamic/nested events | US-613 |
| 23 | US-615 | routes and filters | US-607 |
| 24 | US-616 | planned build users | US-607 |
| 25 | US-617A | home and host | US-607 |
| 26 | US-617B | router and scanner | US-607 |
| 27 | US-618A | file-backed catalog config | US-607 |
| 28 | US-618B | Node/PHP packages | US-616 |
| 29 | US-618C | Redis/Mailpit | US-607 |
| 30 | US-618D1 | scoped rebuild and info | US-607 |
| 31 | US-618D3 | global app env/labels | US-607 |
| 32 | US-618E | Apache/Node and version matrix | US-607 |
| 46 | US-623 | tooling input consistency | US-613, US-614, US-618D1 |
| 47 | US-624 | routing correctness | US-615, US-617B |
| 48 | US-626 | redacted config view | US-618D3 |
| 49 | US-628 | bounded scanner with live start verification | US-617B |
| 50 | US-629 | teardown and inventory consistency | US-617A, US-618D1 |
| 51 | US-631 | Solr core safety and copy contracts | US-618A |
| 52 | US-632 | provider-free event validation parity | US-614 |
| 53 | US-633 | label fidelity | US-618D3 |
| 54 | US-635 | reproducible msmtp | US-618C |
| 55 | US-637 | canonical home destinations and verified metadata | US-617A, US-618E |
| 56 | US-638 | live file-backed catalog config verification | US-618A |
| 57 | US-642 | router file-watcher diagnostics | US-615 |
| 58 | US-643 | teardown independent of desired config | US-629, US-617A |
| 59 | US-644 | Apache under a non-root service user | US-618E, US-637 |
| 60 | US-645 | durable machine output | US-626, US-633 |
| 61 | US-646 | positional tooling argv round trip | US-613, US-623 |
| 62 | US-647 | cross-app route rank safety | US-615, US-624 |
| 63 | US-648 | live provider socket gate | US-638 |
| 64 | US-649 | YAML from the result envelope | US-645, US-626 |
| 65 | US-658 | per-command format advertisement | US-649 |
| 66 | US-650 | Apache PHP launcher under a non-root user | US-644, US-637 |
| 67 | US-659 | nginx-family and FPM launchers under a non-root user | US-650 |
| 68 | US-660 | volume-backed data trees under a non-root user | US-650, US-631 |
| 69 | US-651 | Apache listen port from `port:` | US-618E, US-650 |
| 70 | US-652 | orphan container teardown | US-643 |
| 71 | US-653 | volume ownership selector | US-629, US-643 |
| 72 | US-654 | router observation on global lifecycle | US-642 |
| 73 | US-655 | unit-suite baseline | none |
| 74 | US-661 | resolve-test isolation cascade | US-655 |
| 75 | US-656 | pipeline gate legibility | none |

Priorities 46..57 are follow-up stories from the audit of US-613..US-618E; priorities 33..45 belong to `../lando3-compat/`. Priorities 58..63 are residual defects recorded during the QA and review of priorities 21..57 and never queued; [`spec-ir-residual.md`](./spec-ir-residual.md) is normative for them. Priorities 64..75 are the second residual wave, recorded during the QA, review, and babysit passes of priorities 58..63 and likewise never queued; [`spec-ir-residual-2.md`](./spec-ir-residual-2.md) is normative for them and also absorbs the maintainer and CI items the first wave left on a checklist. Four of its findings were split or merged to stay inside this repository's measured pull-request size, which `spec-ir-residual-2.md` §12 records with the evidence. Story ids are sparse on purpose: twenty audit follow-ups were consolidated into twelve PR-sized stories, each keeping its original id, and the retired ids were absorbed into the story that now owns their scope. Follow-up stories reproduce on current source before fixing and treat audit findings as leads, not as present defects. Non-queued maintainer items live in the checklist at the end of `prd-ir-gaps-01-stories.md`.
