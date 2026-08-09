---
status: accepted
---

# TypeScript-Only Runtime

TypeScript is now the sole production runtime and verification authority. The
former rollback runtime and cross-runtime oracle were removed after the
migration's observable behavior contracts were retained in the TypeScript
suite, because maintaining a second implementation and dependency toolchain
added operational cost without protecting a supported workflow.
