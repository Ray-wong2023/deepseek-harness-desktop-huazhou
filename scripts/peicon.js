// Dump the embedded icon group from a PE file (Node, no deps).
const fs = require('fs');
const path = process.argv[2];
const buf = fs.readFileSync(path);

const peOff = buf.readUInt32LE(0x3c);
const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const optOff = peOff + 24;
const magic = buf.readUInt16LE(optOff);
const is64 = magic === 0x20b;
const ddOff = optOff + (is64 ? 112 : 96);
const resDirRva = buf.readUInt32LE(ddOff + 2 * 8);
const resDirSize = buf.readUInt32LE(ddOff + 2 * 8 + 4);

// map rva -> file offset via sections
const sections = [];
for (let i = 0; i < numSections; i++) {
  const so = optOff + optSize + i * 40;
  sections.push({
    va: buf.readUInt32LE(so + 12),
    vsize: buf.readUInt32LE(so + 8),
    raw: buf.readUInt32LE(so + 20),
    rsize: buf.readUInt32LE(so + 16)
  });
}
function rvaToOff(rva) {
  for (const s of sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) return s.raw + (rva - s.va);
  }
  return -1;
}
// some Electron exes store resource entry offsets relative to the resource
// section base instead of absolute RVAs; try both
function resToOff(rva) {
  const a = rvaToOff(rva);
  if (a >= 0) return a;
  return rvaToOff(resDirRva + rva);
}

function readEntries(dirOff, level) {
  const out = [];
  const namedCount = buf.readUInt16LE(dirOff + 12);
  const idCount = buf.readUInt16LE(dirOff + 14);
  const total = namedCount + idCount;
  for (let i = 0; i < total; i++) {
    const e = dirOff + 16 + i * 8;
    const name = buf.readUInt32LE(e);
    const off = buf.readUInt32LE(e + 4);
    const named = (name & 0x80000000) !== 0;
    const id = named ? null : (name & 0xffff);
    const isDir = (off & 0x80000000) !== 0;
    out.push({ id, named, isDir, off: isDir ? off & 0x7fffffff : off });
  }
  return out;
}

const resRoot = rvaToOff(resDirRva);
function resToOff(rva) {
  const a = rvaToOff(rva);
  if (a >= 0) return a;
  return rvaToOff(resDirRva + rva); // some exes store offsets relative to resource base
}
function walk(typeId, cb) {
  const typeEntries = readEntries(resRoot, 0);
  const t = typeEntries.find((x) => !x.named && x.id === typeId);
  if (!t) return;
  const tOff = resToOff(t.off);
  const nameEntries = readEntries(tOff, 1);
  for (const n of nameEntries) {
    const langEntries = readEntries(resToOff(n.off), 2);
    for (const l of langEntries) {
      const dOff = resToOff(buf.readUInt32LE(resToOff(l.off)));
      const size = buf.readUInt32LE(resToOff(l.off) + 4);
      cb(dOff, size, n.id);
    }
  }
}

// RT_GROUP_ICON = 14
walk(14, (gOff, gSize, gid) => {
  const count = buf.readUInt16LE(gOff + 4);
  console.log(`GROUP_ICON id=${gid} frames=${count}`);
  for (let i = 0; i < count; i++) {
    const f = gOff + 6 + i * 14;
    const w = buf.readUInt8(f), h = buf.readUInt8(f + 1);
    const planes = buf.readUInt16LE(f + 4), bpp = buf.readUInt16LE(f + 6);
    const iconId = buf.readUInt16LE(f + 12);
    walk(3, (dOff, dSize, rid) => {
      if (rid !== iconId) return;
      const magic = buf.readUInt32LE(dOff);
      const isPng = (buf.readUInt16LE(dOff) === 0x8950) && (buf.readUInt16LE(dOff + 2) === 0x4e47);
      let avg = '?';
      if (!isPng && magic === 40) {
        // BITMAPINFOHEADER + BGRA xor
        const hdr = buf.readInt32LE(dOff + 4);
        const xh = buf.readInt32LE(dOff + 8); // height*2
        const bppD = buf.readUInt16LE(dOff + 14);
        const hReal = Math.abs(xh) / 2;
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = 0; y < hReal; y++) {
          const row = dOff + 40 + y * w * 4;
          for (let x = 0; x < w; x++) {
            b += buf[row + x * 4]; g += buf[row + x * 4 + 1]; r += buf[row + x * 4 + 2]; n++;
          }
        }
        avg = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
      }
      console.log(`  frame ${w}x${h} bpp=${bpp} ${isPng ? 'PNG' : 'DIB'} avg=${avg} size=${dSize}`);
    });
  }
});
