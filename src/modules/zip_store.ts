import { JSONManifest } from "./manifest";

// OPFS + ZIP (STORE) utilities — classic PKZIP (no ZIP64).
export type Meta = { name: string; size: number; crc: number; handle: FileSystemFileHandle };

const scriptName = 'script.sh';
const jsonManifestName = 'manifest.json';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(crc: number, chunk: Uint8Array) {
  crc = crc ^ 0xFFFFFFFF;
  for (let i = 0; i < chunk.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const te = new TextEncoder();

function dosDateTime(d = new Date()) {
  const dt = new Uint16Array(2);
  dt[0] = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1F);
  dt[1] = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return dt;
}

async function writeBuf(w: FileSystemWritableFileStream, buf: ArrayBufferView | Blob | string) {
  await w.write(buf as any);
}

export async function opfsBatchRoot() {
  const root = await navigator.storage.getDirectory();
  const dirName = `sora_batch_${Date.now()}`;
  const dir = await root.getDirectoryHandle(dirName, { create: true });
  return { root, dir, dirName };
}

export async function opfsRemoveDir(root: FileSystemDirectoryHandle, name: string) {
  try { await root.removeEntry(name, { recursive: true }); } catch { }
}

export async function writeManifestToOPFS(jsonManifest: JSONManifest): Promise<Meta> {
  const { root, dir, dirName } = await opfsBatchRoot();
  const jsonManifestString = JSON.stringify(jsonManifest, null, 2);
  const jsonManifestFile = await dir.getFileHandle(jsonManifestName, { create: true });
  const jsonManifestWriter = await jsonManifestFile.createWritable();
  await jsonManifestWriter.write(jsonManifestString);
  await jsonManifestWriter.close();
  const crcJSON = crc32Update(0, te.encode(jsonManifestString));
  const jsonMeta = { name: jsonManifestName, size: jsonManifestString.length, crc: crcJSON, handle: jsonManifestFile };
  return jsonMeta;
}

export async function writeScriptToOPFS(script: string): Promise<Meta> {
  const { root, dir, dirName } = await opfsBatchRoot();
  const scriptFile = await dir.getFileHandle(scriptName, { create: true });
  const scriptWriter = await scriptFile.createWritable();
  await scriptWriter.write(script);
  await scriptWriter.close();
  const crc = crc32Update(0, te.encode(script));
  const scriptMeta = { name: scriptName, size: script.length, crc, handle: scriptFile };
  return scriptMeta;
}


export async function downloadAllToOPFS(opts: {
  items: { url: string; filename: string }[];
  onStatus?: (ev: { phase: 'dl-progress' | 'dl-file-done'; file: string; index: number; total: number }) => void;
  signal?: AbortSignal;
}) {
  const { items, onStatus, signal } = opts;
  const { root, dir, dirName } = await opfsBatchRoot();
  const metas: Meta[] = [];
  let idx = 0;
  for (const it of items) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const safeName = it.filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
    const fh = await dir.getFileHandle(safeName, { create: true });
    const w = await fh.createWritable();

    let crc = 0, size = 0;
    const res = await fetch(it.url, { signal });
    if (!res.ok || !res.body) { await w.close(); throw new Error(`Fetch failed: ${safeName}`); }
    const reader = res.body.getReader();
    while (true) {
      if (signal?.aborted) { await w.close(); throw new DOMException('Aborted', 'AbortError'); }
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      crc = crc32Update(crc, chunk);
      size += chunk.length;
      await w.write(chunk);
      onStatus?.({ phase: 'dl-progress', file: safeName, index: idx + 1, total: items.length });
    }
    await w.close();
    metas.push({ name: safeName, size, crc, handle: fh });
    idx++;
    onStatus?.({ phase: 'dl-file-done', file: safeName, index: idx, total: items.length });
  }
  return { root, dir, dirName, metas };
}

export async function writeZipFromOPFS(opts: {
  metas: Meta[];
  saveHandle: FileSystemFileHandle;
  onStatus?: (ev: { phase: 'zip-progress' | 'zip-file-done' | 'zip-done' | 'cancel_done'; file?: string; done?: number; total?: number }) => void;
  signal?: AbortSignal;
}) {
  const { metas, saveHandle, onStatus, signal } = opts;
  const writable = await saveHandle.createWritable();
  let offset = 0;
  const central: Uint8Array[] = [];
  const now = dosDateTime();

  let done = 0;
  for (const m of metas) {
    if (signal?.aborted) { await writable.close(); throw new DOMException('Aborted', 'AbortError'); }
    const nameBytes = te.encode(m.name);

    // LFH
    const LFH = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(LFH.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, now[0], true);
    dv.setUint16(12, now[1], true);
    dv.setUint32(14, m.crc >>> 0, true);
    dv.setUint32(18, m.size >>> 0, true);
    dv.setUint32(22, m.size >>> 0, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    LFH.set(nameBytes, 30);

    await writeBuf(writable, LFH);
    const localHeaderOffset = offset;
    offset += LFH.length;

    // file content
    const file = await m.handle.getFile();
    const reader = file.stream().getReader();
    while (true) {
      if (signal?.aborted) { await writable.close(); throw new DOMException('Aborted', 'AbortError'); }
      const { value, done: rdDone } = await reader.read();
      if (rdDone) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      await writeBuf(writable, chunk);
      offset += chunk.length;
      onStatus?.({ phase: 'zip-progress', file: m.name });
    }

    // CEN
    const CEN = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(CEN.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, now[0], true);
    cdv.setUint16(14, now[1], true);
    cdv.setUint32(16, m.crc >>> 0, true);
    cdv.setUint32(20, m.size >>> 0, true);
    cdv.setUint32(24, m.size >>> 0, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, localHeaderOffset >>> 0, true);
    CEN.set(nameBytes, 46);
    central.push(CEN);

    done++;
    onStatus?.({ phase: 'zip-file-done', file: m.name, done, total: metas.length });
  }

  // central dir + EOCD
  let cdSize = 0, cdOffset = offset;
  for (const c of central) { await writeBuf(writable, c); cdSize += c.length; }
  offset += cdSize;

  const EOCD = new Uint8Array(22);
  const edv = new DataView(EOCD.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, cdSize >>> 0, true);
  edv.setUint32(16, cdOffset >>> 0, true);
  edv.setUint16(20, 0, true);
  await writeBuf(writable, EOCD);

  await writable.close();
  onStatus?.({ phase: 'zip-done' });
}
