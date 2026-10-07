---
status: accepted
---

# TypeScript-Only Runtime

Node.js is now the sole server-side production runtime, and TypeScript owns the
server implementation and verification suite. The desktop browser client
remains vanilla JavaScript. The former rollback runtime and cross-runtime
oracle were removed after the migration's observable behavior contracts were
retained in the TypeScript suite, because maintaining a second implementation
and dependency toolchain added operational cost without protecting a supported
workflow.
