const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const outDir = path.join(__dirname, '..', 'public', 'icons');
const svgPath = path.join(outDir, 'icon.svg');
const svg = fs.readFileSync(svgPath, 'utf8');

function maskableSvg(source, bg) {
  const inner = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="${bg}"/>
  <g transform="translate(50,50) scale(0.62) translate(-50,-50)">${inner}</g>
</svg>`;
}

const jobs = [
  { svg, out: 'icon-192.png', size: 192 },
  { svg, out: 'icon-512.png', size: 512 },
  { svg, out: 'apple-touch-icon.png', size: 180 },
  { svg: maskableSvg(svg, '#12232e'), out: 'icon-192-maskable.png', size: 192 },
  { svg: maskableSvg(svg, '#12232e'), out: 'icon-512-maskable.png', size: 512 },
];

(async () => {
  for (const job of jobs) {
    await sharp(Buffer.from(job.svg))
      .resize(job.size, job.size)
      .png()
      .toFile(path.join(outDir, job.out));
    console.log('généré :', job.out);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
