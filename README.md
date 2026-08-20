# T-Display-S3 Media Uploader

A browser tool that ingests **images, GIFs, and videos**, lets you **crop, scale,
rotate, threshold** and tune each one, builds a **playlist**, then **flashes it to
the LilyGO T-Display-S3** over USB (Web Serial). The board loops the first clip and
hosts a tiny **WiFi web page** to switch clips live.

No Arduino IDE, no PlatformIO, no recompiling per clip — the board runs a small
**player firmware** (installed once) that reads clips from a dedicated `media`
flash partition. Each upload just rewrites that partition, which takes seconds.

## Use it online (GitHub Pages)

Hosted at **https://aaronmylespereira.github.io/DisplayUploader/** — open it in
**Chrome or Edge**, plug in the board, and flash. GitHub Pages serves over HTTPS,
which is a secure context, so Web Serial works with no local server needed.

To enable Pages on your fork: repo **Settings → Pages → Build and deployment →
Source: Deploy from a branch → Branch: `main` / folder `/ (root)` → Save**. The
site goes live at `https://<user>.github.io/<repo>/` after a minute. (The repo must
be public, or you need GitHub Pro for private Pages.)

## Quick start (local)

1. Plug the T-Display-S3 into USB.
2. Double-click **`serve.command`** (or run `python3 -m http.server 8123` in this
   folder) and open **http://localhost:8123** in **Chrome or Edge**.
   *(Web Serial is not supported in Safari or Firefox.)*
3. **Add clips** — drop or pick one or more images / GIFs / videos (up to 16).
4. **Select a clip** in the playlist to edit it. Each clip keeps its own settings:
   orientation, fit, zoom, rotate, drag-to-pan (crop), color vs. mono (threshold +
   dither), brightness/contrast, FPS, and frame count. Rename a clip inline (the
   name shows on the web page). Reorder with **↑**, remove with **✕**. Clip 1 is
   the default that plays on boot. **Double-click any slider to reset it.**
5. Watch the **flash budget** meter — all clips share ~13.9 MB.
6. Set the **WiFi name (SSID)**, click **Connect**, pick the board's serial port,
   then **Upload playlist ▸**.
   - **First time on a fresh board:** tick **"Also (re)install player firmware"**
     for the first upload. After that, leave it unchecked.
7. The board resets and loops clip 1.

### Switching clips over WiFi

The board creates an **open WiFi network** named by your SSID (default
`T-Display-S3`). Join it from a phone/laptop and browse to **http://192.168.4.1** —
you get a list of your clips; tap one and the display switches to it (it loops
until you pick another). On power-up it always starts on clip 1.

### On-board buttons

| Button | Short press | Long press (≥1.5 s) |
|--------|-------------|---------------------|
| **BOOT (GPIO0)** | Play / pause the current clip | **Scramble** — jumble the screen into a shuffled 5×3 tile grid (re-shuffles each long-press; animation keeps playing inside the tiles) |
| **Side (GPIO14)** | Next clip | **Un-scramble** — restore the normal image |

### What's on the board (thumbnails + usage + delete)

After you **Connect**, the tool reads the board's playlist and shows an **"On the
board"** strip below the preview: the clip names/sizes appear immediately, a real
thumbnail of each clip streams in, and a **storage bar** shows how full the media
partition is (MB + %). Click a clip's **✕** to delete it from the board (a fast
directory rewrite; the freed space is reclaimed on your next full upload). Reading
the board briefly pauses playback while it talks to the bootloader.

### Compression (color clips)

Each color clip has a **Compress** control:
- **Auto** — encodes with a 256-color palette + RLE when that's smaller than raw
  (huge wins for GIFs/flat graphics; may reduce a many-color clip to 256 colors).
- **Off** — full RGB565, no quantization.
Mono clips are always 1-bit. The playlist row shows the achieved ratio (e.g.
`palette 6.2×`). This is why a 1 MB GIF can be ~6 MB raw but far smaller with Auto:
raw stores every frame as uncompressed 2-bytes-per-pixel; palette+RLE brings it
much closer to the GIF's own compression.

