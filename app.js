/* T-Display-S3 Media Uploader (playlist)
 * Load multiple clips (image/GIF/video), edit each (fit/zoom/rotate/pan, color
 * or 1-bit mono with threshold/dither), then pack them into a TDPL playlist and
 * flash the "media" partition over Web Serial. The board plays clip 1 and a
 * WiFi web page switches clips live.
 */
'use strict';
(function () {

// ---- Formats (shared with the player firmware) ----------------------------
const HEADER_SIZE = 32;                        // per-clip TDS1 header
const MEDIA_OFFSET = 0x210000;                 // "media" partition offset
const MEDIA_MAX = 0xDF0000;                    // "media" partition size
const FMT_RGB565 = 0, FMT_MONO1 = 1, FMT_PAL8_RLE = 3;
const MAX_CLIPS = 16;
const PL_HEADER_SIZE = 128;
const DIR_OFFSET = 128;
const DIR_ENTRY = 32;
const CLIP_DATA_START = 0x1000;

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- Model ----------------------------------------------------------------
function defaultEdit() {
  return {
    rotation: 1, fit: 'contain', zoom: 1, rotate: 0, panX: 0, panY: 0,
    mode: 'color', bright: 0, contrast: 0, thresh: 128, dither: false, invert: false,
    compress: 'auto',   // 'auto' = palette+RLE when it saves, else raw RGB565; 'off' = raw
    fps: 25, maxFrames: 60, vStart: 0, vEnd: 0,
  };
}
// Per-control defaults for double-click-to-reset on sliders.
const SLIDER_DEFAULTS = { zoom: 1, rot: 0, bright: 0, contrast: 0, thresh: 128, fps: 25, maxFrames: 60 };

const clips = [];   // { name, file, srcType, srcFrames:[{canvas,w,h}], edit }
let active = -1;
const ui = { viewScale: 2, playing: true, playIdx: 0, processed: [] };

const E = () => clips[active] && clips[active].edit;

// ==========================================================================
// Source decoding
// ==========================================================================
async function addFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    if (clips.length >= MAX_CLIPS) { log(`Max ${MAX_CLIPS} clips reached; skipping ${file.name}.`); break; }
    const clip = { name: baseName(file.name), file, srcType: null, srcFrames: [], edit: defaultEdit() };
    try {
      await decodeInto(clip);
    } catch (e) { log('Decode error (' + file.name + '): ' + e.message); continue; }
    clips.push(clip);
    log(`Added "${clip.name}" (${clip.srcType}, ${clip.srcFrames.length} frame${clip.srcFrames.length>1?'s':''}).`);
  }
  renderPlaylist();
  if (active < 0 && clips.length) selectClip(0);
  else { updateBudget(); }
}

async function decodeInto(clip) {
  clip.srcFrames = [];
  const file = clip.file;
  if (file.type.startsWith('video')) { clip.srcType = 'video'; await decodeVideo(clip); }
  else if (file.type === 'image/gif') { clip.srcType = 'gif'; await decodeGif(clip); }
  else { clip.srcType = 'image'; await decodeImage(clip); }
}

function frameToCanvas(src, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0); return { canvas: c, w, h };
}

async function decodeImage(clip) {
  const bmp = await createImageBitmap(clip.file);
  clip.srcFrames = [frameToCanvas(bmp, bmp.width, bmp.height)];
  bmp.close && bmp.close();
}

async function decodeGif(clip) {
  if (typeof ImageDecoder === 'undefined') throw new Error('ImageDecoder unavailable; use Chrome/Edge.');
  const dec = new ImageDecoder({ data: await clip.file.arrayBuffer(), type: 'image/gif' });
  await dec.tracks.ready;
  const count = dec.tracks.selectedTrack.frameCount || 1;
  const frames = [];
  for (let i = 0; i < count; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    frames.push(frameToCanvas(image, image.displayWidth, image.displayHeight));
    image.close();
  }
  clip.srcFrames = frames; dec.close();
}

async function decodeVideo(clip) {
  const url = URL.createObjectURL(clip.file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.src = url;
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('video load failed')); });
  const dur = v.duration;
  if (!clip.edit.vEnd) clip.edit.vEnd = dur;
  const start = clamp(clip.edit.vStart, 0, dur);
  const end = clamp(clip.edit.vEnd || dur, start + 0.01, dur);
  const span = end - start;
  const n = clamp(Math.round(span * clip.edit.fps), 1, clip.edit.maxFrames);
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? start + (span * i) / (n - 1) : start;
    await seekVideo(v, Math.min(t, end));
    frames.push(frameToCanvas(v, v.videoWidth, v.videoHeight));
  }
  clip.srcFrames = frames;
  clip._dur = dur;
  URL.revokeObjectURL(url);
}
function seekVideo(v, t) {
  return new Promise((res) => { const d = () => { v.removeEventListener('seeked', d); res(); }; v.addEventListener('seeked', d); v.currentTime = t; });
}

function baseName(n) { return n.replace(/\.[^.]+$/, '').slice(0, 24) || 'clip'; }

// ==========================================================================
// Edit pipeline (parameterized by an `edit` + target W,H)
// ==========================================================================
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

function clipDims(edit) {
  const landscape = (edit.rotation === 1 || edit.rotation === 3);
  return { W: landscape ? 320 : 170, H: landscape ? 170 : 320 };
}

