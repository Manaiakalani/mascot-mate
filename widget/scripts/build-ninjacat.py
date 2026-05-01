"""Append 6 named multi-frame animations to Ninjacat's sprite sheet.

The new source is a labeled grid: 1 label column + 6 frame columns × 1
header row + 6 animation rows. Each (row, col) cell is one frame.

Animations:
  row 0: THINK — tap chin, idea forming
  row 1: CONFUSED / SHRUG
  row 2: LAUGH / GIGGLE
  row 3: TA-DA — big presentation
  row 4: SNEAK / PEEK
  row 5: OOPS / FACEPALM

We extract each frame cleanly (overflow slice + blob anchor on the original
cell center, identical to the strategy used for the base 16-pose grid) and
append them to the existing sprite sheet at native source resolution. We then
rescale to TARGET_H so they line up with the original frames, and rewrite
map.json with a richer animation set that references both the synthesized
animations (over the 16 base poses) and the new authored sequences.
"""

from PIL import Image
from pathlib import Path
import json

# Re-use blob extraction helpers from the original builder.
import importlib.util
spec = importlib.util.spec_from_file_location('build_ninjacat', '/tmp/build_ninjacat.py')
assert spec and spec.loader
_orig = importlib.util.module_from_spec(spec)

# We don't want to actually run the original builder — just import its helpers.
# Read its source and exec only the function definitions we need.
src_text = Path('/tmp/build_ninjacat.py').read_text()
ns: dict = {}
# Pull only the helpers (no top-level execution that writes files).
exec(compile(
    "\n".join([
        "from PIL import Image",
        "from pathlib import Path",
        "import json",
        "BG_TOL = 30",
    ]),
    '<helpers>', 'exec'), ns)
# Extract function definitions by parsing the source manually.
import ast
tree = ast.parse(src_text)
helpers_src = "\n\n".join(
    ast.get_source_segment(src_text, n)
    for n in tree.body
    if isinstance(n, ast.FunctionDef)
    and n.name in ('near_white_to_alpha', 'tight_bbox', 'keep_blob_at', 'keep_main_blob')
)
exec(helpers_src, ns)
near_white_to_alpha = ns['near_white_to_alpha']
tight_bbox = ns['tight_bbox']
keep_blob_at = ns['keep_blob_at']

# ---------- inputs ----------
BASE_SRC = Path('/Users/max/Downloads/ChatGPT Image Apr 30, 2026 at 12_36_56 PM.png')
ANIM_SRC = Path('/Users/max/Downloads/ChatGPT Image Apr 30, 2026 at 10_51_25 PM.png')
OUT_DIR = Path('/Users/max/mascot/widget/src/mascots/ninjacat')

PAD = 4
TARGET_H = 186

# ---------- 1) Re-extract the 16 base poses (4x4 grid) ----------
GRID_COLS_BASE, GRID_ROWS_BASE = 4, 4
OVERFLOW_BASE = 80
base_src = Image.open(BASE_SRC).convert('RGBA')
BW, BH = base_src.size
bcw, bch = BW // GRID_COLS_BASE, BH // GRID_ROWS_BASE

base_chars: list[Image.Image] = []
for r in range(GRID_ROWS_BASE):
    for c in range(GRID_COLS_BASE):
        x0o, y0o = c * bcw, r * bch
        x1o, y1o = (c + 1) * bcw, (r + 1) * bch
        x0 = max(0, x0o - OVERFLOW_BASE)
        y0 = max(0, y0o - OVERFLOW_BASE)
        x1 = min(BW, x1o + OVERFLOW_BASE)
        y1 = min(BH, y1o + OVERFLOW_BASE)
        crop = base_src.crop((x0, y0, x1, y1)).copy()
        crop = near_white_to_alpha(crop)
        ax = (x0o - x0) + bcw // 2
        ay = (y0o - y0) + bch // 2
        crop = keep_blob_at(crop, ax, ay)
        bbox = tight_bbox(crop)
        base_chars.append(crop.crop(bbox))
print(f'base poses extracted: {len(base_chars)}')

# ---------- 2) Extract the 36 animation frames ----------
# 7×7 layout but cells are NOT equal — header row and label column are
# smaller than the frame cells. Boundaries detected empirically by profiling
# white separator rows/columns:
#   label column: 0..162; frame cols start at 162, six frames of width 160
#   header row:   0..58;  anim rows start at 58, six rows of height ~224
LABEL_W = 162
HEADER_H = 58
ANIM_FRAME_W = (1122 - LABEL_W) // 6  # = 160
ANIM_FRAME_H = (1402 - HEADER_H) // 6  # = 224
OVERFLOW_ANIM = 50
anim_src = Image.open(ANIM_SRC).convert('RGBA')
AW, AH = anim_src.size

