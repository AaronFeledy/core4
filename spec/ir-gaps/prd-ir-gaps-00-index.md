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
