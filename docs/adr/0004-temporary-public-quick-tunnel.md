---
status: accepted
---

# Temporary public Quick Tunnel for phone installation

The workspace command exposes only the compiled static mobile PWA through a Cloudflare Quick Tunnel because the PWA stores each Mobile Library in browser storage and does not call the server API. The URL is public and temporary, so a new tunnel may require reinstalling the PWA while the old origin's Mobile Library stays in its original browser storage. This favors one-command phone installation over a stable named tunnel or access control.
