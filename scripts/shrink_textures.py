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

The buffer is rebuilt by walking every referenced span in its existing order,
so no assumption is made about where images sit relative to geometry. An
earlier version assumed images came first, which was true of the character
models and false of the arenas, and it silently dropped every mesh of the
files where it was false. The byte-count check at the end of `process` is what
makes that failure impossible to repeat quietly.
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


def buffer_chunks(gltf: dict) -> list[dict]:
    """
    Every span of buffer 0 that something points at.

    A bufferView normally addresses its own bytes. Under
    EXT_meshopt_compression it instead describes the *decompressed* result and
    its extension points at the compressed source, with the view itself
    referring to a data-less fallback buffer. Both forms are collected here so
    a rebuild can relocate either without understanding meshopt itself.
    """
    chunks = []
    for index, bv in enumerate(gltf.get("bufferViews", [])):
        ext = bv.get("extensions", {}).get("EXT_meshopt_compression")
        if ext is not None:
            if ext.get("buffer", 0) == 0:
                chunks.append({"holder": ext, "view": index, "image": False})
        elif bv.get("buffer", 0) == 0:
            chunks.append({"holder": bv, "view": index, "image": False})
    return chunks


def process(path: Path, max_side: int, quality: int, dry_run: bool) -> None:
    gltf, binary = read_glb(path)
    views = gltf.get("bufferViews", [])
    images = [im for im in gltf.get("images", []) if "bufferView" in im]
    if not images:
        print(f"{path.name}: no embedded images, skipped")
        return

    image_views = {im["bufferView"] for im in images}
    chunks = buffer_chunks(gltf)
    for c in chunks:
        c["image"] = c["view"] in image_views

    # Re-encode, keeping the original bytes for anything already small enough.
    replacement: dict[int, bytes] = {}
    saved = 0
    for im in images:
        bv = views[im["bufferView"]]
        start = bv.get("byteOffset", 0)
        raw = binary[start : start + bv["byteLength"]]
        try:
            smaller = resize_webp(raw, max_side, quality)
        except Exception as e:  # a format Pillow cannot read stays untouched
            print(f"  ! {path.name} image bv{im['bufferView']}: {e}, left as is")
            smaller = None
        if smaller is None or len(smaller) >= len(raw):
            replacement[im["bufferView"]] = raw
        else:
            replacement[im["bufferView"]] = smaller
            saved += len(raw) - len(smaller)

    if dry_run:
        print(f"{path.name}: would save {saved / 1e6:.2f} MB on disk")
        return

    # Rebuild the buffer by walking every chunk in its existing order, so a
    # layout this script has not seen cannot silently lose data. An earlier
    # version assumed images came first and dropped the geometry of any file
    # where they did not.
    kept_before = sum(
        c["holder"]["byteLength"] for c in chunks if not c["image"]
    )
    chunks.sort(key=lambda c: c["holder"].get("byteOffset", 0))

    out = bytearray()
    kept_after = 0
    for c in chunks:
        holder = c["holder"]
        old_offset = holder.get("byteOffset", 0)
        old_length = holder["byteLength"]
        data = replacement[c["view"]] if c["image"] else binary[old_offset : old_offset + old_length]
        if not c["image"]:
            if len(data) != old_length:
                raise ValueError(f"{path}: chunk {c['view']} truncated by the read")
            kept_after += len(data)
        out += b"\x00" * (-len(out) % 4)
        holder["byteOffset"] = len(out)
        holder["byteLength"] = len(data)
        out += data

    # Every non-image byte that went in must come out. This is the check the
    # first version lacked, and it would have caught the whole failure.
    if kept_after != kept_before:
        raise ValueError(
            f"{path}: {kept_before - kept_after} bytes of geometry lost; refusing to write"
        )

    gltf["buffers"][0]["byteLength"] = len(out)
    before = path.stat().st_size
    write_glb(path, gltf, bytes(out))
    print(f"{path.name}: {before / 1e6:.2f} MB -> {path.stat().st_size / 1e6:.2f} MB")


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
