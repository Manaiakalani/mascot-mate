"""Build Bob the Blob mascot from a clean 6x4 labeled grid.

Source: src/mascots/bob/_source.png (1491x1055 RGB) — 24 cells (6 cols x 4 rows)
numbered 1..24 in top-left of each cell. Yellow smiley w/ glasses on white bg.

Output: src/mascots/bob/{map.png, map.json}
"""
from PIL import Image, ImageDraw
from pathlib import Path
import json
import numpy as np

SRC = Path('/Users/max/mascot/widget/src/mascots/bob/_source.png')
OUT_DIR = Path('/Users/max/mascot/widget/src/mascots/bob')

COLS, ROWS = 6, 4
N = COLS * ROWS  # 24
TARGET_H = 186          # match Ninjacat sprite-sheet height
PAD_RATIO = 0.06         # 6% pad on each side
INNER_TRIM = 4           # px inset from each cell edge to avoid grid-separator lines
LABEL_W_RATIO = 0.24     # mask box for cell-number label (wide enough for 2-digit "13".."24")
LABEL_H_RATIO = 0.22


def remove_white_bg(im: Image.Image) -> Image.Image:
    """Remove white background AND drop-shadow grey, with un-premultiplication.

    The source has a soft greyscale drop-shadow under the smiley body that
    leaves a halo if we only key out white. We treat low-saturation high-
    luminance pixels (white + grey shadow) as background; saturated colors
    (yellow body) and dark colors (glasses, mouth, glove outlines) survive.
    """
    arr = np.asarray(im.convert('RGB'), dtype=np.float32)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    chroma = mx - mn          # 0 for white/grey, high for yellow
    brightness = (r + g + b) / 3.0

    # Saturated pixels get full alpha (yellow body, red mouth)
    sat_a = np.clip((chroma - 8.0) / 22.0, 0.0, 1.0)
    sat_a = sat_a * sat_a * (3.0 - 2.0 * sat_a)
    # Dark greyscale pixels survive too (black glasses, mouth outlines)
    # smoothstep DOWN: bright→0, dark→1
    dark_a = np.clip((90.0 - brightness) / 50.0, 0.0, 1.0)
    dark_a = dark_a * dark_a * (3.0 - 2.0 * dark_a)
    a = np.maximum(sat_a, dark_a)
    # Aggressively kill the mid-tone grey halo left by the source shadow.
    # Anything that is low-saturation AND not already nearly-opaque-dark gets
    # forced to zero alpha. This removes the visible grey ring that was
    # leaking around Bob's body while preserving black outlines (bright<40)
    # and yellow body (chroma>=24).
    grey_halo = (chroma < 24.0) & (brightness > 40.0)
    a = np.where(grey_halo, 0.0, a)
    # Also fully clamp anything below a very small alpha to zero (prevents
    # 1-2 alpha "dust" from appearing when the sheet is upscaled).
    a = np.where(a < 0.06, 0.0, a)
    alpha = (a * 255.0).astype(np.uint8)
    # Un-premultiply against white bg: true = (obs - 255*(1-a)) / a
    a3 = a[..., None]
    safe = np.where(a3 > 1e-3, a3, 1.0)
    true_rgb = (arr - 255.0 * (1.0 - a3)) / safe
    true_rgb = np.clip(true_rgb, 0.0, 255.0).astype(np.uint8)
    rgba = np.concatenate([true_rgb, alpha[..., None]], axis=-1)
    return Image.fromarray(rgba, 'RGBA')