If flashing fails to connect: unplug/replug, or hold **BOOT**, tap **RST**,
release **BOOT**, then Connect again.

## How much fits?

The `media` partition is **~13.9 MB**.

| Mode          | Bytes/frame (320×170) | Approx. max frames |
|---------------|-----------------------|--------------------|
| Color (RGB565)| ~106 KB               | ~135               |
| Mono (1-bit)  | ~6.6 KB               | ~2000+             |

So color is good for short, smooth loops (~10 s @ 12 fps); mono fits long loops.

## Files

| File | Purpose |
|------|---------|
| `lilygoDisplay.html` | The tool UI |
| `app.js` | Decode, edit pipeline, media packing, Web Serial flashing |
| `esptool-bundle.js` | [esptool-js](https://github.com/espressif/esptool-js) (vendored, classic-script build) |
| `player-firmware.js` | The compiled player firmware (base64) the tool installs |
| `serve.command` | Double-click launcher (local server + opens Chrome) |
| `pack_firmware.py` | Regenerates `player-firmware.js` after rebuilding the player |

## Player firmware

Source: [`examples/T-Display-S3-Player/`](../../examples/T-Display-S3-Player/)
(PlatformIO env `T-Display-S3-Player`, partition table `partitions.csv`).

Rebuild + repack after changing it:

```bash
PLATFORMIO_SRC_DIR=examples/T-Display-S3-Player \
  ~/.platformio/penv/bin/pio run -e T-Display-S3-Player
python3 tools/tdisplay-uploader/pack_firmware.py
```

## Media binary format

Written to the `media` partition at `0x210000`. Little-endian. A **playlist
container** (`TDPL`) holds a config header, a 16-slot clip directory, and the clip
blobs. The firmware also accepts a bare `TDS1` clip (single-clip, WiFi off).

**Playlist header (128 bytes @ 0):** `TDPL`, version, clipCount, defaultIndex,
flags, wifiMode (1 = SoftAP open), ssidLen, passLen, then `ssid[32]`, `pass[32]`.

**Clip directory (16 × 32 bytes @ 128):** per clip — `offset` (u32, from partition
start), `size` (u32), `name[24]`. Clip blobs begin at `0x1000`.

**Clip blob = `TDS1` (32-byte header + frames):**

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | magic `"TDS1"` |
| 4 | 1 | version (1) |
| 5 | 1 | format: 0 = RGB565, 1 = mono 1-bit |
| 6 | 1 | rotation (0–3, `setRotation`) |
| 7 | 1 | reserved |
| 8 | 2 | width |
| 10 | 2 | height |
| 12 | 2 | frame count |
| 14 | 2 | frame delay (ms) |
| 16 | 4 | bytes per stored frame |
| 20 | 12 | reserved |
| 32 | … | frame data |

Formats (byte 5): **0 = RGB565** raw (native LE `uint16`); **1 = mono 1-bit**
(MSB-first, rows padded to a byte, set bit = white); **3 = PAL8_RLE**. Each clip
has its own format/orientation/FPS.

**PAL8_RLE layout** (after the 32-byte header): a 256-entry palette (`uint16`
RGB565, 512 bytes), then a per-frame size table (`frameCount × uint32`), then the
frame blobs. Each blob is a run-length stream of `[count][index]` byte pairs
(`count` 1–255) that expands to `width × height` palette indices. `frameBytes` in
the header holds the largest blob size (for the firmware's read buffer).

## On the board

- **Core 1** (Arduino `loop`) drives the display: reads the current clip's frames
  from flash and paces them to the exact frame period.
- **Core 0** runs the WiFi SoftAP + a `WebServer` (`/` control page, `/status`
  JSON, `/set?i=N`) that sets a shared `volatile` current-clip index.
