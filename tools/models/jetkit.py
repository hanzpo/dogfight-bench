"""
Builds low-poly game models of fighters inside Blender, from numbers.

A jet is described in body axes -- right, up, nose, metres, origin halfway
along the fuselage -- as a handful of parts: lofted bodies (fuselage,
canopy, intakes, nacelles, nozzles, probes) and lifting surfaces (wings,
tailplanes, fins, canards). Every part is a closed solid; they are fused
with an exact boolean union into one closed airframe, so there are no
parts pushed through one another and no seams left open.

The exported file is what the game loads: nose along +z, up +y, left wing
along +x, metres. `check()` measures the finished mesh for the faults a
game model must not have, and `render_views()` draws the orthographic
silhouettes that `compare.py` lays over a reference three-view.
"""

import json
import math

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

# ---------------------------------------------------------------- materials

AIRFRAME, CANOPY, RECESS, NOZZLE = range(4)

MATERIALS = [
    ("Airframe", (0.72, 0.75, 0.78, 1.0), 0.55, 0.15),
    ("Canopy", (0.05, 0.07, 0.09, 1.0), 0.12, 0.6),
    ("Recess", (0.035, 0.035, 0.04, 1.0), 0.8, 0.1),
    ("Exhaust", (0.33, 0.31, 0.29, 1.0), 0.45, 0.75),
]


def materials():
    made = []
    for name, colour, roughness, metallic in MATERIALS:
        material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        material.use_nodes = True
        material.diffuse_color = colour
        shader = material.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = colour
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Metallic"].default_value = metallic
        made.append(material)
    return made


# ---------------------------------------------------------------- geometry


def to_blender(point):
    """Body axes (right, up, nose) to Blender's (x left, y aft, z up), which the glTF exporter turns into +z nose, +y up."""
    right, up, nose = point
    return Vector((-right, -nose, up))


def _signed_power(value, exponent):
    return math.copysign(abs(value) ** exponent, value)


def station(nose, half_width, top, bottom, up=0.0, right=0.0, square_top=2.0, square_bottom=None):
    """
    One cross-section of a lofted body: a superellipse `half_width` either
    side of `right`, reaching `top` above and `bottom` below `up`. The
    squareness is 2 for an ellipse and grows toward a rectangle.
    """
    return {
        "nose": nose,
        "w": half_width,
        "t": top,
        "b": bottom,
        "up": up,
        "right": right,
        "pt": square_top,
        "pb": square_top if square_bottom is None else square_bottom,
    }


def section(nose, half_width, top, bottom, widest, square_top=2.0, square_bottom=None, right=0.0):
    """A cross-section by where it is measured on a drawing: its top and bottom, and the height at which it is widest."""
    return station(nose, half_width, top - widest, widest - bottom, widest, right, square_top, square_bottom)


def ring(section, count, scale=1.0, nose=None):
    points = []
    for index in range(count):
        angle = 2 * math.pi * index / count
        c, s = math.cos(angle), math.sin(angle)
        square = section["pt"] if s >= 0 else section["pb"]
        right = section["right"] + scale * section["w"] * _signed_power(c, 2 / square)
        height = section["t"] if s >= 0 else section["b"]
        up = section["up"] + scale * height * _signed_power(s, 2 / square)
        points.append((right, up, section["nose"] if nose is None else nose))
    return points


def _is_point(section):
    return section["w"] < 1e-4 and section["t"] < 1e-4 and section["b"] < 1e-4


class Solid:
    """Vertices in body axes and faces with a material each; always closed."""

    def __init__(self, name):
        self.name = name
        self.vertices = []
        self.faces = []
        self.face_materials = []
        self.smooth = False

    def add_vertex(self, point):
        self.vertices.append(point)
        return len(self.vertices) - 1

    def add_face(self, indices, material=AIRFRAME):
        self.faces.append(list(indices))
        self.face_materials.append(material)

    def mirrored(self, name=None):
        other = Solid(name or self.name + "_mirror")
        other.vertices = [(-r, u, n) for r, u, n in self.vertices]
        other.faces = [list(reversed(face)) for face in self.faces]
        other.face_materials = list(self.face_materials)
        other.smooth = self.smooth
        return other


