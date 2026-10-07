---
status: accepted
---

# TypeScript-Only Runtime

Node.js is the sole server-side production runtime, and TypeScript owns the
server implementation and verification suite. The mobile PWA is the only browser
client and is compiled into the static `mobile/` directory. The former rollback
runtime, cross-runtime oracle, and separate desktop browser UI were removed after
their observable behavior contracts were retained in the TypeScript and mobile
browser suites. Maintaining parallel browser clients added code and verification
cost without protecting a supported workflow.