function renderGeometry(srcCanvas, edit, W, H) {
  work.width = W; work.height = H;
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.fillStyle = '#000'; wctx.fillRect(0, 0, W, H);
  const sw = srcCanvas.width, sh = srcCanvas.height;
  let sx, sy;
  if (edit.fit === 'stretch') { sx = W / sw; sy = H / sh; }
  else { const base = edit.fit === 'cover' ? Math.max(W/sw, H/sh) : Math.min(W/sw, H/sh); sx = sy = base; }
  sx *= edit.zoom; sy *= edit.zoom;
  wctx.translate(W/2 + edit.panX, H/2 + edit.panY);
  wctx.rotate(edit.rotate * Math.PI/180);
  wctx.scale(sx, sy);
  wctx.imageSmoothingEnabled = true;
  wctx.drawImage(srcCanvas, -sw/2, -sh/2);
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  return wctx.getImageData(0, 0, W, H);
}

function applyFilters(img, edit, W, H) {
  const d = img.data, n = d.length;
  const b = edit.bright * 2.55;
  const cf = (259 * (edit.contrast + 255)) / (255 * (259 - edit.contrast));
  const colorInvert = edit.invert && edit.mode === 'color';
  for (let i = 0; i < n; i += 4) {
    let r = cf*(d[i]-128)+128+b, g = cf*(d[i+1]-128)+128+b, bl = cf*(d[i+2]-128)+128+b;
    if (colorInvert) { r = 255-r; g = 255-g; bl = 255-bl; }
    d[i] = clamp(r,0,255); d[i+1] = clamp(g,0,255); d[i+2] = clamp(bl,0,255);
  }
  if (edit.mode === 'mono') monochrome(img, edit, W, H);
  return img;
}

function monochrome(img, edit, W, H) {
  const d = img.data, th = edit.thresh, inv = edit.invert;
  if (!edit.dither) {
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
      let v = l >= th ? 255 : 0; if (inv) v = 255 - v;
      d[i] = d[i+1] = d[i+2] = v;
    }
    return;
  }
  const lum = new Float32Array(W * H);
  for (let p = 0, i = 0; p < W*H; p++, i += 4) lum[p] = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y*W + x, old = lum[p], nv = old >= th ? 255 : 0, err = old - nv;
    lum[p] = nv;
    if (x+1 < W) lum[p+1] += err*7/16;
    if (y+1 < H) { if (x>0) lum[p+W-1] += err*3/16; lum[p+W] += err*5/16; if (x+1<W) lum[p+W+1] += err*1/16; }
  }
  for (let p = 0, i = 0; p < W*H; p++, i += 4) { let v = lum[p] >= 128 ? 255 : 0; if (inv) v = 255 - v; d[i]=d[i+1]=d[i+2]=v; }
}

// ---- Render the ACTIVE clip for preview ----------------------------------
let rebuildTimer = null;
function rebuild() { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(doRebuild, 90); }
function doRebuild() {
  const clip = clips[active];
  if (!clip || !clip.srcFrames.length) { ui.processed = []; $('frameLabel').textContent = '0 frames'; paintClear(); updateBudget(); return; }
  const edit = clip.edit;
  const { W, H } = clipDims(edit);
  $('dimLabel').textContent = `${W} × ${H}`;
  const limit = Math.min(clip.srcFrames.length, edit.maxFrames);
  const out = [];
  for (let i = 0; i < limit; i++) out.push(applyFilters(renderGeometry(clip.srcFrames[i].canvas, edit, W, H), edit, W, H));
  ui.processed = out;
  if (ui.playIdx >= out.length) ui.playIdx = 0;
  $('frameLabel').textContent = `${out.length} frame${out.length>1?'s':''}`;
  sizePreview(W, H); paintCurrent();
  invalidateClip(clip);   // edit changed -> re-encode size later (debounced)
  scheduleSizes();
}

// Exact (palette+RLE) sizing is expensive, so run it after edits settle rather
// than on every slider tick. Preview stays snappy; budget/sizes refresh shortly.
let sizesTimer = null;
function scheduleSizes() { clearTimeout(sizesTimer); sizesTimer = setTimeout(() => { updateBudget(); renderPlaylist(); }, 250); }

// ==========================================================================
// Preview loop
// ==========================================================================
const pc = $('previewCanvas');
const pctx = pc.getContext('2d');
function sizePreview(W, H) {
  if (pc.width !== W || pc.height !== H) { pc.width = W; pc.height = H; }
  pc.style.width = (W * ui.viewScale) + 'px'; pc.style.height = (H * ui.viewScale) + 'px';
}
function paintClear() { pctx.clearRect(0, 0, pc.width, pc.height); }
function paintCurrent() {
  if (!ui.processed.length) return;
  const idx = clamp(ui.playIdx, 0, ui.processed.length - 1);
  pctx.putImageData(ui.processed[idx], 0, 0);
  $('playLabel').textContent = ui.playing ? `playing ${idx+1}/${ui.processed.length}` : 'paused';
}
let lastFrameAt = 0;
function tickPreview(now) {
  requestAnimationFrame(tickPreview);
  if (!ui.processed.length) return;
  const fps = (E() && E().fps) || 12;
  const period = Math.round(1000 / fps);
  if (now - lastFrameAt < period) return;
  lastFrameAt = now;
  if (ui.playing) ui.playIdx = (ui.playIdx + 1) % ui.processed.length;
  paintCurrent();
}

// ==========================================================================
// Packing
// ==========================================================================
function clipFrameCount(clip) { return Math.min(clip.srcFrames.length, clip.edit.maxFrames); }

