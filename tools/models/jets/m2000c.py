"""
Dassault Mirage 2000C, measured off the three-view in `references/`.

Up is measured from the tip of the nose probe. Sections give the top and
bottom of the body there and the height at which it is widest.
"""

from jetkit import CANOPY, intake, loft, nozzle, section, station, surface

PUBLISHED = {"length_m": 14.36, "span_m": 9.13, "height_m": 5.2, "wing_area_m2": 41.0}


def parts():
    fuselage = loft(
        "fuselage",
        [
            section(6.95, 0.06, 0.08, -0.05, 0.02),
            section(6.68, 0.14, 0.18, -0.11, 0.03),
            section(6.18, 0.25, 0.32, -0.20, 0.06),
            section(5.68, 0.34, 0.46, -0.25, 0.10),
            section(5.18, 0.42, 0.56, -0.27, 0.14, 2.1, 2.2),
            section(4.68, 0.45, 0.70, -0.30, 0.20, 2.1, 2.4),
            section(4.18, 0.45, 0.78, -0.30, 0.25, 2.1, 2.5),
            section(3.18, 0.46, 0.84, -0.28, 0.28, 2.1, 2.6),
            section(2.43, 0.53, 0.90, -0.28, 0.30, 2.0, 2.6),
            section(1.68, 0.62, 1.18, -0.30, 0.36, 2.1, 2.6),
            section(0.68, 0.68, 1.19, -0.30, 0.40, 2.1, 2.6),
            section(-0.82, 0.70, 1.13, -0.32, 0.42, 2.1, 2.6),
            section(-2.32, 0.68, 1.08, -0.32, 0.42, 2.1, 2.6),
            section(-3.82, 0.64, 1.03, -0.30, 0.42, 1.9, 2.5),
            section(-5.07, 0.62, 1.04, -0.20, 0.45, 2.0, 2.4),
            section(-6.07, 0.59, 1.06, -0.08, 0.50, 2.0, 2.2),
            section(-6.6, 0.57, 1.09, 0.0, 0.54, 2.0, 2.1),
        ],
        count=32,
    )
    probe = loft(
        "probe",
        [
            station(7.18, 0, 0, 0, up=0.0),
            station(7.15, 0.012, 0.012, 0.012, up=0.0),
            station(6.8, 0.035, 0.035, 0.035, up=0.02),
        ],
        count=8,
    )
    # The bubble; its foot is buried in the fuselage and its tail runs into the spine.
    canopy = loft(
        "canopy",
        [
            section(4.65, 0.2, 0.62, 0.42, 0.5),
            section(4.2, 0.30, 0.93, 0.5, 0.62),
            section(3.68, 0.36, 1.18, 0.55, 0.72, 2.1),
            section(3.1, 0.37, 1.27, 0.6, 0.8, 2.1),
            section(2.5, 0.35, 1.27, 0.64, 0.84, 2.0),
            section(2.0, 0.28, 1.24, 0.7, 0.9, 1.9),
            section(1.5, 0.16, 1.16, 0.8, 0.95, 1.8),
        ],
        count=24,
        material=CANOPY,
    )
    # Half-round intakes held off the fuselage, so nothing but the cone is in the duct.
    intake_right = intake(
        "intake",
        [
            section(2.25, 0.28, 0.65, 0.0, 0.32, right=0.8),
            section(1.4, 0.3, 0.68, -0.02, 0.33, right=0.8),
            section(-0.3, 0.22, 0.64, 0.04, 0.34, right=0.68),
            section(-2.0, 0.08, 0.5, 0.2, 0.36, right=0.42),
        ],
    )
    # The half-cone in the mouth: its base is buried behind the duct, its point stands ahead of the lip.
    cone = loft(
        "cone",
        [
            station(2.45, 0, 0, 0, up=0.32, right=0.77),
            station(2.0, 0.12, 0.12, 0.12, up=0.32, right=0.77),
            station(1.6, 0.15, 0.15, 0.15, up=0.32, right=0.77),
        ],
        count=12,
    )
    # Fixed strakes on the intakes, behind the duct.
    strake = surface("strake", [(0.8, 0.56, 1.65, 0.95), (1.15, 0.58, 1.5, 0.42)], thickness=0.03)
    # The delta, with its anhedral: the published 41 m² comes straight out of this planform.
    # Inboard of 1.1 m the leading edge stays behind the intake's duct. The
    # sections at 1.6 and 3.3 m lie on the straight panel and change nothing
    # but where there are vertices: the root chord, and the Magic's pylon.
    wing = surface(
        "wing",
        [
            (0.3, 0.35, 1.45, 6.9),
            (1.1, 0.26, 1.49, 6.6),
            (1.6, 0.2094, 0.6824, 5.7573),
            (3.3, 0.0375, -2.0632, 2.8921),
            # At the published 9.13 m span; the drawing's tips run 2% wider.
            (4.565, -0.09, -4.11, 0.75),
        ],
        thickness=0.04,
    )
    fin = surface(
        "fin",
        [(0.0, 0.9, -2.0, 4.8), (0.0, 1.5, -3.5, 3.25), (0.0, 3.6, -6.3, 0.52)],
        thickness=0.035,
    )
    exhaust = nozzle("nozzle", 0.0, 0.56, -7.18, 0.42, [(-6.3, 0.47), (-6.85, 0.47), (-7.18, 0.46)])
    return [
        fuselage,
        probe,
        canopy,
        intake_right,
        intake_right.mirrored(),
        cone,
        cone.mirrored(),
        strake,
        strake.mirrored(),
        wing,
        wing.mirrored(),
        fin,
        exhaust,
    ]
