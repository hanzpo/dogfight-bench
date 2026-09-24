# Aircraft models

The Mirage 2000C, Gripen C, Su-27S and F-5E are built here, in Blender, from
numbers measured off a reference three-view. The other four came from a
modeller as finished `.glb` files.

Each jet is a handful of closed parts in `jets/<id>.py`: lofted bodies
(fuselage, canopy, intakes, nozzles, probes) and lifting surfaces. `jetkit.py`
fuses them with an exact boolean union into one closed airframe, so no part
pokes through another and no seam is left open. It then shades the result
smooth, keeping the real edges sharp.

```sh
BLENDER=/Applications/Blender.app/Contents/MacOS/Blender
$BLENDER -b --python tools/models/build.py -- su27s --views /tmp/views   # public/aircraft/su27s.glb, checks/su27s.json
python tools/models/compare.py su27s /tmp/views --profiles               # needs Pillow and NumPy
```

- `checks/<id>.json` must show one component and nothing else: no non-manifold
  or open edges, no degenerate faces, no coincident vertices, and no face whose
  normal points inward (tested by casting a ray from every face).
- `compare.py` turns the drawing's views into silhouettes, scales them by the
  published length, and lays the model over them:
  - It writes an overlay image per view: grey where the two agree, red where
    only the model is, blue where only the drawing is.
  - It prints an overlap score per view, and a table of width, top and bottom
    at every half metre.
  - The top and side views of every jet overlap 0.93–0.98. The front views
    score lower, because the drawings show stores and landing gear, and
    because the Su-27's front view is drawn at a different scale.
- Parts that meet must cross at an angle or stay clear of each other. Surfaces
  that nearly touch or lie in the same plane are the one thing an exact union
  cannot fuse cleanly.

The game's numbers for each jet (nozzles, rails, cockpit, gun, hit volumes,
centre of gravity) are measured off its model and live in
`src/sim/airframes.ts`. `test/asset.test.ts` checks them against the file.

## Icons

The hangar's aircraft icons are traced from the models themselves, all at one
scale:

```sh
$BLENDER -b --python tools/models/icons.py -- /tmp/icons f16c=public/F16_Clean.glb fa18c=public/aircraft/fa18c.glb@180 ...
NODE_PATH=<dir with potrace and pngjs> node tools/models/trace-icons.mjs /tmp/icons f16c mig29a fa18c f15c su27s m2000c f5e jas39c
```

## References

The drawings in `references/` are from Wikimedia Commons:

- F-5E: [Northrop F-5E Tiger II 3-view](https://commons.wikimedia.org/wiki/File:Northrop_F-5E_Tiger_II_3-view.svg), Kaboldy, CC BY-SA 3.0
- Gripen: [Saab JAS 39 Gripen 3-view](https://commons.wikimedia.org/wiki/File:Saab_JAS_39_Gripen_3-view.svg), Kaboldy, CC BY-SA 3.0
- Mirage 2000C: [Dassault Mirage 2000C 3-view line drawing](https://commons.wikimedia.org/wiki/File:Dassault_Mirage_2000C_3-view_line_drawing.gif), retraced by Henrickson, CC BY-SA 3.0
- Su-27: [Sukhoi Su-27 3-view line drawing](https://commons.wikimedia.org/wiki/File:Sukhoi_Su-27_3-view_line_drawing.svg), Malyszkz, public domain

They are redistributed here under those licences, converted to greyscale PNG.
