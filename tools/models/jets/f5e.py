"""
Northrop F-5E Tiger II, measured off the three-view in `references/`.

Up is measured from the line of the nose probe. Sections give the top and
bottom of the body there and the height at which it is widest.
"""

from jetkit import CANOPY, box, intake, loft, nozzle, section, station, surface

PUBLISHED = {"length_m": 14.45, "span_m": 8.13, "height_m": 4.08, "wing_area_m2": 17.28}


def parts():
    fuselage = loft(
        "fuselage",
        [
            section(6.55, 0.05, 0.05, -0.06, 0.0),
            section(6.22, 0.15, 0.09, -0.11, -0.01),
            section(5.72, 0.27, 0.19, -0.17, 0.01, 2.2, 2.2),
            section(5.22, 0.36, 0.29, -0.21, 0.04, 2.3, 2.3),
            section(4.72, 0.42, 0.41, -0.22, 0.08, 2.3, 2.5),
            section(4.22, 0.46, 0.50, -0.22, 0.12, 2.3, 2.6),
            section(3.72, 0.48, 0.57, -0.22, 0.16, 2.3, 2.7),
            section(3.22, 0.49, 0.62, -0.22, 0.19, 2.3, 2.8),
            section(2.22, 0.49, 0.72, -0.22, 0.22, 2.3, 2.8),
            section(1.22, 0.55, 0.78, -0.22, 0.24, 2.2, 2.8),
            section(0.22, 0.62, 0.72, -0.22, 0.25, 2.2, 2.8),
            section(-0.78, 0.68, 0.68, -0.22, 0.25, 2.2, 2.8),
            section(-1.78, 0.74, 0.64, -0.20, 0.25, 2.2, 2.8),
            section(-2.78, 0.78, 0.62, -0.15, 0.26, 2.2, 2.8),
            section(-3.78, 0.79, 0.64, -0.10, 0.30, 2.2, 2.8),
            section(-4.78, 0.78, 0.70, -0.05, 0.36, 2.2, 2.8),
            section(-5.78, 0.75, 0.76, 0.05, 0.42, 2.2, 2.8),
            section(-6.60, 0.70, 0.80, 0.14, 0.47, 2.3, 2.8),
        ],
        count=32,
    )
    probe = loft(
        "probe",
        [
            station(7.225, 0, 0, 0),
            station(7.2, 0.015, 0.015, 0.015),
            station(6.45, 0.03, 0.03, 0.03),
            station(6.3, 0.05, 0.05, 0.05),
        ],
        count=8,
    )
    # The dorsal spine: narrow, from behind the canopy to the fin.
    spine = loft(
        "spine",
        [
            section(1.3, 0.36, 1.10, 0.45, 0.62, 1.6),
            section(0.72, 0.34, 1.25, 0.45, 0.62, 1.6),
            section(-0.28, 0.32, 1.21, 0.45, 0.60, 1.6),
            section(-1.78, 0.30, 1.10, 0.45, 0.58, 1.6),
            section(-3.28, 0.28, 1.00, 0.45, 0.58, 1.6),
            section(-4.8, 0.24, 0.92, 0.45, 0.60, 1.6),
            section(-6.2, 0.2, 0.84, 0.5, 0.62, 1.6),
        ],
        count=24,
    )
    # Windscreen to where the canopy runs into the spine; its foot is buried in the fuselage.
    canopy = loft(
        "canopy",
        [
            section(3.7, 0.16, 0.56, 0.40, 0.46),
            section(3.2, 0.33, 0.67, 0.44, 0.52),
            section(2.7, 0.40, 0.89, 0.46, 0.55),
            section(2.2, 0.42, 1.13, 0.48, 0.58),
            section(1.9, 0.43, 1.24, 0.50, 0.62, 2.2),
            section(1.4, 0.42, 1.30, 0.52, 0.66, 2.2),
            section(0.9, 0.38, 1.30, 0.56, 0.70, 2.0),
            section(0.4, 0.2, 1.2, 0.66, 0.8, 1.8),
        ],
        count=24,
        material=CANOPY,
    )
    intake_right = intake(
        "intake",
        [
            section(1.12, 0.19, 0.62, -0.20, 0.21, 2.1, 2.6, right=0.72),
            section(0.3, 0.20, 0.63, -0.20, 0.21, 2.1, 2.6, right=0.72),
            section(-1.0, 0.13, 0.62, -0.12, 0.24, 2.4, 2.4, right=0.66),
            section(-2.3, 0.03, 0.50, 0.12, 0.30, 2.2, 2.2, right=0.6),
        ],
    )
    wing = surface("wing", [(0.3, 0.06, -0.375, 3.0), (3.95, 0.06, -2.25, 0.92)], thickness=0.048)
    # The leading-edge extension: out from behind the intake mouth to the wing.
    strake = surface(
        "strake",
        [(0.8, 0.06, 0.45, 1.3), (1.1, 0.06, 0.2, 1.3), (1.38, 0.055, -0.45, 0.9)],
        thickness=0.04,
    )
    rail = box("rail", 3.99, 0.06, -1.7, 0.05, 0.05, 1.8)
    # Low on the fuselage, drooping a little toward the tips.
    tailplane = surface("tailplane", [(0.45, 0.02, -4.62, 1.62), (2.1, -0.06, -5.65, 0.64)], thickness=0.04)
    # The dorsal fillet is the fin's own lower section, swept further forward.
    fin = surface(
        "fin",
        [(0.0, 0.7, -3.0, 3.6), (0.0, 1.3, -4.25, 2.15), (0.0, 2.88, -5.15, 0.72)],
        thickness=0.05,
    )
    # Side by side with a hand's width between them: shells that touched would share their lip faces.
    nozzles = [
        nozzle(f"nozzle{side}", side * 0.265, 0.47, -7.2, 0.2, [(-6.3, 0.22), (-6.9, 0.245), (-7.2, 0.235)])
        for side in (-1, 1)
    ]
    return [
        fuselage,
        probe,
        spine,
        canopy,
        intake_right,
        intake_right.mirrored(),
        wing,
        wing.mirrored(),
        strake,
        strake.mirrored(),
        rail,
        rail.mirrored(),
        tailplane,
        tailplane.mirrored(),
        fin,
        *nozzles,
    ]
