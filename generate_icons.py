"""Regenerates the ReelHop icon PNGs (icons/icon{16,48,128}.png).

The mark is a "hop": a teal arc leaving one dot and landing on another, on a
dark rounded square. Pure Python (no Pillow) with 4x4 supersampling so the
curves stay smooth even at 16px.
"""
import os
import struct
import zlib

BG = (27, 32, 38)        # dark slate, matches the Letterboxd / popup palette
ACCENT = (62, 207, 178)  # ReelHop teal
SUPERSAMPLE = 4


def write_png(width, height, pixels, filename):
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type: none
        for x in range(width):
            raw.extend(pixels[y][x])
    png = b'\x89PNG\r\n\x1a\n'

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))

    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(filename, 'wb') as f:
        f.write(png)


def in_rounded_square(nx, ny, radius=0.18):
    dx, dy = abs(nx - 0.5), abs(ny - 0.5)
    inner = 0.5 - radius
    if dx <= inner and dy <= 0.5:
        return True
    if dy <= inner and dx <= 0.5:
        return True
    return (dx - inner) ** 2 + (dy - inner) ** 2 <= radius ** 2


def in_mark(nx, ny):
    """The hop: an arc from the left dot up and over to the right dot."""
    cx, cy = 0.5, 0.68
    r_inner, r_outer = 0.24, 0.36
    dist = ((nx - cx) ** 2 + (ny - cy) ** 2) ** 0.5
    if r_inner <= dist <= r_outer and (cy - ny) >= 0.03:
        return True
    dot_r = 0.085
    for dot_x in (0.20, 0.80):
        if (nx - dot_x) ** 2 + (ny - cy) ** 2 <= dot_r ** 2:
            return True
    return False


def sample(nx, ny):
    if not in_rounded_square(nx, ny):
        return (0, 0, 0, 0)
    if in_mark(nx, ny):
        return ACCENT + (255,)
    return BG + (255,)


def render(size):
    rows = []
    n = SUPERSAMPLE
    for y in range(size):
        row = []
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(n):
                for sx in range(n):
                    nx = (x + (sx + 0.5) / n) / size
                    ny = (y + (sy + 0.5) / n) / size
                    r, g, b, a = sample(nx, ny)
                    # premultiplied accumulation so edge pixels blend correctly
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            total = n * n
            a = acc[3] / total
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((round(acc[0] / acc[3]), round(acc[1] / acc[3]),
                            round(acc[2] / acc[3]), round(a)))
        rows.append(row)
    return rows


def upscale(pixels, factor):
    return [[px for px in row for _ in range(factor)] for row in pixels for _ in range(factor)]


if __name__ == '__main__':
    import sys
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 48, 128):
        write_png(size, size, render(size), os.path.join(out_dir, f'icon{size}.png'))
    print('Icons generated successfully!')
    # Optional: --preview DIR writes a 16px icon blown up 8x for eyeballing.
    if '--preview' in sys.argv:
        preview_dir = sys.argv[sys.argv.index('--preview') + 1]
        write_png(128, 128, upscale(render(16), 8), os.path.join(preview_dir, 'icon16_x8.png'))
        print('Preview written.')
