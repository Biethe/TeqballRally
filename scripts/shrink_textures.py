#!/usr/bin/env python3
"""Cap the texture resolution inside a .glb.

Why this exists: a 2048x2048 texture is ~1 MB as WebP on disk but 16 MB of
RGBA once the GPU has it, and ~21 MB with mipmaps. Each character here carries
eleven of them, so two players on court cost far more memory than the 4-8 MB
file sizes suggest. Capping the longest side at 1024 is a 4x cut, and the
characters are only a couple of hundred pixels tall on a phone.

Requires Pillow (`pip install Pillow`). Run it on a copy first and eyeball the
result -- this is a lossy, visual change.

    python3 scripts/shrink_textures.py assets/models/characters/*.glb
    python3 scripts/shrink_textures.py --max 512 --dry-run some.glb

Layout assumption, verified per file: every image lives in buffer 0 and the
whole EXT_meshopt_compression region sits after the last image. That lets the
compressed geometry move as one block with a single offset delta, so nothing
has to understand meshopt's internals.
"""

from __future__ import annotations

import argparse
import io
import json
import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - tooling guard
    sys.exit("Pillow is required: pip install Pillow")

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError(f"{path}: not a GLB")
    offset, gltf, binary = 12, None, b""
    while offset < len(data):
        clen, ctype = struct.unpack_from("<II", data, offset)
        payload = data[offset + 8 : offset + 8 + clen]
        if ctype == JSON_CHUNK:
            gltf = json.loads(payload)
        elif ctype == BIN_CHUNK:
            binary = payload
        offset += 8 + clen + (-clen % 4)
    if gltf is None:
        raise ValueError(f"{path}: no JSON chunk")
    return gltf, binary


def write_glb(path: Path, gltf: dict, binary: bytes) -> None:
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + (8 + len(binary) if binary else 0)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js), JSON_CHUNK) + js
    if binary:
        out += struct.pack("<II", len(binary), BIN_CHUNK) + binary
    path.write_bytes(bytes(out))


def resize_webp(raw: bytes, max_side: int, quality: int) -> bytes | None:
    """Return re-encoded bytes, or None when the image is already small enough."""
    img = Image.open(io.BytesIO(raw))
    if max(img.size) <= max_side:
        return None
    scale = max_side / max(img.size)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    img = img.resize(size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()


def meshopt_regions(gltf: dict) -> list[dict]:
    out = []
    for bv in gltf.get("bufferViews", []):
        ext = bv.get("extensions", {}).get("EXT_meshopt_compression")
        if ext is not None:
            out.append(ext)
    return out


def process(path: Path, max_side: int, quality: int, dry_run: bool) -> None:
    gltf, binary = read_glb(path)
    views = gltf.get("bufferViews", [])
    images = [im for im in gltf.get("images", []) if "bufferView" in im]
    if not images:
        print(f"{path.name}: no embedded images, skipped")
        return

    image_views = {im["bufferView"] for im in images}
    for i in image_views:
        if views[i].get("buffer", 0) != 0:
            raise ValueError(f"{path}: image bufferView {i} is not in buffer 0")

    # Everything meshopt-compressed must start after the last image byte, so the
    # compressed span can be relocated wholesale.
    last_image_end = max(views[i].get("byteOffset", 0) + views[i]["byteLength"] for i in image_views)
    regions = meshopt_regions(gltf)
    compressed_start = min((r["byteOffset"] for r in regions), default=last_image_end)
    if regions and compressed_start < last_image_end:
        raise ValueError(f"{path}: meshopt data is interleaved with images, cannot relocate safely")
    for r in regions:
        if r.get("buffer", 0) != 0:
            raise ValueError(f"{path}: meshopt region is not in buffer 0")

    # Re-encode, keeping the original bytes for anything already small enough.
    new_bytes: dict[int, bytes] = {}
    saved = 0
    for im in images:
        bv = views[im["bufferView"]]
        start = bv.get("byteOffset", 0)
        raw = binary[start : start + bv["byteLength"]]
        try:
            replacement = resize_webp(raw, max_side, quality)
        except Exception as e:  # a texture format Pillow cannot read stays untouched
            print(f"  ! {path.name} image bv{im['bufferView']}: {e}, left as is")
            replacement = None
        if replacement is None or len(replacement) >= len(raw):
            new_bytes[im["bufferView"]] = raw
        else:
            new_bytes[im["bufferView"]] = replacement
            saved += len(raw) - len(replacement)

    if dry_run:
        print(f"{path.name}: would save {saved / 1e6:.2f} MB on disk")
        return

    # Rebuild buffer 0: images first (in their original order), then the
    # untouched compressed block shifted by a single delta.
    out = bytearray()
    for i in sorted(image_views):
        out += b"\x00" * (-len(out) % 4)
        views[i]["byteOffset"] = len(out)
        views[i]["byteLength"] = len(new_bytes[i])
        out += new_bytes[i]
    out += b"\x00" * (-len(out) % 4)
    delta = len(out) - compressed_start
    out += binary[compressed_start:]
    for r in regions:
        r["byteOffset"] += delta

    gltf["buffers"][0]["byteLength"] = len(out)
    before = path.stat().st_size
    write_glb(path, gltf, bytes(out))
    after = path.stat().st_size
    print(f"{path.name}: {before / 1e6:.2f} MB -> {after / 1e6:.2f} MB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--max", type=int, default=1024, help="longest texture side (default 1024)")
    ap.add_argument("--quality", type=int, default=90, help="WebP quality (default 90)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    for f in args.files:
        process(f, args.max, args.quality, args.dry_run)


if __name__ == "__main__":
    main()
