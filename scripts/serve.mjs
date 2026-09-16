// Static file server for local development, rooted at the directory GitHub
// Pages publishes.
//
// The page reads data/ with fetch, which browsers refuse to do on file://, so
// opening index.html directly no longer works. Started by scripts/serve.sh.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  // normalize collapses "..", and the prefix check keeps the rest inside root.
  const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  const target = file.endsWith("/") || file === root ? join(file, "index.html") : file;

  if (!target.startsWith(root)) {
    response.writeHead(403).end("forbidden\n");
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error("directory");

    response.writeHead(200, {
      "content-type": TYPES[extname(target)] ?? "application/octet-stream",
      "content-length": info.size,
      // Generated data changes under the server's feet; never serve it stale.
      "cache-control": "no-store",
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end(`not found: ${path}\n`);
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`serving ${root} on http://localhost:${port}\n`);
});
