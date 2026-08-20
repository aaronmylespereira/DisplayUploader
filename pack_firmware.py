#!/usr/bin/env python3
"""Regenerate player-firmware.js from the compiled player firmware.

Run after rebuilding the player env (from the T-Display-S3 project root):
    PLATFORMIO_SRC_DIR=examples/T-Display-S3-Player \
        ~/.platformio/penv/bin/pio run -e T-Display-S3-Player
    python3 <path-to>/DisplayUploader/pack_firmware.py
The build directory is found by walking up from this script.
"""
import base64, os, sys


def find_build():
    """Walk up from this file to find the PlatformIO build output."""
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(8):
        cand = os.path.join(d, '.pio', 'build', 'T-Display-S3-Player')
        if os.path.isfile(os.path.join(cand, 'firmware.bin')):
            return cand
        d = os.path.dirname(d)
    sys.exit("Could not find .pio/build/T-Display-S3-Player/firmware.bin — build the "
             "T-Display-S3-Player env first.")


BUILD = find_build()
BOOT0 = os.path.expanduser(
    '~/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin')
OUT = os.path.join(os.path.dirname(__file__), 'player-firmware.js')

PARTS = [
    (0x0,     os.path.join(BUILD, 'bootloader.bin')),
    (0x8000,  os.path.join(BUILD, 'partitions.bin')),
    (0xe000,  BOOT0),
    (0x10000, os.path.join(BUILD, 'firmware.bin')),
]


def main():
    lines = [
        "// Auto-generated: T-Display-S3 player firmware images (base64) + flash offsets.",
        "// Regenerate with tools/tdisplay-uploader/pack_firmware.py after rebuilding the player.",
        "window.PLAYER_FIRMWARE = [",
    ]
    total = 0
    for off, path in PARTS:
        data = open(path, 'rb').read()
        total += len(data)
        b64 = base64.b64encode(data).decode()
        lines.append(f"  {{ offset: {off}, name: {os.path.basename(path)!r}, "
                     f"size: {len(data)}, data: \"{b64}\" }},")
    lines.append("];")
    open(OUT, 'w').write("\n".join(lines) + "\n")
    print(f"wrote {OUT}  ({total} bytes of firmware)")


if __name__ == '__main__':
    main()
