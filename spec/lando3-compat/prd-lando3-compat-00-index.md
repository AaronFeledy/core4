# Lando 3 compatibility implementation order

Priorities continue the global sequence in the two prerequisite PRDs. Every implementation story runs focused tests with a positive count, typecheck, tests, lint, codegen check, and boundaries. User-visible stories also run their first-surface executable guide, guide coverage/drift, public transcripts, release checks where relevant, and real provider/runtime evidence where the test provider cannot prove semantics.

| Priority | Story | Scope | Depends on |
|---:|---|---|---|
| 33 | US-619B1 | executable/package/install/shellenv ownership | US-607 |
| 34 | US-619B3 | update/uninstall coexistence | US-619B1 |
| 35 | US-620A | LEGACY parser and corpus | US-608A |
| 36 | US-620B | set model, detection, and translator plugin | US-608B, US-609B, US-620A |
| 37 | US-621A | recipe lowering and layered equivalence | US-609B, US-609C, US-609E, US-620B |
| 38 | US-621C1 | services, Compose, build, and catalog options | US-607, US-616, US-618A, US-618B, US-618C, US-618E, US-620B, US-621A |
| 39 | US-621C3 | tooling, tags, and events | US-613, US-614, US-621C1 |
| 40 | US-621C5 | routes, home, router, and scanner | US-615, US-617A, US-617B, US-621C1 |
| 41 | US-621C8 | remaining dispositions | US-618D1, US-618D3, US-621C1, US-621C3, US-621C5 |
| 42 | US-621D | safe write, loader safety, and conversion guide | US-608D, US-609C, US-621A, US-621C1, US-621C3, US-621C5, US-621C8, US-619B3 |
| 43 | US-622A | doctor ports and checks | US-620B, US-621D |
| 44 | US-622B | closure | US-611B, US-622A |