# Row labels (in animation-row order, i.e. excluding the header row).
ROW_NAMES = ['THINK', 'CONFUSED', 'LAUGH', 'TADA', 'SNEAK', 'OOPS']

anim_frames: dict[str, list[Image.Image]] = {n: [] for n in ROW_NAMES}
for r in range(6):
    for c in range(6):
        x0o = LABEL_W + c * ANIM_FRAME_W
        y0o = HEADER_H + r * ANIM_FRAME_H
        x1o = x0o + ANIM_FRAME_W
        y1o = y0o + ANIM_FRAME_H
        x0 = max(0, x0o - OVERFLOW_ANIM)
        y0 = max(0, y0o - OVERFLOW_ANIM)
        x1 = min(AW, x1o + OVERFLOW_ANIM)
        y1 = min(AH, y1o + OVERFLOW_ANIM)
        crop = anim_src.crop((x0, y0, x1, y1)).copy()
        crop = near_white_to_alpha(crop)
        ax = (x0o - x0) + ANIM_FRAME_W // 2
        ay = (y0o - y0) + ANIM_FRAME_H // 2
        crop = keep_blob_at(crop, ax, ay)
        bbox = tight_bbox(crop)
        ch = crop.crop(bbox)
        if ch.size[0] < 30 or ch.size[1] < 30:
            print(f'  WARN: tiny extraction at row {r} col {c}: {ch.size}')
        anim_name = ROW_NAMES[r]
        anim_frames[anim_name].append(ch)
        print(f'  {anim_name}[{c}]: {ch.size}')

# ---------- 3) Per-row size normalization ----------
# Audit showed the new 6×6 grid was drawn at ~1.44× smaller scale than the
# base 4×4 grid. Scale each animation row so its tallest pose matches the
# tallest base pose. Within-animation variation (laugh bounce, sneak peek
# crouch) is preserved because the whole row uses one shared factor.
TARGET_CHAR_H = max(c.size[1] for c in base_chars)  # = 267 (tallest base pose)
print(f'normalization target char height: {TARGET_CHAR_H}px')
for name in ROW_NAMES:
    row_max_h = max(c.size[1] for c in anim_frames[name])
    factor = TARGET_CHAR_H / row_max_h
    new_row = []
    for c in anim_frames[name]:
        nw = max(1, round(c.size[0] * factor))
        nh = max(1, round(c.size[1] * factor))
        new_row.append(c.resize((nw, nh), Image.LANCZOS))
    anim_frames[name] = new_row
    print(f'  {name}: row_max_h={row_max_h} → scale {factor:.2f}× '
          f'(new row max h={max(c.size[1] for c in new_row)})')

# ---------- 4) Compose a single sheet ----------
all_chars = list(base_chars)
for n in ROW_NAMES:
    all_chars.extend(anim_frames[n])

max_w = max(t.size[0] for t in all_chars)
max_h = max(t.size[1] for t in all_chars)
FRAME_W = max_w + PAD * 2
FRAME_H = max_h + PAD * 2
FRAME_W += FRAME_W % 2
FRAME_H += FRAME_H % 2
print(f'unified frame: {FRAME_W}x{FRAME_H} ({len(all_chars)} frames)')

SHEET_W = FRAME_W * len(all_chars)
SHEET_H = FRAME_H
sheet = Image.new('RGBA', (SHEET_W, SHEET_H), (0, 0, 0, 0))
for i, t in enumerate(all_chars):
    x = i * FRAME_W
    cx = x + (FRAME_W - t.size[0]) // 2
    cy = (FRAME_H - t.size[1]) - PAD  # bottom-anchor
    sheet.paste(t, (cx, cy), t)

# Downscale uniformly to TARGET_H.
scale = TARGET_H / FRAME_H
final_h = TARGET_H
# IMPORTANT: ensure final_w is an exact multiple of frame width so each
# frame's source-pixel boundary aligns with `i * out_frame_w`. If we
# resize to a fractional sheet width and then truncate `final_w // len`,
# every subsequent frame drifts left by the truncation, accumulating
# leftward bleed from the previous frame.
out_frame_w = max(1, int(round(FRAME_W * scale)))
final_w = out_frame_w * len(all_chars)
final = sheet.resize((final_w, final_h), Image.LANCZOS)
print(f'final sheet: {final.size}, frame {out_frame_w}x{final_h}')
final.save(OUT_DIR / 'map.png')
print(f'wrote {OUT_DIR / "map.png"}')

