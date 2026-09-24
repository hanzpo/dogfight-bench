"""
Renders every aircraft model from directly above, nose up, all at one
scale, as two masks: the whole airframe, and the canopy alone.

    /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/models/icons.py -- OUT_DIR id=path[@yaw] ...

`trace-icons.mjs` turns the masks into the SVG paths the aircraft picker draws.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

PIXELS_PER_METRE = 40
# Big enough for the largest jet, a Flanker, with room to spare.
CANVAS_M = 24

arguments = sys.argv[sys.argv.index("--") + 1 :]
out_dir = arguments[0]
os.makedirs(out_dir, exist_ok=True)


def render(path, only_canopy):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.film_transparent = True
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "SINGLE"
    scene.display.shading.single_color = (1, 1, 1)
    scene.render.resolution_x = scene.render.resolution_y = CANVAS_M * PIXELS_PER_METRE
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


for entry in arguments[1:]:
    jet, source = entry.split("=", 1)
    yaw = 0.0
    if "@" in source:
        source, yaw_text = source.split("@")
        yaw = float(yaw_text)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    # Blender's glTF import turns +z nose into -y; a model exported facing aft is turned back.
    pivot = bpy.data.objects.new("pivot", None)
    bpy.context.scene.collection.objects.link(pivot)
    for obj in bpy.context.scene.objects:
        if obj.parent is None and obj is not pivot:
            obj.parent = pivot
    pivot.rotation_euler = (0, 0, math.radians(yaw))
    bpy.context.view_layer.update()

    camera_data = bpy.data.cameras.new("camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = CANVAS_M
    camera = bpy.data.objects.new("camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    # Looking straight down; nose (-y in Blender) at the top of the picture.
    camera.location = Vector((0, 0, 60))
    camera.rotation_euler = (0, 0, math.radians(180))

    render(os.path.join(out_dir, f"{jet}-body.png"), False)

    # The canopy alone: everything else hidden behind a black holdout.
    for obj in meshes:
        for slot in obj.material_slots:
            material = slot.material
            if material is None:
                continue
            is_canopy = "canopy" in material.name.lower() or "glass" in material.name.lower()
            material.diffuse_color = (1, 1, 1, 1) if is_canopy else (0, 0, 0, 1)
    bpy.context.scene.display.shading.color_type = "MATERIAL"
    scene = bpy.context.scene
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("black")
    scene.world.color = (0, 0, 0)
    scene.render.filepath = os.path.join(out_dir, f"{jet}-canopy.png")
    scene.display.shading.light = "FLAT"
    bpy.ops.render.render(write_still=True)
    print("ICON", jet)