def main() -> None:
    img = Image.open(SRC).convert('RGB')
    W, H = img.size
    cell_w = W / COLS
    cell_h = H / ROWS
    print(f'source {W}x{H}, cell {cell_w:.1f}x{cell_h:.1f}')

    # 1) Slice cells, mask labels (paint white), bg-remove, tight crop
    crops: list[Image.Image] = []
    for i in range(N):
        r, c = i // COLS, i % COLS
        x0 = int(round(c * cell_w)) + INNER_TRIM
        y0 = int(round(r * cell_h)) + INNER_TRIM
        x1 = int(round((c + 1) * cell_w)) - INNER_TRIM
        y1 = int(round((r + 1) * cell_h)) - INNER_TRIM
        cell = img.crop((x0, y0, x1, y1)).copy()
        cw, ch = cell.size
        # Paint over the cell-number label (top-left) with white
        lbl_w = int(cw * LABEL_W_RATIO)
        lbl_h = int(ch * LABEL_H_RATIO)
        d = ImageDraw.Draw(cell)
        d.rectangle([0, 0, lbl_w, lbl_h], fill=(255, 255, 255))
        rgba = remove_white_bg(cell)
        bbox = rgba.getbbox()
        if not bbox:
            raise RuntimeError(f'cell {i+1} empty after bg removal')
        crop = rgba.crop(bbox)
        crops.append(crop)
        print(f'  cell {i+1:>2}: bbox={bbox} → {crop.size}')

    # 2) Unified frame box (max + padding), bottom-anchored
    max_w = max(c.size[0] for c in crops)
    max_h = max(c.size[1] for c in crops)
    pad_x = int(round(max_w * PAD_RATIO))
    pad_y = int(round(max_h * PAD_RATIO))
    frame_w = max_w + pad_x * 2
    frame_h = max_h + pad_y * 2
    frame_w += frame_w % 2
    frame_h += frame_h % 2
    print(f'unified frame {frame_w}x{frame_h} (max char {max_w}x{max_h}, pad {pad_x}/{pad_y})')

    # 3) Compose composite at native resolution (bottom-anchored, h-centered)
    sheet_native = Image.new('RGBA', (frame_w * N, frame_h), (0, 0, 0, 0))
    for i, ch in enumerate(crops):
        cw, chh = ch.size
        cx = i * frame_w + (frame_w - cw) // 2
        cy = (frame_h - chh) - pad_y  # bottom-anchored
        sheet_native.paste(ch, (cx, cy), ch)

    # 4) Downscale to TARGET_H ensuring exact integer frame width
    scale = TARGET_H / frame_h
    out_frame_w = max(1, int(round(frame_w * scale)))
    final_w = out_frame_w * N
    out_frame_h = TARGET_H
    final = sheet_native.resize((final_w, out_frame_h), Image.LANCZOS)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    final.save(OUT_DIR / 'map.png', optimize=True)
    print(f'wrote {OUT_DIR / "map.png"} {final.size} (frame {out_frame_w}x{out_frame_h})')

    # 5) Build map.json animations
    QUICK, REST, HOLD, LONG, SETTLE = 140, 240, 360, 560, 320

    def f(idx: int, ms: int) -> dict:
        # idx is 1-indexed (matches user's grid numbering)
        return {'duration': ms, 'images': [[(idx - 1) * out_frame_w, 0]]}

    def seq(beats: list[tuple[int, int]]) -> dict:
        return {'frames': [f(i, ms) for i, ms in beats]}

    animations: dict[str, dict] = {}

    # Auto-idle pool
    animations['IdleBob'] = seq([(1, REST), (2, REST), (3, REST), (4, REST), (1, HOLD)])
    animations['IdleBlink'] = seq([(1, REST), (5, QUICK), (6, QUICK), (7, QUICK), (8, REST), (1, LONG)])
    animations['IdleLookAround'] = seq([(1, REST), (9, REST), (10, HOLD), (11, REST), (12, HOLD), (1, HOLD)])

    # Reserved set: greet/show/goodbye/hide/thinking/explain
    greeting = seq([(1, REST), (13, REST), (14, HOLD), (15, LONG), (16, HOLD), (1, SETTLE)])
    goodbye = seq([(16, HOLD), (15, HOLD), (14, REST), (13, REST), (1, SETTLE)])
    thinking = seq([(17, REST), (18, HOLD), (19, LONG), (20, HOLD)])  # loops, no settle
    explain = seq([(21, REST), (22, HOLD), (23, LONG), (24, HOLD)])

    animations['Greeting'] = greeting
    animations['Show'] = greeting
    animations['GoodBye'] = goodbye
    animations['Hide'] = goodbye
    animations['Thinking'] = thinking
    animations['Processing'] = thinking
    animations['Searching'] = thinking
    animations['GetTechy'] = thinking
    animations['CheckingSomething'] = thinking
    animations['Explain'] = explain
    animations['Congratulate'] = explain
    animations['Pleased'] = explain
    animations['Greet'] = explain

    # Fun pool
    animations['Wave'] = seq([
        (1, REST), (13, REST), (14, HOLD), (15, LONG), (16, HOLD),
        (1, REST), (13, REST), (14, HOLD), (15, LONG), (16, HOLD),
    ])
    animations['Celebrate'] = seq([
        (1, REST), (21, REST), (22, HOLD), (23, LONG), (24, HOLD), (1, SETTLE),
    ])
    animations['Alert'] = animations['Wave']
    animations['GetAttention'] = animations['Wave']

    animations['RestPose'] = seq([(1, REST)])

    map_obj = {
        'framesize': [out_frame_w, out_frame_h],
        'overlayCount': 1,
        'displayName': 'Bob',
        'greetingText': "Hi! I'm Bob — ask me anything.",
        'theme': {
            'accent': '#FFD93B',
            'accentText': '#1f1f1f',
            'secondary': '#E03131',
            'glyph': '🤓',
        },
        'animations': animations,
    }
    (OUT_DIR / 'map.json').write_text(json.dumps(map_obj))
    print(f'wrote {OUT_DIR / "map.json"} with {len(animations)} animations')

    # Summary
    png_size = (OUT_DIR / 'map.png').stat().st_size
    json_size = (OUT_DIR / 'map.json').stat().st_size
    print(f'\nsummary: map.png {final.size} {png_size/1024:.1f} KiB, map.json {json_size} bytes')


if __name__ == '__main__':
    main()