# ---------- 4) Build map.json ----------
# Frame indices: 0..15 = base poses, 16..21 = THINK, 22..27 = CONFUSED, 28..33 = LAUGH,
#                34..39 = TADA, 40..45 = SNEAK, 46..51 = OOPS.
def fidx(name: str, k: int) -> int:
    base = 16
    offset = ROW_NAMES.index(name) * 6
    return base + offset + k


def frame(idx: int, ms: int) -> dict:
    return {'duration': ms, 'images': [[idx * out_frame_w, 0]]}


# ----- ClippyJS-style animations using the BASE 16 poses -----
STAND, NOD, SHOUT_R, SHOUT_L = 0, 1, 2, 3
RUN_A, RUN_B = 4, 5
SLEEP_R, SLEEP_L = 6, 7
WAVE_R, WAVE_L = 8, 9
ARMS_UP, ARMS_DOWN = 10, 11
SPIN_FRONT, SPIN_BACK = 12, 13
PEACE, BACKFLIP = 14, 15

# Animation pacing — slower, more deliberate beats so authored poses
# read clearly. Anything under ~110ms tends to flicker/strobe; key beats
# (peak laugh, peak tada, pondering) need to dwell long enough for the
# eye to register the pose.
QUICK = 140    # snappy transition (formerly 90)
REST = 240     # default in-between pose hold (formerly 160)
HOLD = 360     # important pose hold (formerly 220)
LONG = 560     # key beat / climax frame (formerly 320)
SETTLE = 320   # post-animation return-to-idle dwell

animations: dict = {}

def seq(name: str, frames_list: list[tuple[int, int]]) -> None:
    animations[name] = {
        'frames': [frame(idx, dur) for idx, dur in frames_list]
    }

# Authored animations from the new sheet. Always end with a softer
# settle on STAND so the sprite doesn't snap abruptly back to idle.
def authored(name: str, anim: str, durations: list[int]) -> None:
    animations[name] = {
        'frames': [
            {'duration': durations[k], 'images': [[fidx(anim, k) * out_frame_w, 0]]}
            for k in range(6)
        ] + [frame(STAND, SETTLE)]
    }

# 6-frame timing patterns: gentle ramp-up → key beat held long → soft outro.
# All beats >= REST so transitions never feel choppy. Only one frame per
# pattern is a QUICK (where the source pose is a quick gesture).
THINK_T = [REST, HOLD, HOLD, LONG, HOLD, REST]      # build to pondering, hold, settle
CONFUSED_T = [REST, HOLD, HOLD, LONG, HOLD, REST]   # tilt, big confused beat, settle
LAUGH_T = [REST, HOLD, REST, LONG, HOLD, REST]      # bounce up to peak laugh, settle
TADA_T = [REST, HOLD, HOLD, LONG, HOLD, REST]       # slow reveal, big climax, settle
SNEAK_T = [REST, REST, HOLD, HOLD, REST, HOLD]      # cautious, deliberate
OOPS_T = [QUICK, REST, LONG, HOLD, REST, HOLD]      # quick impact, held reaction

authored('Thinking', 'THINK', THINK_T)
authored('Processing', 'THINK', THINK_T)
authored('GetTechy', 'THINK', THINK_T)
authored('CheckingSomething', 'THINK', THINK_T)

authored('DontUnderstand', 'CONFUSED', CONFUSED_T)
authored('Searching', 'CONFUSED', CONFUSED_T)
authored('GetWizardy', 'CONFUSED', CONFUSED_T)

authored('Congratulate', 'LAUGH', LAUGH_T)
authored('Pleased', 'LAUGH', LAUGH_T)
authored('Greet', 'LAUGH', LAUGH_T)
authored('Explain', 'LAUGH', LAUGH_T)

authored('GetAttention', 'TADA', TADA_T)
authored('Wave', 'TADA', TADA_T)
authored('Print', 'TADA', TADA_T)

authored('Hide', 'SNEAK', SNEAK_T)
authored('Show', 'SNEAK', list(reversed(SNEAK_T)))
authored('LookDown', 'SNEAK', SNEAK_T)
authored('LookDownLeft', 'SNEAK', SNEAK_T)
authored('LookDownRight', 'SNEAK', SNEAK_T)