// Cached packed clip blob (keyed by edit state + source signature) so budget and
// upload reuse the same encode instead of re-quantizing on every call.
function clipKey(clip) { return JSON.stringify(clip.edit) + '|' + clip.srcFrames.length; }
function getClipBlob(clip) {
  const key = clipKey(clip);
  if (clip._key === key && clip._blob) return clip._blob;
  const blob = packClip(clip);
  clip._key = key; clip._blob = blob; clip._ratio = blob._ratio;
  return blob;
}
function invalidateClip(clip) { if (clip) { clip._key = null; clip._blob = null; } }
function clipSize(clip) { return getClipBlob(clip).length; }
function playlistSize() { return CLIP_DATA_START + clips.reduce((a, c) => a + clipSize(c), 0); }

// Render every frame of a clip to RGB565 Uint16 arrays (for encoding).
function renderFrames565(clip) {
  const edit = clip.edit, { W, H } = clipDims(edit), n = clipFrameCount(clip), out = [];
  for (let i = 0; i < n; i++) {
    const d = applyFilters(renderGeometry(clip.srcFrames[i].canvas, edit, W, H), edit, W, H).data;
    const px = new Uint16Array(W * H);
    for (let p = 0, j = 0; p < px.length; p++, j += 4) px[p] = ((d[j]&0xF8)<<8)|((d[j+1]&0xFC)<<3)|(d[j+2]>>3);
    out.push(px);
  }
  return { frames: out, W, H, n };
}

function packClip(clip) {
  const edit = clip.edit, { W, H } = clipDims(edit), n = clipFrameCount(clip);
  if (edit.mode === 'mono') return packMonoClip(clip, W, H, n);
  const { frames } = renderFrames565(clip);
  const raw = packRawClip(frames, edit, W, H, n);
  if (edit.compress === 'off') { raw._ratio = 1; return raw; }
  const comp = packCompressedClip(frames, edit, W, H, n);   // null if not worthwhile
  if (comp && comp.length < raw.length) { comp._ratio = comp.length / raw.length; return comp; }
  raw._ratio = 1; return raw;
}

function writeClipHeader(buf, fmt, edit, W, H, n, frameBytes) {
  const dv = new DataView(buf.buffer);
  buf.set([0x54,0x44,0x53,0x31], 0);
  dv.setUint8(4, 1); dv.setUint8(5, fmt); dv.setUint8(6, edit.rotation & 3); dv.setUint8(7, 0);
  dv.setUint16(8, W, true); dv.setUint16(10, H, true);
  dv.setUint16(12, n, true); dv.setUint16(14, Math.round(1000/edit.fps), true);
  dv.setUint32(16, frameBytes, true);
}

function packRawClip(frames, edit, W, H, n) {
  const fb = W * H * 2, buf = new Uint8Array(HEADER_SIZE + fb * n), dv = new DataView(buf.buffer);
  writeClipHeader(buf, FMT_RGB565, edit, W, H, n, fb);
  let off = HEADER_SIZE;
  for (const px of frames) for (let p = 0; p < px.length; p++) { dv.setUint16(off, px[p], true); off += 2; }
  return buf;
}

function packMonoClip(clip, W, H, n) {
  const fb = ((W + 7) >> 3) * H, buf = new Uint8Array(HEADER_SIZE + fb * n);
  writeClipHeader(buf, FMT_MONO1, clip.edit, W, H, n, fb);
  let off = HEADER_SIZE;
  for (let i = 0; i < n; i++) {
    const img = applyFilters(renderGeometry(clip.srcFrames[i].canvas, clip.edit, W, H), clip.edit, W, H);
    off = packMono(img, buf, off, W, H);
  }
  buf._ratio = 1; return buf;
}

// Palette + RLE. Returns null when the clip has too many colors to palettize
// well and no meaningful gain is expected.
function packCompressedClip(frames, edit, W, H, n) {
  const { palette, mapping } = buildPalette(frames);         // ≤256 colors
  if (!palette) return null;
  const blobs = [];
  const idx = new Uint8Array(W * H), tmp = new Uint8Array(W * H * 2);
  for (const px of frames) {
    for (let p = 0; p < px.length; p++) idx[p] = mapping.get(px[p]);
    blobs.push(rleEncode(idx, tmp));
  }
  const maxBlob = blobs.reduce((a, b) => Math.max(a, b.length), 0);
  const total = HEADER_SIZE + 512 + n * 4 + blobs.reduce((a, b) => a + b.length, 0);
  const buf = new Uint8Array(total), dv = new DataView(buf.buffer);
  writeClipHeader(buf, FMT_PAL8_RLE, edit, W, H, n, maxBlob);
  for (let i = 0; i < 256; i++) dv.setUint16(HEADER_SIZE + i * 2, palette[i] || 0, true);
  let tableOff = HEADER_SIZE + 512, dataOff = tableOff + n * 4;
  for (let i = 0; i < n; i++) { dv.setUint32(tableOff + i * 4, blobs[i].length, true); buf.set(blobs[i], dataOff); dataOff += blobs[i].length; }
  return buf;
}

// RLE of palette indices: [count][index] pairs, count 1..255.
function rleEncode(idx, scratch) {
  let o = 0, i = 0, n = idx.length;
  while (i < n) { const v = idx[i]; let run = 1; while (i + run < n && idx[i+run] === v && run < 255) run++; scratch[o++] = run; scratch[o++] = v; i += run; }
  return scratch.slice(0, o);
}

