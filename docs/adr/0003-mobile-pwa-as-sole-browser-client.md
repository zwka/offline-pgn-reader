---
status: accepted
---

# Mobile PWA as the sole browser client

The compiled mobile PWA is the only browser application. Fastify serves the
`mobile/` directory at `/`, so the same artifact runs in desktop and mobile
browser viewports. The Node server, SQLite Index, and CLI remain available for
filesystem-backed workflows, but they no longer have a separate browser UI.

The Mobile Library remains the browser state model. It stores retained source
bytes, Game records, the active source, and Resume bookmarks in its versioned
IndexedDB snapshot. The PWA continues to scan in a Worker and hydrate Game
records locally, without calling the server API.

This removes the build-free `frontend/` tree, its duplicate reader, and its
desktop-only browser tests. The mobile build owns its CBurnett piece assets and
the wide-viewport browser check proves that the one client works on desktop.
