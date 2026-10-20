/**
 * Host half of the wallpaper bundle.
 *
 * The browser cannot read the Windows wallpaper (no filesystem access), so this
 * side serves it: one exact route streams the current desktop wallpaper, and
 * the page fetches it through the same origin it already uses (`dsh-app://app`
 * forwards every non-asset path to this server, cookie included).
 *
 * The route is optional: if the composition has no web server, nothing is
 * registered and the panel simply reports that the feature is unavailable.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROUTE = '/_dsh-wallpaper/desktop';

/** MIME by magic bytes; Windows transcodes to JPEG, but be tolerant. */
function sniffMime(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

/** Ask the shell which file the desktop currently paints. */
async function wallpaperFromRegistry() {
  const { stdout } = await run('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], {
    windowsHide: true,
  });
  const match = /WallPaper\s+REG_\w+\s+(\S.*?)\s*$/m.exec(stdout);
  return match?.[1];
}

/**
 * Read the current desktop wallpaper.
 * `TranscodedWallpaper` is the composited image (right size, right format),
 * so it is tried first; the registry path covers themes that skip it.
 * @returns the bytes, or undefined when the platform has no readable wallpaper.
 */
async function readWallpaper() {
  if (process.platform !== 'win32') return undefined;

  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper'));
  }
  try {
    const file = await wallpaperFromRegistry();
    if (file) candidates.push(file);
  } catch {
    /* reg missing or the key is unset: the transcoded file is enough */
  }

  for (const file of candidates) {
    try {
      const info = await stat(file);
      const bytes = await readFile(file);
      if (bytes.length > 0) {
        return {
          bytes,
          mime: sniffMime(bytes),
          file,
          // Changes whenever the desktop wallpaper is replaced (slideshow,
          // theme switch, manual pick), which is what the browser polls on.
          etag: `"${info.size}-${Math.round(info.mtimeMs)}"`,
        };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/** Register the route once the web server service exists. */
function attach(ctx) {
  try {
    const server = ctx.webServer;
    if (!server?.register) return;
    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405).end();
              return;
            }
            try {
              const found = await readWallpaper();
              if (!found) {
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('no desktop wallpaper');
                return;
              }
              // The panel polls while "follow the desktop" is active; answer
              // 304 so a slideshow costs headers only until the image changes.
              if (req.headers['if-none-match'] === found.etag) {
                res.writeHead(304, { etag: found.etag, 'cache-control': 'no-store' }).end();
                return;
              }
              res.writeHead(200, {
                'content-type': found.mime,
                'content-length': String(found.bytes.length),
                'cache-control': 'no-store',
                etag: found.etag,
              });
              res.end(req.method === 'HEAD' ? undefined : found.bytes);
            } catch (error) {
              ctx.logger?.warn?.(`wallpaper: ${error?.message ?? error}`);
              res.writeHead(500).end();
            }
          },
        }),
      'wallpaper: desktop wallpaper route',
    );
  } catch (error) {
    // No web server in this composition: the panel reports the feature off.
    ctx.logger?.warn?.(`wallpaper: route not registered (${error?.message ?? error})`);
  }
}

/** @param ctx - host plugin context. */
export function apply(ctx) {
  // Wait for the service instead of declaring a hard inject: a composition
  // without a web server must still load the plugin (and its browser half).
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], attach);
  else attach(ctx);
}