// Build a ≤256-entry RGB565 palette. Lossless if the clip already has ≤256
// colors; otherwise median-cut quantization. Returns {palette:Uint16Array(256),
// mapping:Map(color565->index)}.
function buildPalette(frames) {
  const hist = new Map();
  for (const px of frames) for (let p = 0; p < px.length; p++) hist.set(px[p], (hist.get(px[p]) || 0) + 1);
  const palette = new Uint16Array(256), mapping = new Map();
  if (hist.size <= 256) {
    let i = 0; for (const c of hist.keys()) { palette[i] = c; mapping.set(c, i); i++; }
    return { palette, mapping };
  }
  // median cut over unique colors (weighted by count)
  const cols = [];
  for (const [c, cnt] of hist) cols.push({ c, r: ((c>>11)&0x1f)<<3, g: ((c>>5)&0x3f)<<2, b: (c&0x1f)<<3, count: cnt });
  let boxes = [cols];
  while (boxes.length < 256) {
    let bi = -1, best = -1;
    for (let k = 0; k < boxes.length; k++) { if (boxes[k].length < 2) continue; const r = boxRange(boxes[k]).span; if (r > best) { best = r; bi = k; } }
    if (bi < 0) break;
    const box = boxes[bi], ch = boxRange(box).channel;
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  boxes.forEach((box, i) => {
    let r = 0, g = 0, b = 0, w = 0;
    for (const c of box) { r += c.r*c.count; g += c.g*c.count; b += c.b*c.count; w += c.count; }
    r = Math.round(r/w); g = Math.round(g/w); b = Math.round(b/w);
    palette[i] = ((r&0xF8)<<8)|((g&0xFC)<<3)|(b>>3);
    for (const c of box) mapping.set(c.c, i);
  });
  return { palette, mapping };
}
function boxRange(box) {
  let rmn=255,rmx=0,gmn=255,gmx=0,bmn=255,bmx=0;
  for (const c of box) { if(c.r<rmn)rmn=c.r; if(c.r>rmx)rmx=c.r; if(c.g<gmn)gmn=c.g; if(c.g>gmx)gmx=c.g; if(c.b<bmn)bmn=c.b; if(c.b>bmx)bmx=c.b; }
  const dr=rmx-rmn, dg=gmx-gmn, db=bmx-bmn, span=Math.max(dr,dg,db);
  return { span, channel: span===dr?'r':(span===dg?'g':'b') };
}
function packMono(img, buf, off, W, H) {
  const d = img.data, rowBytes = (W + 7) >> 3;
  for (let y = 0; y < H; y++) for (let xb = 0; xb < rowBytes; xb++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) { const x = xb*8+bit; if (x < W && d[(y*W+x)*4] > 127) byte |= (0x80 >> bit); }
    buf[off++] = byte;
  }
  return off;
}

// Cheap (raw) size estimate for UI while exact encode is pending.
function cheapEstimate(clip) { const { W, H } = clipDims(clip.edit); const fb = clip.edit.mode === 'mono' ? ((W+7)>>3)*H : W*H*2; return HEADER_SIZE + fb * clipFrameCount(clip); }
function clipSizeDisplay(clip) { return clip._blob ? clip._blob.length : cheapEstimate(clip); }

function packPlaylist() {
  const blobs = clips.map(getClipBlob);
  const total = CLIP_DATA_START + blobs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const ssid = ($('ssid').value || 'T-Display-S3').slice(0, 32);
  // Playlist header
  out.set([0x54,0x44,0x50,0x4C], 0);                // "TDPL"
  dv.setUint8(4, 1); dv.setUint8(5, clips.length); dv.setUint8(6, 0); dv.setUint8(7, 0);
  dv.setUint8(8, 1);                                 // wifiMode = softAP open
  dv.setUint8(9, ssid.length); dv.setUint8(10, 0);
  for (let i = 0; i < ssid.length; i++) out[12 + i] = ssid.charCodeAt(i);
  // Directory + blobs
  let off = CLIP_DATA_START;
  clips.forEach((clip, i) => {
    const e = DIR_OFFSET + i * DIR_ENTRY;
    dv.setUint32(e, off, true); dv.setUint32(e + 4, blobs[i].length, true);
    const nm = clip.name.slice(0, 24);
    for (let k = 0; k < nm.length; k++) out[e + 8 + k] = nm.charCodeAt(k);
    out.set(blobs[i], off); off += blobs[i].length;
  });
  return out;
}

function updateBudget() {
  const used = playlistSize(), pct = used / MEDIA_MAX;
  $('meterBar').style.width = clamp(pct*100, 0, 100) + '%';
  $('meter').classList.toggle('over', used > MEDIA_MAX);
  $('budgetPct').textContent = (pct*100).toFixed(1) + '%';
  $('budgetText').textContent = `${(used/1e6).toFixed(2)} MB of ${(MEDIA_MAX/1e6).toFixed(1)} MB · ${clips.length} clip${clips.length!==1?'s':''}`;
  const over = used > MEDIA_MAX, warn = $('budgetWarn');
  if (over) { warn.style.display = ''; warn.textContent = `Over by ${((used-MEDIA_MAX)/1e6).toFixed(2)} MB. Trim clips, lower FPS/frames, or use Mono.`; }
  else warn.style.display = 'none';
  $('uploadBtn').disabled = over || !serial.connected || clips.length === 0;
}

