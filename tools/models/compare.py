"""
Lays a model's silhouettes over its reference three-view.

    python tools/models/compare.py f5e VIEWS_DIR [--profiles]

Needs Pillow and NumPy. Each view of the reference is cut out, turned so
the nose points left, and filled into a silhouette; the drawing's scale
comes from the published length over the top view's extent, and the same
scale holds for all three views. The model's silhouette from `build.py
--views` is scaled to match and slid to where it overlaps best.

Writes `<jet>-<view>-overlay.png` (grey where both agree, red where only
the model is, blue where only the drawing is) and prints how well each
view overlaps and how far the best fit had to move the model. With
`--profiles`, prints the half-width, top and bottom of both at every half
metre along the length.
"""

import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCES = os.path.join(HERE, "references")


def silhouette(image, close=3):
    """Everything not reachable from the border through white paper."""
    ink = image.point(lambda value: 0 if value < 160 else 255)
    # Thicken the lines a little so a gap in the drawing does not let the fill in.
    if close:
        ink = ink.filter(ImageFilter.MinFilter(close))
    padded = Image.new("L", (ink.width + 4, ink.height + 4), 255)
    padded.paste(ink, (2, 2))
    ImageDraw.floodfill(padded, (0, 0), 128)
    inside = np.array(padded)[2:-2, 2:-2] != 128
    if close:
        # Give back what the thickening took.
        eroded = Image.fromarray((inside * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(close))
        inside = np.array(eroded) > 127
    return inside


def reference_view(jet, view, config):
    """
    One view of `references/<jet>.png`, per `references/<jet>.json`: crop and
    ignore boxes are fractions; `transform` is flipx, rot90 (counter-clockwise)
    or rot270 (clockwise), whatever turns the view nose-left and fin-up.
    """
    spec = config[view]
    image = Image.open(os.path.join(REFERENCES, f"{jet}.png")).convert("L")
    width, height = image.size
    x0, y0, x1, y1 = spec["crop"]
    image = image.crop((int(x0 * width), int(y0 * height), int(x1 * width), int(y1 * height)))
    transform = spec.get("transform")
    if transform == "flipx":
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    elif transform == "rot90":
        image = image.rotate(90, expand=True, fillcolor=255)
    elif transform == "rot270":
        image = image.rotate(-90, expand=True, fillcolor=255)
    # A drawing with broken outlines needs its lines thickened more before the fill.
    mask = silhouette(image, config.get("close", 3))
    ignore = np.zeros_like(mask)
    h, w = mask.shape
    for ix0, iy0, ix1, iy1 in spec.get("ignore", []):
        ignore[int(iy0 * h) : int(iy1 * h), int(ix0 * w) : int(ix1 * w)] = True
    return image, mask, ignore


def extent(mask, axis):
    present = np.where(mask.any(axis=axis))[0]
    return present[0], present[-1]


def model_view(views_dir, jet, view, scale):
    image = Image.open(os.path.join(views_dir, f"{jet}-{view}.png")).convert("RGBA")
    alpha = image.getchannel("A")
    # The top view renders nose-right; the drawings are turned nose-left.
    if view == "top":
        alpha = alpha.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    size = (max(1, round(alpha.width * scale)), max(1, round(alpha.height * scale)))
    return np.array(alpha.resize(size, Image.Resampling.BILINEAR)) > 127


def place(model, shape, left, top):
    canvas = np.zeros(shape, dtype=bool)
    h, w = model.shape
    y0, x0 = max(0, top), max(0, left)
    y1, x1 = min(shape[0], top + h), min(shape[1], left + w)
    if y1 > y0 and x1 > x0:
        canvas[y0:y1, x0:x1] = model[y0 - top : y1 - top, x0 - left : x1 - left]
    return canvas


def overlap(reference, placed, ignore):
    keep = ~ignore
    both = (reference & placed & keep).sum()
    either = ((reference | placed) & keep).sum()
    return both / max(either, 1)


def best_fit(reference, model, ignore, left, top, reach):
    """Slides the model about its first guess, coarse then fine, to where it overlaps most."""
    best = (overlap(reference, place(model, reference.shape, left, top), ignore), left, top)
    for step in (max(1, reach // 6), max(1, reach // 24), 1):
        _, cx, cy = best
        for dy in range(-reach, reach + 1, step):
            for dx in range(-reach, reach + 1, step):
                score = overlap(reference, place(model, reference.shape, cx + dx, cy + dy), ignore)
                if score > best[0]:
                    best = (score, cx + dx, cy + dy)
        reach = step
    return best


def main():
    jet, views_dir = sys.argv[1], sys.argv[2]
    profiles = "--profiles" in sys.argv
    with open(os.path.join(REFERENCES, f"{jet}.json")) as handle:
        config = json.load(handle)
    length = config["length_m"]

    references = {view: reference_view(jet, view, config) for view in ("top", "side", "front")}
    top_mask = references["top"][1]
    nose_col, tail_col = extent(top_mask, 0)
    pixels_per_metre = (tail_col - nose_col) / length
    scale = pixels_per_metre / 80

    with open(os.path.join(views_dir, f"{jet}-views.json")) as handle:
        rendered = json.load(handle)
    assert all(entry["pixels_per_metre"] == 80 for entry in rendered.values())

    results = {}
    fitted = {}
    for view in ("top", "side", "front"):
        image, reference, ignore = references[view]
        model = model_view(views_dir, jet, view, scale)
        # First guess: the model's extent on the drawing's.
        ref_left, ref_right = extent(reference & ~ignore, 0)
        ref_top, ref_bottom = extent(reference & ~ignore, 1)
        mod_left, mod_right = extent(model, 0)
        mod_top, mod_bottom = extent(model, 1)
        if view == "front":
            left = (ref_left + ref_right) // 2 - (mod_left + mod_right) // 2
        else:
            left = ref_left - mod_left
        # From the front, the fin tip is the one point both are sure to share.
        top = ref_top - mod_top if view == "front" else (ref_top + ref_bottom) // 2 - (mod_top + mod_bottom) // 2
        reach = int((1.0 if view == "front" else 0.6) * pixels_per_metre)
        score, left, top = best_fit(reference, model, ignore, left, top, reach)
        placed = place(model, reference.shape, left, top)
        fitted[view] = (reference, placed, ignore, left, top, model.shape)
        moved = (left - (ref_left - mod_left)) / pixels_per_metre if view != "front" else 0.0
        results[view] = {"overlap": round(float(score), 3), "moved_along_m": round(moved, 2)}

        paper = np.full(reference.shape + (3,), 255, dtype=np.uint8)
        paper[reference & placed] = (200, 200, 200)
        paper[reference & ~placed] = (70, 120, 235)
        paper[~reference & placed] = (235, 70, 60)
        paper[ignore] = (paper[ignore] * 0.5 + 127).astype(np.uint8)
        lines = np.array(image) < 160
        paper[lines] = (0, 0, 0)
        out = Image.fromarray(paper)
        # Metre marks along the length, from the nose.
        if view != "front":
            draw = ImageDraw.Draw(out)
            nose = left + np.where(model.any(axis=0))[0][0]
            for metre in range(int(length) + 1):
                x = nose + metre * pixels_per_metre
                draw.line([(x, 0), (x, 12)], fill=(0, 150, 0), width=2)
                draw.text((x + 2, 12), str(metre), fill=(0, 150, 0))
        out.save(os.path.join(views_dir, f"{jet}-{view}-overlay.png"))

    print(json.dumps({"pixels_per_metre": round(pixels_per_metre, 1), **results}))

    if profiles:
        # Body stations: `nose` in metres from the model's origin (nose is +length/2).
        top_ref, top_mod, top_ign, left, top, shape = fitted["top"]
        side_ref, side_mod, side_ign, s_left, s_top, s_shape = fitted["side"]
        # The model's origin in each placed view is the centre of its render.
        origin_top = (left + shape[1] / 2, top + shape[0] / 2)
        origin_side = (s_left + s_shape[1] / 2, s_top + s_shape[0] / 2)
        print("nose_m | half-width ref model | top ref model | bottom ref model")
        for tenth in range(int(length * 2) + 1):
            nose = length / 2 - tenth / 2
            row = []
            col = int(round(origin_top[0] - nose * pixels_per_metre))
            if 0 <= col < top_ref.shape[1]:
                for mask in (top_ref, top_mod):
                    rows = np.where(mask[:, col] & ~top_ign[:, col])[0]
                    row.append(max(abs(rows[0] - origin_top[1]), abs(rows[-1] - origin_top[1])) / pixels_per_metre if len(rows) else float("nan"))
            col = int(round(origin_side[0] - nose * pixels_per_metre))
            if 0 <= col < side_ref.shape[1]:
                for pick in (0, -1):
                    for mask in (side_ref, side_mod):
                        rows = np.where(mask[:, col] & ~side_ign[:, col])[0]
                        row.append((origin_side[1] - rows[pick]) / pixels_per_metre if len(rows) else float("nan"))
            print(f"{nose:6.2f} | " + "  ".join(f"{value:6.2f}" for value in row))


if __name__ == "__main__":
    main()