def _bridge(solid, rings, materials_between, cap_first, cap_last):
    """Faces between consecutive rings of vertex indices, with caps; a one-vertex ring is a point."""
    for index in range(len(rings) - 1):
        a, b = rings[index], rings[index + 1]
        material = materials_between[index]
        if len(a) == 1 and len(b) == 1:
            continue
        if len(a) == 1:
            for k in range(len(b)):
                solid.add_face([a[0], b[k], b[(k + 1) % len(b)]], material)
        elif len(b) == 1:
            for k in range(len(a)):
                solid.add_face([a[(k + 1) % len(a)], a[k], b[0]], material)
        else:
            for k in range(len(a)):
                solid.add_face([a[k], a[(k + 1) % len(a)], b[(k + 1) % len(b)], b[k]], material)
    if len(rings[0]) > 1:
        solid.add_face(list(reversed(rings[0])), cap_first)
    if len(rings[-1]) > 1:
        solid.add_face(list(rings[-1]), cap_last)


def loft(name, sections, count=24, material=AIRFRAME, cap_material=None):
    """A closed body through cross-sections ordered nose to tail."""
    solid = Solid(name)
    rings = []
    for section in sections:
        if _is_point(section):
            rings.append([solid.add_vertex((section["right"], section["up"], section["nose"]))])
        else:
            rings.append([solid.add_vertex(point) for point in ring(section, count)])
    cap = material if cap_material is None else cap_material
    _bridge(solid, rings, [material] * (len(rings) - 1), cap, cap)
    return solid


def intake(name, sections, count=20, lip=0.82, depth=0.5):
    """
    An intake: a lofted duct fairing, open at the front into a dark recess.
    `sections` run from the lip aft; the lip is `1 - lip` of the section thick.
    """
    solid = Solid(name)
    first = sections[0]
    deep = [solid.add_vertex(point) for point in ring(first, count, lip, first["nose"] - depth)]
    inner = [solid.add_vertex(point) for point in ring(first, count, lip)]
    rings = [deep, inner]
    for section in sections:
        rings.append([solid.add_vertex(point) for point in ring(section, count)])
    between = [RECESS, AIRFRAME] + [AIRFRAME] * (len(sections) - 1)
    # The deep cap is the face of the engine, or the dark of the duct.
    _bridge(solid, rings, between, RECESS, AIRFRAME)
    return solid


def nozzle(name, right, up, exit_nose, opening_radius, sections, count=24, depth=0.55):
    """
    A nozzle shell: the outer `sections` run forward-to-aft and end at the
    exit; the opening at the exit has `opening_radius`, and the dark inside
    goes `depth` deep. `sections` are (nose, outer radius) along the axis.
    """
    solid = Solid(name)
    rings = []
    for nose, radius in sections:
        rings.append([solid.add_vertex(point) for point in ring(station(nose, radius, radius, radius, up, right), count)])
    opening = station(exit_nose, opening_radius, opening_radius, opening_radius, up, right)
    rings.append([solid.add_vertex(point) for point in ring(opening, count)])
    rings.append([solid.add_vertex(point) for point in ring(opening, count, 0.97, exit_nose + depth)])
    between = [NOZZLE] * (len(sections) - 1) + [NOZZLE, RECESS]
    _bridge(solid, list(reversed(rings)), list(reversed(between)), RECESS, NOZZLE)
    return solid


# A thin symmetric section, as chord fractions and fractions of the thickness.
_AIRFOIL = [(0.0, 0.0), (0.03, 0.5), (0.12, 0.84), (0.3, 1.0), (0.55, 0.88), (0.8, 0.5), (1.0, 0.06)]


def surface(name, sections, thickness=0.05, minimum_edge=0.004):
    """
    A lifting surface through sections (right, up, nose of the leading edge,
    chord), root first. The chord runs straight aft; the section is thick
    across it, in whatever plane the span puts it -- a wing, a fin, a canted
    fin all come out of the same call.
    """
    solid = Solid(name)
    rings = []
    points = [Vector(section[:3]) for section in sections]
    for index, (right, up, nose, chord) in enumerate(sections):
        ahead = points[min(index + 1, len(points) - 1)]
        behind = points[max(index - 1, 0)]
        span = (ahead - behind).normalized()
        along = Vector((0.0, 0.0, -1.0))
        normal = span.cross(along).normalized()
        leading = Vector((right, up, nose))
        loop = [leading]
        tops = []
        bottoms = []
        for fraction, depth in _AIRFOIL[1:]:
            half = max(thickness * chord * depth / 2, minimum_edge)
            base = leading + along * (chord * fraction)
            tops.append(base + normal * half)
            bottoms.append(base - normal * half)
        loop += tops + list(reversed(bottoms))
        rings.append([solid.add_vertex(tuple(point)) for point in loop])
    _bridge(solid, rings, [AIRFRAME] * (len(rings) - 1), AIRFRAME, AIRFRAME)
    return solid


