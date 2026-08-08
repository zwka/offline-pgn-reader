// Thin API client. All endpoints are same-origin (local backend).

async function request(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not json */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

export const api = {
  health: () => request("/api/health"),
  files: () => request("/api/files"),
  file: (id) => request(`/api/files/${id}`),
  registerFile: (path) =>
    request("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  uploadFile: (file) => {
    const fd = new FormData();
    fd.append("file", file);
    return request("/api/files/upload", { method: "POST", body: fd });
  },
  discover: () => request("/api/discover"),
  rescan: (id) => request(`/api/files/${id}/rescan`, { method: "POST" }),
  removeFile: (id) => request(`/api/files/${id}`, { method: "DELETE" }),
  games: (fileId, { q = "", offset = 0, limit = 100 } = {}) =>
    request(`/api/files/${fileId}/games?q=${encodeURIComponent(q)}&offset=${offset}&limit=${limit}`),
  game: (id) => request(`/api/games/${id}`),
  gamePgn: (id) => request(`/api/games/${id}/pgn`),
  gameTags: (id) => request(`/api/games/${id}/tags`),
};
