export const F16 = {
  massKg: 10_900,
  wingAreaM2: 27.87,
  maxThrustN: 79_000,
  afterburnerThrustN: 129_000,
  maxPitchRate: 0.78,
  maxRollRate: 3.4,
  maxYawRate: 0.42,
  maxAoARad: 25 * Math.PI / 180,
  gun: {
    ammunition: 511,
    ratePerSecond: 100,
    muzzleVelocityMps: 1_030,
    projectileMassKg: 0.101,
    projectileDiameterM: 0.020,
    dragCoefficient: 0.30,
    dispersionRad1Sigma: 0.004,
    maxLifeSeconds: 4.5,
  },
} as const;

export const EARTH_RADIUS_M = 6_371_000;
