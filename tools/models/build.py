"""
Builds a jet's model from its description in `jets/<id>.py`.

    /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/models/build.py -- f5e [--views DIR]

Writes `public/aircraft/<id>.glb` and `tools/models/checks/<id>.json`, and
with `--views` the silhouettes and previews `compare.py` needs.
"""

import importlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

import jetkit  # noqa: E402

arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
jet_id = arguments[0]
views = arguments[arguments.index("--views") + 1] if "--views" in arguments else None

description = importlib.import_module(f"jets.{jet_id}")
airframe = jetkit.fuse("Airframe", description.parts())
jetkit.root(f"{jet_id}_model", airframe)
report = jetkit.check(airframe)
report["published"] = description.PUBLISHED

os.makedirs(os.path.join(HERE, "checks"), exist_ok=True)
with open(os.path.join(HERE, "checks", f"{jet_id}.json"), "w") as handle:
    json.dump(report, handle, indent=2)
print("CHECK", json.dumps(report))

jetkit.export(os.path.join(REPO, "public", "aircraft", f"{jet_id}.glb"))
if views:
    os.makedirs(views, exist_ok=True)
    jetkit.render_views(airframe, views, jet_id)