// ==========================================================================
// Playlist panel
// ==========================================================================
function renderPlaylist() {
  const host = $('playlist');
  if (!clips.length) { host.innerHTML = '<div class="small muted">No clips yet. Add media above.</div>'; return; }
  host.innerHTML = '';
  clips.forEach((clip, i) => {
    const row = document.createElement('div');
    row.className = 'plitem' + (i === active ? ' active' : '');
    row.innerHTML =
      `<canvas class="thumb" width="48" height="48"></canvas>
       <div class="plmeta">
         <input class="plname" value="${escapeHtml(clip.name)}" maxlength="24" title="Clip name (shown on the web page)">
         <div class="small muted">${i===0?'▶ default · ':''}${clip.srcType} · ${clipFrameCount(clip)}f · ${(clipSizeDisplay(clip)/1e6).toFixed(2)}MB${clip._ratio && clip._ratio < 0.95 ? ' · palette '+(1/clip._ratio).toFixed(1)+'×' : ''}</div>
       </div>
       <div class="plbtns">
         <button class="mini" data-up>↑</button>
         <button class="mini" data-del>✕</button>
       </div>`;
    row.addEventListener('click', (e) => { if (e.target.closest('button') || e.target.classList.contains('plname')) return; selectClip(i); });
    row.querySelector('.plname').addEventListener('change', (e) => { clip.name = e.target.value.slice(0,24) || 'clip'; renderPlaylist(); });
    row.querySelector('[data-del]').addEventListener('click', () => removeClip(i));
    row.querySelector('[data-up]').addEventListener('click', () => moveClip(i, -1));
    // thumbnail
    const tc = row.querySelector('.thumb'), tctx = tc.getContext('2d');
    if (clip.srcFrames[0]) { tctx.fillStyle = '#000'; tctx.fillRect(0,0,48,48); const f = clip.srcFrames[0]; const s = Math.min(48/f.w, 48/f.h); const dw = f.w*s, dh = f.h*s; tctx.drawImage(f.canvas, (48-dw)/2, (48-dh)/2, dw, dh); }
    host.appendChild(row);
  });
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function selectClip(i) {
  active = i; ui.playIdx = 0;
  loadControls(clips[i].edit);
  $('videoRange').style.display = clips[i].srcType === 'video' ? '' : 'none';
  if (clips[i].srcType === 'video') { $('vStart').value = clips[i].edit.vStart; $('vEnd').value = clips[i].edit.vEnd; $('vStart').max = clips[i]._dur||0; $('vEnd').max = clips[i]._dur||0; }
  renderPlaylist();
  doRebuild();
}
function removeClip(i) {
  clips.splice(i, 1);
  if (!clips.length) { active = -1; ui.processed = []; paintClear(); $('frameLabel').textContent='0 frames'; renderPlaylist(); updateBudget(); return; }
  if (active >= clips.length) active = clips.length - 1;
  selectClip(active);
}
function moveClip(i, dir) {
  const j = i + dir; if (j < 0 || j >= clips.length) return;
  [clips[i], clips[j]] = [clips[j], clips[i]];
  if (active === i) active = j; else if (active === j) active = i;
  selectClip(active);
}

// Load a clip's edit state into the controls.
function loadControls(edit) {
  $('orient').value = String(edit.rotation);
  segSet('fitSeg', 'fit', edit.fit);
  segSet('colorSeg', 'mode', edit.mode);
  segSet('compressSeg', 'compress', edit.compress);
  $('colorControls').style.display = edit.mode === 'color' ? '' : 'none';
  $('monoControls').style.display = edit.mode === 'mono' ? '' : 'none';
  setRange('zoom', edit.zoom, v => v.toFixed(2)+'×');
  setRange('rot', edit.rotate, v => v+'°');
  setRange('bright', edit.bright, v => ''+v);
  setRange('contrast', edit.contrast, v => ''+v);
  setRange('thresh', edit.thresh, v => ''+v);
  setRange('fps', edit.fps, v => v+' fps');
  setRange('maxFrames', edit.maxFrames, v => ''+v);
  $('dither').checked = edit.dither; $('invert').checked = edit.invert;
}
function setRange(id, val, fmt) { const el = $(id); el.value = val; const l = $(id+'V'); if (l) l.textContent = fmt ? fmt(parseFloat(val)) : val; }
function segSet(seg, key, val) { document.querySelectorAll('#'+seg+' button').forEach(b => b.classList.toggle('on', b.dataset[key] === val)); }

// ==========================================================================
// Web Serial + esptool-js flashing
// ==========================================================================
const serial = { port: null, connected: false, busy: false };
const ESP = () => window.esptooljs;
const term = { clean() {}, writeLine(d) { log(d); }, write(d) { logInline(d); } };

async function connect() {
  if (!('serial' in navigator)) { alert('Web Serial needs Chrome or Edge (over http://localhost or file://).'); return; }
  try {
    setSerial('busy', 'Requesting port…');
    serial.port = await navigator.serial.requestPort();
    serial.connected = true;
    setSerial('ok', 'Port selected'); log('Serial port selected.');
    updateBudget();
  } catch (e) { setSerial('err', 'No port'); log('Connect cancelled: ' + e.message); }
}

async function withLoader(fn) {
  const { ESPLoader, Transport } = ESP();
  const transport = new Transport(serial.port, false);
  const loader = new ESPLoader({ transport, baudrate: 921600, romBaudrate: 115200, terminal: term });
  const chip = await loader.main();
  log('Detected: ' + chip);
  try { await fn(loader); }
  finally {
    try { await transport.setRTS(true); await new Promise(r => setTimeout(r, 120)); await transport.setRTS(false); } catch {}
    try { await transport.disconnect(); } catch {}
  }
}

function binStr(u8) { let s = '', CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return s; }

async function upload() {
  if (serial.busy) return;
  if (!clips.length) return;
  if (!serial.port) { await connect(); if (!serial.port) return; }
  let uploadedOk = false;
  serial.busy = true;
  $('uploadBtn').disabled = true; $('connectBtn').disabled = true;
  setSerial('busy', 'Flashing…'); showProgress(true); setProgress(0, 'Preparing…');
  try {
    const fileArray = [];
    if ($('doFw').checked) { for (const p of window.PLAYER_FIRMWARE) fileArray.push({ data: atob(p.data), address: p.offset }); log(`Queued player firmware.`); }
    const media = packPlaylist();
    fileArray.push({ data: binStr(media), address: MEDIA_OFFSET });
    log(`Queued playlist: ${clips.length} clips, ${(media.length/1e6).toFixed(2)} MB.`);
    const sizes = fileArray.map(f => f.data.length), grand = sizes.reduce((a,b)=>a+b,0);
    const before = idx => sizes.slice(0, idx).reduce((a,b)=>a+b,0);
    setProgress(0, 'Connecting…');
    await withLoader(async (loader) => {
      await loader.writeFlash({
        fileArray, flashSize: 'keep', eraseAll: false, compress: true,
        reportProgress: (idx, written, total) => {
          const pct = Math.round(((before(idx)+written)/grand)*100), fp = Math.round((written/total)*100);
          setProgress(pct, `File ${idx+1}/${fileArray.length} · ${fp}% · ${pct}% total`);
          setSerial('busy', `Flashing ${pct}%`);
        },
      });
    });
    setProgress(100, 'Done — board resetting'); setSerial('ok', 'Done — board resetting');
    log('✅ Upload complete. Board boots clip 1; join WiFi to switch.');
    uploadedOk = true;
  } catch (e) {
    setSerial('err', 'Flash failed'); progressError('Flash failed — see log');
    log('❌ ' + (e && e.message ? e.message : e));
    log('Tip: unplug/replug, or hold BOOT + tap RST, then Connect again.');
    serial.port = null; serial.connected = false;
  } finally { serial.busy = false; $('connectBtn').disabled = false; updateBudget(); if (uploadedOk) setTimeout(readBoard, 400); }
}

// ==========================================================================
// Read / delete what's on the board
// ==========================================================================
let board = null;   // { raw:Uint8Array(4096), count, ssid, clips:[{name,offset,size,hdr,thumb}] }

function u16le(a, o) { return a[o] | (a[o+1] << 8); }
function u32le(a, o) { return (a[o] | (a[o+1]<<8) | (a[o+2]<<16) | (a[o+3]<<24)) >>> 0; }
function readStr(a, o, n) { let s = ''; for (let i = 0; i < n; i++) { const c = a[o+i]; if (!c) break; s += String.fromCharCode(c); } return s; }

function parseBoard(hd) {
  const st = { raw: hd, count: 0, ssid: '', clips: [] };
  if (hd[0]===0x54 && hd[1]===0x44 && hd[2]===0x50 && hd[3]===0x4C) {        // "TDPL"
    st.count = hd[5]; st.ssid = readStr(hd, 12, hd[9]);
    for (let i = 0; i < st.count; i++) {
      const e = DIR_OFFSET + i * DIR_ENTRY;
      st.clips.push({ name: readStr(hd, e+8, 24) || ('Clip '+(i+1)), offset: u32le(hd, e), size: u32le(hd, e+4), hdr: null, thumb: null });
    }
  } else if (hd[0]===0x54 && hd[1]===0x44 && hd[2]===0x53 && hd[3]===0x31) { // legacy "TDS1"
    st.count = 1; st.clips.push({ name: 'Clip 1', offset: 0, size: 0, hdr: null, thumb: null });
  }
  return st;
}

function parseClipHeader(a) {
  return { format: a[5], rotation: a[6], W: u16le(a,8), H: u16le(a,10), frameCount: u16le(a,12), frameBytes: u32le(a,16) };
}

async function loadBoardThumb(loader, clip) {
  const abs = MEDIA_OFFSET + clip.offset;
  const hdrBytes = await loader.readFlash(abs, HEADER_SIZE);
  const h = parseClipHeader(hdrBytes); clip.hdr = h;
  const img = new ImageData(h.W, h.H), d = img.data;
  if (h.format === FMT_MONO1) {
    const data = await loader.readFlash(abs + HEADER_SIZE, h.frameBytes), rb = (h.W+7)>>3;
    for (let y = 0; y < h.H; y++) for (let x = 0; x < h.W; x++) { const on = data[y*rb + (x>>3)] & (0x80 >> (x&7)); const p = (y*h.W+x)*4; d[p]=d[p+1]=d[p+2]= on?255:0; d[p+3]=255; }
  } else if (h.format === FMT_PAL8_RLE) {
    const pal = await loader.readFlash(abs + HEADER_SIZE, 512);
    const szBytes = await loader.readFlash(abs + HEADER_SIZE + 512, 4);
    const size0 = u32le(szBytes, 0);
    const blob = await loader.readFlash(abs + HEADER_SIZE + 512 + h.frameCount*4, size0);
    let p = 0;
    for (let j = 0; j+1 < blob.length && p < h.W*h.H; j += 2) { let cnt = blob[j]; const c = u16le(pal, blob[j+1]*2); const r=((c>>11)&0x1f)<<3,g=((c>>5)&0x3f)<<2,b=(c&0x1f)<<3; while (cnt-- && p < h.W*h.H) { const q=p*4; d[q]=r;d[q+1]=g;d[q+2]=b;d[q+3]=255; p++; } }
  } else {                                                                   // RGB565
    const data = await loader.readFlash(abs + HEADER_SIZE, h.frameBytes);
    for (let p = 0, j = 0; p < h.W*h.H; p++, j += 2) { const c = data[j] | (data[j+1]<<8); const q=p*4; d[q]=((c>>11)&0x1f)<<3; d[q+1]=((c>>5)&0x3f)<<2; d[q+2]=(c&0x1f)<<3; d[q+3]=255; }
  }
  const c = document.createElement('canvas'); c.width = h.W; c.height = h.H; c.getContext('2d').putImageData(img, 0, 0);
  clip.thumb = c;
}

async function readBoard() {
  if (!serial.port || serial.busy) return;
  serial.busy = true; setSerial('busy', 'Reading board…');
  $('boardStrip').style.display = ''; $('boardList').innerHTML = '<div class="small muted">Reading playlist…</div>';
  try {
    await withLoader(async (loader) => {
      const hd = await loader.readFlash(MEDIA_OFFSET, CLIP_DATA_START);
      board = parseBoard(hd);
      renderBoard();
      for (const clip of board.clips) { try { await loadBoardThumb(loader, clip); } catch (e) { log('Thumb read failed: '+e.message); } renderBoard(); }
    });
    setSerial('ok', board && board.count ? `Board: ${board.count} clip(s)` : 'Board empty');
  } catch (e) { setSerial('err', 'Read failed'); log('Board read failed: ' + (e.message||e)); }
  finally { serial.busy = false; }
}

function renderBoard() {
  const host = $('boardList');
  if (!board || !board.count) { host.innerHTML = '<div class="small muted">No playlist on the board.</div>'; $('boardCount').textContent=''; $('boardUsage').textContent=''; return; }
  $('boardCount').textContent = board.count + (board.ssid ? ' · '+board.ssid : '');
  const used = CLIP_DATA_START + board.clips.reduce((a, c) => a + c.size, 0);
  const pct = (used / MEDIA_MAX) * 100;
  const bar = $('boardUsageBar');
  $('boardUsage').innerHTML = `Storage <b>${(used/1e6).toFixed(2)} MB</b> / ${(MEDIA_MAX/1e6).toFixed(1)} MB · <b>${pct.toFixed(1)}%</b>`;
  if (bar) { bar.style.width = clamp(pct, 0, 100) + '%'; bar.classList.toggle('err', used > MEDIA_MAX); }
  host.innerHTML = '';
  board.clips.forEach((clip, i) => {
    const el = document.createElement('div'); el.className = 'bclip';
    el.innerHTML = `<canvas width="96" height="56"></canvas><button class="bdel" title="Delete from board">✕</button>
      <div class="bname">${escapeHtml(clip.name)}</div><div class="bsize">${(clip.size/1e6).toFixed(2)} MB</div>`;
    const cv = el.querySelector('canvas'), cx = cv.getContext('2d');
    cx.fillStyle = '#000'; cx.fillRect(0,0,96,56);
    if (clip.thumb) { const s = Math.min(96/clip.thumb.width, 56/clip.thumb.height), dw = clip.thumb.width*s, dh = clip.thumb.height*s; cx.drawImage(clip.thumb, (96-dw)/2, (56-dh)/2, dw, dh); }
    el.querySelector('.bdel').addEventListener('click', () => deleteFromBoard(i));
    host.appendChild(el);
  });
}

async function deleteFromBoard(index) {
  if (!board || !board.raw || serial.busy) return;
  if (!confirm(`Delete "${board.clips[index].name}" from the board?\n(Its space is reclaimed on your next full upload.)`)) return;
  serial.busy = true; setSerial('busy', 'Deleting…');
  try {
    const sector = new Uint8Array(CLIP_DATA_START);
    sector.set(board.raw.subarray(0, CLIP_DATA_START));
    const count = sector[5];
    for (let i = index; i < count - 1; i++) sector.copyWithin(DIR_OFFSET + i*DIR_ENTRY, DIR_OFFSET + (i+1)*DIR_ENTRY, DIR_OFFSET + (i+2)*DIR_ENTRY);
    sector.fill(0, DIR_OFFSET + (count-1)*DIR_ENTRY, DIR_OFFSET + count*DIR_ENTRY);
    sector[5] = count - 1;
    await withLoader(async (loader) => {
      await loader.writeFlash({ fileArray: [{ data: binStr(sector), address: MEDIA_OFFSET }], flashSize: 'keep', eraseAll: false, compress: true });
    });
    log(`Deleted clip ${index+1} from the board.`);
  } catch (e) { setSerial('err', 'Delete failed'); log('Delete failed: ' + (e.message||e)); serial.busy = false; return; }
  serial.busy = false;
  await readBoard();
}

// ==========================================================================
// UI helpers + wiring
// ==========================================================================
function setSerial(cls, text) { $('serialDot').className = 'status-dot ' + cls; $('serialState').textContent = text; }
function log(m) { const l = $('log'); l.textContent += (l.textContent?'\n':'') + m; l.scrollTop = l.scrollHeight; }
function logInline(m) { const l = $('log'); l.textContent += m; l.scrollTop = l.scrollHeight; }
function showProgress(on) { $('progWrap').style.display = on ? '' : 'none'; $('progBar').classList.remove('err'); }
function setProgress(pct, text) { $('progBar').style.width = clamp(pct,0,100) + '%'; if (text != null) $('progText').textContent = text; }
function progressError(text) { $('progBar').classList.add('err'); if (text) $('progText').textContent = text; }

function bindRange(id, key, fmt, after) {
  const el = $(id), lbl = $(id + 'V');
  const apply = () => { const e = E(); if (!e) return; e[key] = parseFloat(el.value); if (lbl) lbl.textContent = fmt ? fmt(e[key]) : e[key]; (after || rebuild)(); };
  el.addEventListener('input', apply);
  // Double-click a slider to reset to its default.
  el.addEventListener('dblclick', () => { if (id in SLIDER_DEFAULTS) { el.value = SLIDER_DEFAULTS[id]; apply(); } });
}

function reprocessActiveVideo() {
  const clip = clips[active];
  if (!clip || clip.srcType !== 'video') { rebuild(); return; }
  $('renderState').textContent = 'Re-sampling video…';
  decodeInto(clip).then(() => { $('renderState').textContent = ''; doRebuild(); });
}

function initUI() {
  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', e => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ''; });
  ['dragover','dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  $('orient').addEventListener('change', e => { const ed = E(); if (!ed) return; ed.rotation = parseInt(e.target.value,10); rebuild(); });
  document.querySelectorAll('#fitSeg button').forEach(b => b.addEventListener('click', () => { const ed = E(); if (!ed) return; segSet('fitSeg','fit',b.dataset.fit); ed.fit = b.dataset.fit; rebuild(); }));
  document.querySelectorAll('#colorSeg button').forEach(b => b.addEventListener('click', () => {
    const ed = E(); if (!ed) return; segSet('colorSeg','mode',b.dataset.mode); ed.mode = b.dataset.mode;
    $('colorControls').style.display = ed.mode === 'color' ? '' : 'none';
    $('monoControls').style.display = ed.mode === 'mono' ? '' : 'none';
    rebuild();
  }));
  document.querySelectorAll('#compressSeg button').forEach(b => b.addEventListener('click', () => {
    const ed = E(); if (!ed) return; segSet('compressSeg','compress',b.dataset.compress); ed.compress = b.dataset.compress; rebuild();
  }));

  bindRange('zoom', 'zoom', v => v.toFixed(2)+'×');
  bindRange('rot', 'rotate', v => v+'°');
  bindRange('bright', 'bright', v => ''+v);
  bindRange('contrast', 'contrast', v => ''+v);
  bindRange('thresh', 'thresh', v => ''+v);
  bindRange('fps', 'fps', v => v+' fps', reprocessActiveVideo);
  bindRange('maxFrames', 'maxFrames', v => ''+v, reprocessActiveVideo);
  $('dither').addEventListener('change', e => { const ed = E(); if (ed) { ed.dither = e.target.checked; rebuild(); } });
  $('invert').addEventListener('change', e => { const ed = E(); if (ed) { ed.invert = e.target.checked; rebuild(); } });

  $('rot90').addEventListener('click', () => { const ed = E(); if (!ed) return; ed.rotate = ((ed.rotate + 90 + 180) % 360) - 180; setRange('rot', ed.rotate, v=>v+'°'); rebuild(); });
  $('resetGeo').addEventListener('click', () => { const ed = E(); if (!ed) return; ed.zoom=1; ed.rotate=0; ed.panX=0; ed.panY=0; setRange('zoom',1,v=>v.toFixed(2)+'×'); setRange('rot',0,v=>v+'°'); rebuild(); });

  let dragging = false, lx = 0, ly = 0;
  pc.addEventListener('pointerdown', e => { if (!E()) return; dragging = true; lx = e.clientX; ly = e.clientY; pc.setPointerCapture(e.pointerId); pc.classList.add('drag'); });
  pc.addEventListener('pointermove', e => { if (!dragging) return; const ed = E(); ed.panX += (e.clientX-lx)/ui.viewScale; ed.panY += (e.clientY-ly)/ui.viewScale; lx = e.clientX; ly = e.clientY; rebuild(); });
  const endDrag = () => { dragging = false; pc.classList.remove('drag'); };
  pc.addEventListener('pointerup', endDrag); pc.addEventListener('pointercancel', endDrag);

  $('playPause').addEventListener('click', () => { ui.playing = !ui.playing; $('playPause').textContent = ui.playing ? '⏸ Pause' : '▶ Play'; });
  $('zoomView').addEventListener('click', () => { ui.viewScale = ui.viewScale >= 3 ? 1 : ui.viewScale + 1; $('zoomView').textContent = `View ${ui.viewScale}×`; const c = clips[active]; if (c) sizePreview(...Object.values(clipDims(c.edit))); });

  ['vStart','vEnd'].forEach(id => $(id).addEventListener('change', () => { const ed = E(); if (!ed) return; ed.vStart = parseFloat($('vStart').value)||0; ed.vEnd = parseFloat($('vEnd').value)||0; reprocessActiveVideo(); }));

  $('connectBtn').addEventListener('click', async () => { await connect(); if (serial.port) readBoard(); });
  $('boardRefresh').addEventListener('click', readBoard);
  $('uploadBtn').addEventListener('click', upload);
  $('downloadBin').addEventListener('click', () => {
    if (!clips.length) return;
    const blob = new Blob([packPlaylist()], { type: 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'playlist.bin'; a.click(); URL.revokeObjectURL(a.href);
  });

  renderPlaylist();
  requestAnimationFrame(tickPreview);
  if (!('serial' in navigator)) log('⚠ Web Serial not detected. Open in Chrome/Edge to flash.');
}

initUI();

})();
