// Builds lib/client.js from src/client.template.js.
//
//   node src/build.mjs                              # defaults below
//   node src/build.mjs --default street --opacity 55 --dim 0.25
//
// Everything under assets/ listed in ASSETS is embedded, so the panel can
// switch between them at runtime; imported images are added on top by the
// browser itself (IndexedDB). These flags only decide what a fresh profile
// starts with — afterwards the panel's saved state wins.
//
// --default  street | poster | off   (default: poster)
// --opacity  one opacity for canvas + transcript column, 5..100 (default 52)
// --dim      black scrim over the image, 0..0.9 (default 0.2)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = [
  { id: 'street', label: '街景', file: 'assets/bg-street.jpg' },
  { id: 'poster', label: '党徽', file: 'assets/bg-poster.jpg' },
];

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const preset = args.get('default') ?? 'poster';
const opacity = Number(args.get('opacity') ?? 52);
const dim = Number(args.get('dim') ?? 0.2);

if (!['street', 'poster', 'off'].includes(preset)) {
  console.error('--default must be street, poster or off');
  process.exit(1);
}
if (!Number.isFinite(opacity) || opacity < 5 || opacity > 100) {
  console.error('--opacity must be between 5 and 100');
  process.exit(1);
}
if (!Number.isFinite(dim) || dim < 0 || dim > 0.9) {
  console.error('--dim must be between 0 and 0.9');
  process.exit(1);
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const images = [];
for (const asset of ASSETS) {
  const abs = path.join(root, asset.file);
  if (!fs.existsSync(abs)) {
    console.warn(`skip ${asset.id}: ${asset.file} missing`);
    continue;
  }
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!mime) {
    console.error(`unsupported image type: ${asset.file}`);
    process.exit(1);
  }
  const bytes = fs.readFileSync(abs);
  if (bytes.length > 8 * 1024 * 1024) {
    console.error(`${asset.file} is over 8 MB; run scripts/prepare_image.py first`);
    process.exit(1);
  }
  images.push({ id: asset.id, label: asset.label, url: `data:${mime};base64,${bytes.toString('base64')}` });
  console.log(`embedded ${asset.id.padEnd(6)} ${(bytes.length / 1024).toFixed(0)} KiB  ${asset.file}`);
}
if (images.length === 0) {
  console.error('no wallpapers to embed');
  process.exit(1);
}

const template = fs.readFileSync(path.join(root, 'src', 'client.template.js'), 'utf8');
const out = template
  .replace('__DSH_WALLPAPER_IMAGES__', JSON.stringify(images))
  .replace('__DSH_WALLPAPER_DEFAULTS__', JSON.stringify({ preset, opacity, dim }));
if (out === template) {
  console.error('template placeholders missing; nothing written');
  process.exit(1);
}

const dest = path.join(root, 'lib', 'client.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);

console.log(`wrote ${path.relative(root, dest)} (${(out.length / 1024).toFixed(1)} KiB)`);
console.log(`  default ${preset}   opacity ${opacity}%   dim ${dim}`);
