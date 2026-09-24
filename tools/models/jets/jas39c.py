"""
Saab JAS 39C Gripen, measured off the three-view in `references/`.

Up is measured from the line of the nose probe. Sections give the top and
bottom of the body there and the height at which it is widest.
"""

from jetkit import CANOPY, box, intake, loft, nozzle, section, station, surface

PUBLISHED = {"length_m": 14.1, "span_m": 8.4, "height_m": 4.5, "wing_area_m2": 25.54}

# The wing sits at mid-fuselage, the canards on top of the intake housings.
WING_UP = 0.42


def parts():
    fuselage = loft(
        "fuselage",
        [
            section(6.25, 0.08, 0.16, 0.02, 0.09),
            section(6.0, 0.19, 0.27, -0.03, 0.12, 2.1, 2.1),
            section(5.5, 0.32, 0.43, -0.09, 0.17, 2.2, 2.2),
            section(5.0, 0.41, 0.58, -0.14, 0.22, 2.2, 2.3),
            section(4.5, 0.46, 0.71, -0.17, 0.27, 2.2, 2.4),
            section(4.0, 0.50, 0.82, -0.19, 0.31, 2.2, 2.5),
            section(3.5, 0.50, 0.88, -0.19, 0.33, 2.2, 2.6),
            section(3.0, 0.50, 0.92, -0.19, 0.34, 2.2, 2.6),
            section(2.7, 0.52, 0.96, -0.19, 0.35, 2.1, 2.7),
            section(2.2, 0.60, 1.05, -0.20, 0.36, 1.9, 2.8),
            section(1.5, 0.75, 1.26, -0.20, 0.37, 1.6, 2.8),
            section(0.8, 0.88, 1.20, -0.20, 0.37, 1.6, 2.8),
            section(0.0, 0.98, 1.17, -0.20, 0.37, 1.6, 2.8),
            section(-1.0, 1.00, 1.16, -0.20, 0.37, 1.6, 2.8),
            section(-3.0, 1.00, 1.15, -0.18, 0.38, 1.6, 2.8),
            section(-4.5, 0.97, 1.10, -0.13, 0.42, 1.7, 2.6),
            section(-5.26, 0.91, 1.07, -0.07, 0.45, 1.8, 2.5),
            section(-5.76, 0.72, 1.04, -0.02, 0.48, 1.9, 2.4),
            section(-6.1, 0.62, 1.02, 0.02, 0.51, 2.0, 2.3),
            section(-6.45, 0.51, 1.00, 0.06, 0.53, 2.1, 2.2),
        ],
        count=32,
    )
    probe = loft(
        "probe",
        [
            station(7.24, 0, 0, 0, up=0.07),
            station(7.2, 0.012, 0.012, 0.012, up=0.07),
            station(6.5, 0.025, 0.025, 0.025, up=0.08),
            station(6.35, 0.05, 0.05, 0.05, up=0.08),
            station(6.15, 0.05, 0.05, 0.05, up=0.09),
        ],
        count=8,
    )
    # Windscreen to where the canopy runs into the spine; its foot is buried in the fuselage.
    canopy = loft(
        "canopy",
        [
            section(4.35, 0.12, 0.70, 0.45, 0.58),
            section(4.0, 0.30, 0.92, 0.50, 0.66),
            section(3.6, 0.37, 1.10, 0.55, 0.74, 2.1),
            section(3.2, 0.40, 1.30, 0.60, 0.80, 2.2),
            section(2.8, 0.41, 1.38, 0.62, 0.84, 2.2),
            section(2.3, 0.39, 1.35, 0.66, 0.88, 2.2),
            section(1.8, 0.33, 1.29, 0.72, 0.92, 2.0),
            section(1.4, 0.22, 1.20, 0.80, 0.96, 1.8),
        ],
        count=24,
        material=CANOPY,
    )
    # Rounded-rectangle intake housings along the fuselage sides, open at the front.
    intake_right = intake(
        "intake",
        [
            section(2.55, 0.235, 0.77, -0.16, 0.305, 3.5, 3.5, right=0.69),
            section(2.2, 0.245, 0.77, -0.17, 0.30, 3.5, 3.5, right=0.695),
            section(1.0, 0.25, 0.76, -0.18, 0.29, 3.2, 3.2, right=0.70),
            section(-0.6, 0.16, 0.70, -0.16, 0.30, 2.8, 2.8, right=0.66),
            section(-2.4, 0.05, 0.55, 0.0, 0.30, 2.4, 2.4, right=0.62),
        ],
        lip=0.82,
        depth=0.4,
    )
    # One sweep inboard, a slightly shallower one outboard, and a straight trailing edge.
    wing = surface(
        "wing",
        [
            (0.6, WING_UP, 0.48, 5.58),
            (2.66, WING_UP, -2.1, 2.7),
            # The dogtooth: the outer panel's leading edge starts further forward.
            (2.72, WING_UP, -1.86, 2.94),
            (4.0, WING_UP, -3.64, 1.16),
        ],
        thickness=0.045,
    )
    # All-moving canards with a little dihedral, pivoting out of the intake housings.
    canard = surface(
        "canard",
        [(0.66, 0.68, 2.0, 1.7), (0.95, 0.69, 2.1, 1.75), (2.27, 0.80, 0.15, 0.42)],
        thickness=0.045,
    )
    rail = box("rail", 4.005, WING_UP, -3.1, 0.05, 0.07, 1.95)
    # The fin's root is buried in the spine; its tip carries an antenna pod.
    fin = surface(
        "fin",
        [(0.0, 0.85, -2.72, 3.66), (0.0, 2.5, -4.72, 1.5), (0.0, 3.13, -5.6, 0.52)],
        thickness=0.05,
    )
    pod = loft(
        "pod",
        [
            station(-4.35, 0.015, 0.015, 0.015, up=2.62),
            station(-4.55, 0.055, 0.07, 0.07, up=2.62),
            station(-6.05, 0.055, 0.07, 0.07, up=2.62),
            station(-6.25, 0.02, 0.03, 0.03, up=2.62),
        ],
        count=12,
    )
    exhaust = nozzle("nozzle", 0.0, 0.53, -7.24, 0.33, [(-6.3, 0.40), (-6.8, 0.40), (-7.24, 0.385)])
    return [
        fuselage,
        probe,
        canopy,
        intake_right,
        intake_right.mirrored(),
        wing,
        wing.mirrored(),
        canard,
        canard.mirrored(),
        rail,
        rail.mirrored(),
        fin,
        pod,
        exhaust,
    ]
