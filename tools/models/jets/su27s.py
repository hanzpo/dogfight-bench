"""
Sukhoi Su-27S, measured off the three-view in `references/`.

Up is measured from the line of the radome's tip. Sections give the top
and bottom of the body there and the height at which it is widest.
"""

from jetkit import CANOPY, box, intake, loft, nozzle, section, surface

PUBLISHED = {"length_m": 21.935, "span_m": 14.7, "height_m": 5.92, "wing_area_m2": 62.0}

BOOM = 2.1


def parts():
    # Radome, cockpit, the spine behind it and the tail "stinger" between the nozzles.
    fuselage = loft(
        "fuselage",
        [
            section(10.9, 0.06, 0.11, -0.03, 0.04),
            section(10.47, 0.33, 0.35, -0.21, 0.07),
            section(9.97, 0.50, 0.58, -0.31, 0.13),
            section(9.47, 0.60, 0.75, -0.37, 0.19),
            section(8.97, 0.64, 0.88, -0.41, 0.23),
            section(8.47, 0.65, 1.00, -0.43, 0.28),
            section(7.97, 0.65, 1.09, -0.43, 0.33, 2.2, 2.2),
            section(7.2, 0.68, 1.15, -0.42, 0.36, 2.3, 2.3),
            section(6.47, 0.72, 1.20, -0.40, 0.38, 2.3, 2.3),
            section(5.47, 0.74, 1.22, -0.34, 0.40, 2.3, 2.4),
            section(4.47, 0.74, 1.24, -0.27, 0.42, 2.2, 2.4),
            section(3.47, 0.72, 1.45, -0.20, 0.45, 1.8, 2.4),
            section(2.97, 0.68, 1.72, -0.16, 0.48, 1.5, 2.4),
            section(2.47, 0.64, 1.65, -0.14, 0.50, 1.5, 2.4),
            section(1.47, 0.60, 1.59, -0.16, 0.52, 1.5, 2.4),
            section(0.47, 0.56, 1.49, -0.20, 0.52, 1.5, 2.4),
            section(-1.03, 0.52, 1.24, -0.22, 0.48, 1.6, 2.4),
            section(-2.53, 0.48, 0.96, -0.24, 0.40, 1.8, 2.4),
            section(-4.03, 0.46, 0.67, -0.26, 0.25, 2.2, 2.4),
            section(-5.53, 0.44, 0.62, -0.30, 0.20, 2.2, 2.4),
            section(-7.03, 0.43, 0.60, -0.34, 0.15, 2.2, 2.4),
            section(-8.03, 0.42, 0.60, -0.35, 0.14, 2.2, 2.4),
            section(-9.03, 0.40, 0.52, -0.30, 0.12, 2.2, 2.2),
            section(-9.53, 0.34, 0.46, -0.33, 0.07),
            section(-10.03, 0.16, 0.37, -0.31, 0.03),
            section(-10.53, 0.10, 0.26, -0.26, 0.0),
            section(-10.93, 0.03, 0.06, -0.06, 0.0),
        ],
        count=32,
    )
    canopy = loft(
        "canopy",
        [
            section(7.3, 0.30, 1.22, 0.95, 1.05),
            section(6.9, 0.45, 1.42, 0.95, 1.1),
            section(6.4, 0.52, 1.63, 0.95, 1.15),
            section(5.9, 0.55, 1.85, 0.95, 1.2),
            section(5.2, 0.56, 2.00, 0.95, 1.25),
            section(4.5, 0.54, 2.03, 1.00, 1.3),
            section(3.9, 0.48, 1.97, 1.05, 1.35),
            section(3.4, 0.34, 1.86, 1.15, 1.4),
            section(3.05, 0.18, 1.62, 1.3, 1.45),
        ],
        count=24,
        material=CANOPY,
    )
    # The leading-edge extension and wing as one surface: the ogive curves out
    # from beside the cockpit into the 42-degree wing.
    wing = surface(
        "wing",
        [
            (0.35, 0.34, 7.6, 12.5),
            (0.8, 0.34, 5.4, 10.3),
            (1.06, 0.34, 3.97, 8.87),
            (1.29, 0.34, 2.97, 7.87),
            (1.61, 0.34, 1.97, 6.87),
            (2.0, 0.34, 0.97, 5.87),
            (2.26, 0.33, 0.47, 5.40),
            (2.8, 0.31, -0.03, 5.05),
            (7.2, -0.02, -4.1, 2.35),
        ],
        thickness=0.035,
    )
    launcher = box("launcher", 7.28, -0.02, -2.9, 0.12, 0.07, 3.5)
    # Engine nacelles under the wing, box intakes open under the extension.
    nacelle = intake(
        "nacelle",
        [
            section(0.95, 0.56, 0.25, -1.20, -0.475, 5.0, 5.0, right=1.32),
            section(-1.0, 0.56, 0.30, -1.20, -0.45, 4.0, 4.0, right=1.28),
            section(-3.5, 0.56, 0.30, -1.18, -0.44, 3.5, 3.5, right=1.2),
            section(-5.5, 0.56, 0.25, -1.03, -0.39, 3.0, 3.0, right=1.15),
            section(-7.5, 0.57, 0.30, -0.88, -0.29, 2.5, 2.5, right=1.1),
            section(-8.6, 0.58, 0.48, -0.68, -0.10, 2.2, 2.2, right=1.1),
        ],
        count=24,
        lip=0.86,
        depth=0.7,
    )
    # The mouth is raked: its top edge, under the extension, is well ahead of its bottom.
    nacelle.vertices = [
        (r, u, n + 0.85 * (u + 0.475) * max(0.0, min(1.0, (n + 1.0) / 1.95))) for r, u, n in nacelle.vertices
    ]
    engine_nozzle = nozzle("nozzle", 1.1, -0.1, -9.3, 0.45, [(-8.4, 0.46), (-8.75, 0.5), (-9.3, 0.52)])
    # The tail booms outboard of the nacelles carry the fins and stabilators.
    boom = loft(
        "boom",
        [
            section(-3.0, 0.05, 0.12, -0.10, 0.0, right=BOOM),
            section(-4.0, 0.16, 0.35, -0.30, 0.02, 2.4, 2.4, right=BOOM),
            section(-8.6, 0.16, 0.35, -0.30, 0.02, 2.4, 2.4, right=BOOM),
            section(-9.5, 0.08, 0.15, -0.12, 0.0, right=BOOM),
        ],
        count=16,
    )
    # The flat centre section between nacelles and booms, behind the wing. It
    # stops short of the nozzle shells, or it would show inside their mouths.
    platform = surface("platform", [(0.3, 0.05, -3.4, 4.9), (2.0, 0.05, -3.7, 4.6)], thickness=0.04)
    fin = surface("fin", [(BOOM, 0.25, -4.3, 3.6), (BOOM, 4.0, -7.03, 0.65)], thickness=0.045)
    stabilator = surface("stabilator", [(2.04, -0.05, -5.85, 3.35), (4.58, -0.12, -8.55, 0.62)], thickness=0.04)
    ventral = surface("ventral", [(BOOM, -0.2, -5.3, 1.6), (BOOM, -1.22, -5.9, 0.9)], thickness=0.05)
    right = [wing, launcher, nacelle, engine_nozzle, boom, platform, fin, stabilator, ventral]
    return [fuselage, canopy] + [part for solid in right for part in (solid, solid.mirrored())]
