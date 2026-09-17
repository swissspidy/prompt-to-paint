import { createServer, type Server } from 'node:http';
import { createReadStream, statSync, type Stats } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

/**
 * Serves the workdir for briefs that ask for a static page.
 *
 * Off unless the brief opts in: for an app brief, getting the thing running is
 * part of the task, and serving it for the agent would hide a real failure.
 */
export function serveStatic(root: string, port: number): Promise<Server> {
  const send = (res: import('node:http').ServerResponse, code: number, body: string): void => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(body);
  };

  const server = createServer((req, res) => {
    // The agent is rewriting this directory while we serve it, so every step
    // here can fail for reasons that are normal rather than exceptional. An
    // uncaught throw would take down the harness mid-measurement.
    try {
      const url = (req.url ?? '/').split('?')[0] ?? '/';
      let decoded: string;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        // A malformed percent-escape is a bad request, not a crash.
        send(res, 400, 'Bad request');
        return;
      }

      const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
      let file = join(root, rel);
      if (!file.startsWith(root)) {
        send(res, 403, 'Forbidden');
        return;
      }

      // One stat, then open. Checking existence separately leaves a window in
      // which the agent can replace or delete the file before we open it.
      let stats: Stats;
      try {
        stats = statSync(file);
      } catch {
        send(res, 404, 'Not found');
        return;
      }
      if (stats.isDirectory()) {
        file = join(file, 'index.html');
        try {
          statSync(file);
        } catch {
          send(res, 404, 'Not found');
          return;
        }
      }

      const stream = createReadStream(file);
      // Headers are written only once the file is actually open, so a file that
      // disappears in between still yields a 404 rather than a truncated 200.
      stream.once('open', () => {
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        });
        stream.pipe(res);
      });
      stream.once('error', () => send(res, 404, 'Not found'));
    } catch {
      send(res, 500, 'Server error');
    }
  });

  // A malformed request must not become an unhandled error event.
  server.on('clientError', (_err, socket) => socket.destroy());

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
