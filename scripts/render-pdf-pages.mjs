// Renders .data/files/i1095a.pdf pages to PNG fixtures for the image-recognition test.
// Usage: node scripts/render-pdf-pages.mjs
import { getDocumentProxy, renderPageAsImage } from 'unpdf';
import fs from 'node:fs';
const src = new Uint8Array(fs.readFileSync('.data/files/i1095a.pdf'));
const pdf = await getDocumentProxy(src.slice());
for (let p = 1; p <= pdf.numPages; p++) {
  const png = await renderPageAsImage(src.slice(), p, { canvasImport: () => import('@napi-rs/canvas'), scale: 1.5 });
  const out = `fixtures/image-recognition/images/i1095a-p${p}.png`;
  fs.writeFileSync(out, Buffer.from(png));
  console.log(out, png.byteLength);
}