def box(name, right, up, nose, half_width, half_height, length, material=AIRFRAME):
    """
    A plain block, such as a launch rail, with `nose` its front: eight corners
    and nothing between them, so no vertex sits on its sides for another
    part's surface to land on.
    """
    solid = Solid(name)
    corners = [
        solid.add_vertex((right + side * half_width, up + height * half_height, nose - end * length))
        for end in (0, 1)
        for height in (-1, 1)
        for side in (-1, 1)
    ]
    for face in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        solid.add_face([corners[index] for index in face], material)
    return solid


# ---------------------------------------------------------------- assembly


def _object(solid, palette):
    mesh = bpy.data.meshes.new(solid.name)
    mesh.from_pydata([tuple(to_blender(point)) for point in solid.vertices], [], solid.faces)
    for material in palette:
        mesh.materials.append(material)
    for polygon, material in zip(mesh.polygons, solid.face_materials):
        polygon.material_index = material
    mesh.update()
    obj = bpy.data.objects.new(solid.name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    _clean(obj)
    return obj


def _clean(obj, tolerance=1e-5):
    """Merges what is closer than `tolerance`: the slivers a boolean leaves where two surfaces meet at a shallow angle."""
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=tolerance)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=tolerance)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    loose = [vertex for vertex in bm.verts if not vertex.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def fuse(name, solids, smooth_angle_deg=32.0):
    """Every part unioned into one closed airframe, cleaned, shaded smooth where the surface is smooth."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    palette = materials()
    objects = [_object(solid, palette) for solid in solids]
    base = objects[0]
    for other in objects[1:]:
        modifier = base.modifiers.new("union", "BOOLEAN")
        modifier.operation = "UNION"
        modifier.solver = "EXACT"
        modifier.material_mode = "TRANSFER"
        modifier.use_self = False
        modifier.use_hole_tolerant = False
        modifier.object = other
        bpy.context.view_layer.objects.active = base
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        bpy.data.objects.remove(other, do_unlink=True)
    base.name = name
    base.data.name = name
    _clean(base, tolerance=2e-4)
    # Smooth everywhere, with the edges that are really edges kept sharp.
    bpy.context.view_layer.objects.active = base
    base.select_set(True)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(smooth_angle_deg), keep_sharp_edges=False)
    return base


def root(name, airframe):
    parent = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(parent)
    airframe.parent = parent
    return parent


# ---------------------------------------------------------------- checks


def check(obj):
    """The faults a game model must not have, counted; all but the sizes should be zero."""
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.faces.ensure_lookup_table()
    nonmanifold = sum(1 for edge in bm.edges if not edge.is_manifold)
    boundary = sum(1 for edge in bm.edges if edge.is_boundary)
    def body(point):
        return [round(-point.x, 3), round(point.z, 3), round(-point.y, 3)]

    degenerate_at = [body(face.calc_center_median()) for face in bm.faces if face.calc_area() < 1e-7]
    degenerate = len(degenerate_at)
    short_edges = sum(1 for edge in bm.edges if edge.calc_length() < 1e-4)

    tree = KDTree(len(bm.verts))
    for vertex in bm.verts:
        tree.insert(vertex.co, vertex.index)
    tree.balance()
    coincident = sum(1 for vertex in bm.verts if len(tree.find_range(vertex.co, 1e-5)) > 1)

    # Components, by walking edges.
    seen = set()
    components = 0
    for vertex in bm.verts:
        if vertex.index in seen:
            continue
        components += 1
        stack = [vertex]
        while stack:
            current = stack.pop()
            if current.index in seen:
                continue
            seen.add(current.index)
            stack.extend(edge.other_vert(current) for edge in current.link_edges)

    # A face points outward when a ray leaving it along its normal crosses the surface an even number of times.
    bvh = BVHTree.FromBMesh(bm)
    inward_at = []
    for face in bm.faces:
        if face.calc_area() < 1e-6:
            continue
        origin = face.calc_center_median() + face.normal * 1e-4
        direction = face.normal
        crossings = 0
        for _ in range(64):
            hit, _normal, _index, _distance = bvh.ray_cast(origin, direction)
            if hit is None:
                break
            crossings += 1
            origin = hit + direction * 1e-4
        if crossings % 2 == 1:
            inward_at.append(body(face.calc_center_median()))
    inward = len(inward_at)

    volume = bm.calc_volume(signed=True)
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    size = [max(c[i] for c in corners) - min(c[i] for c in corners) for i in range(3)]
    result = {
        "triangles": len(bm.faces),
        "vertices": len(bm.verts),
        "components": components,
        "nonmanifold_edges": nonmanifold,
        "boundary_edges": boundary,
        "degenerate_faces": degenerate,
        "edges_under_0_1mm": short_edges,
        "coincident_vertices": coincident,
        "inward_faces": inward,
        "signed_volume_m3": round(volume, 3),
        # Where the faults are, in body axes, to find them by.
        "degenerate_at": degenerate_at[:8],
        "inward_at": inward_at[:8],
        # Blender x is span, y is length, z is height.
        "span_m": round(size[0], 3),
        "length_m": round(size[1], 3),
        "height_m": round(size[2], 3),
    }
    bm.free()
    return result


# ---------------------------------------------------------------- export and views


def export(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
    )


PIXELS_PER_METRE = 80


def render_views(obj, directory, name):
    """
    Silhouettes from above (nose right), the left side (nose left) and the front, at PIXELS_PER_METRE, centred on the model's origin; and shaded
    previews of the same views for looking at.
    """
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.film_transparent = True
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "SINGLE"
    scene.display.shading.single_color = (0, 0, 0)
    scene.display.shading.show_object_outline = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    reach = [max(abs(c[i]) for c in corners) for i in range(3)]
    span, length, height = reach
    views = {
        # name: camera location, rotation, half extents (horizontal, vertical) in metres
        "top": ((0, 0, 50), (0, 0, math.radians(-90)), (length, span)),
        "side": ((50, 0, 0), (math.radians(90), 0, math.radians(90)), (length, height)),
        "front": ((0, -50, 0), (math.radians(90), 0, 0), (span, height)),
    }
    camera_data = bpy.data.cameras.new("camera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    written = {}
    for view, (location, rotation, (half_h, half_v)) in views.items():
        half_h += 0.3
        half_v += 0.3
        camera.location = location
        camera.rotation_euler = rotation
        scene.render.resolution_x = int(2 * half_h * PIXELS_PER_METRE)
        scene.render.resolution_y = int(2 * half_v * PIXELS_PER_METRE)
        scene.render.resolution_percentage = 100
        camera_data.ortho_scale = 2 * max(half_h, half_v)
        camera_data.sensor_fit = "HORIZONTAL" if half_h >= half_v else "VERTICAL"
        for shaded in (False, True):
            if shaded:
                scene.display.shading.light = "STUDIO"
                scene.display.shading.color_type = "MATERIAL"
                scene.display.shading.show_cavity = True
                scene.display.shading.show_object_outline = True
            else:
                scene.display.shading.light = "FLAT"
                scene.display.shading.color_type = "SINGLE"
                scene.display.shading.show_cavity = False
                scene.display.shading.show_object_outline = False
            path = f"{directory}/{name}-{view}{'-shaded' if shaded else ''}.png"
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
        written[view] = {"path": f"{directory}/{name}-{view}.png", "pixels_per_metre": PIXELS_PER_METRE}
    # A three-quarter look, shaded, for the eye.
    camera_data.type = "PERSP"
    camera_data.lens = 50
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    scene.render.film_transparent = False
    for label, location in (("quarter", (-14, -17, 7)), ("rear", (10, 19, 5)), ("under", (-12, -10, -8))):
        scale = max(length, span) / 8
        camera.location = Vector(location) * scale
        direction = -camera.location
        camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = f"{directory}/{name}-{label}.png"
        bpy.ops.render.render(write_still=True)
    scene.render.film_transparent = True
    with open(f"{directory}/{name}-views.json", "w") as handle:
        json.dump(written, handle, indent=2)
    return written