authored('Save', 'OOPS', OOPS_T)
authored('Alert', 'OOPS', OOPS_T)
authored('EmptyTrash', 'OOPS', OOPS_T)

# ----- Synthesised animations from the BASE 16 poses (kept) -----
seq('Greeting', [(WAVE_R, LONG), (STAND, REST), (WAVE_L, LONG), (STAND, REST)])
seq('GoodBye', [(WAVE_R, LONG), (WAVE_L, REST), (SLEEP_R, LONG)])
seq('RestPose', [(STAND, REST)])

seq('Idle1_1', [(STAND, LONG), (NOD, REST), (STAND, LONG)])
seq('IdleSideToSide', [(SPIN_FRONT, REST), (SPIN_BACK, REST), (SPIN_FRONT, REST), (STAND, REST)])
seq('IdleHeadScratch', [(STAND, REST), (NOD, HOLD), (STAND, REST)])
seq('IdleSnooze', [(SLEEP_R, LONG), (SLEEP_L, LONG), (SLEEP_R, LONG), (STAND, REST)])
seq('IdleEyeBrowRaise', [(STAND, REST), (NOD, HOLD), (STAND, REST)])
seq('IdleFingerTap', [(STAND, REST), (PEACE, HOLD), (STAND, REST)])
seq('IdleArmsCrossed', [(ARMS_UP, REST), (ARMS_DOWN, REST), (STAND, REST)])
seq('IdleLegLift', [(RUN_A, REST), (RUN_B, REST), (STAND, HOLD)])
seq('IdleScratch', [(STAND, REST), (NOD, HOLD), (STAND, REST)])
seq('IdleStretch', [(ARMS_UP, HOLD), (STAND, REST)])
seq('IdleRopePile', [(BACKFLIP, HOLD), (STAND, REST)])
seq('IdleRopePileWave', [(WAVE_R, REST), (WAVE_L, REST), (STAND, REST)])
seq('IdleAtom', [(SPIN_FRONT, REST), (SPIN_BACK, REST), (SPIN_FRONT, REST), (STAND, HOLD)])

seq('Run', [(RUN_A, REST), (RUN_B, REST), (RUN_A, REST), (RUN_B, REST), (STAND, HOLD)])
seq('Walk', [(RUN_A, HOLD), (STAND, REST), (RUN_B, HOLD), (STAND, REST), (STAND, HOLD)])
seq('Backflip', [(BACKFLIP, REST), (SPIN_BACK, REST), (SPIN_FRONT, REST), (STAND, HOLD)])
seq('Spin', [(SPIN_FRONT, REST), (SPIN_BACK, REST), (SPIN_FRONT, REST), (SPIN_BACK, REST), (STAND, HOLD)])
seq('SendMail', [(WAVE_R, REST), (ARMS_UP, REST), (WAVE_L, REST), (STAND, REST)])
seq('GestureUp', [(ARMS_UP, HOLD), (STAND, REST)])
seq('GestureDown', [(ARMS_DOWN, HOLD), (STAND, REST)])
seq('GestureLeft', [(WAVE_L, HOLD), (STAND, REST)])
seq('GestureRight', [(WAVE_R, HOLD), (STAND, REST)])
seq('Writing', [(NOD, REST), (PEACE, REST), (NOD, REST), (STAND, REST)])
seq('Reading', [(SLEEP_R, REST), (SLEEP_L, REST), (STAND, REST)])
seq('GetArtsy', [(PEACE, REST), (BACKFLIP, REST), (STAND, REST)])
seq('LookUp', [(NOD, HOLD), (STAND, REST)])
seq('LookUpLeft', [(SHOUT_L, HOLD), (STAND, REST)])
seq('LookUpRight', [(SHOUT_R, HOLD), (STAND, REST)])
seq('LookLeft', [(SLEEP_L, HOLD), (STAND, REST)])
seq('LookRight', [(SLEEP_R, HOLD), (STAND, REST)])

map_obj = {
    'framesize': [out_frame_w, final_h],
    'overlayCount': 1,
    'displayName': 'Ninja Cat',
    'greetingText': "Hiya! I'm Ninja Cat 🐾 Click me and ask a question.",
    'theme': {
        'accent': '#8957e5',
        'accentText': '#ffffff',
        'glyph': '🐾',
        'pillLabel': 'Ask me!',
    },
    'animations': animations,
}
(OUT_DIR / 'map.json').write_text(json.dumps(map_obj))
print(f'wrote {OUT_DIR / "map.json"} with {len(animations)} animations')
