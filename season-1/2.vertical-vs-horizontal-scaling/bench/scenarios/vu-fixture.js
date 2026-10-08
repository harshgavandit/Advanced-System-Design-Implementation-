// IDs are global to the generator instance, including other scenarios.
// Never wrap them onto another VU's rotating refresh-token family.
export function vuFixtureSlot(vuId, pairCount) {
  if (!Number.isInteger(vuId) || vuId < 1 || !Number.isInteger(pairCount) || vuId > pairCount) {
    throw new RangeError('Every instance-wide VU needs its own prepared session pair');
  }
  return vuId - 1;
}

// An idle VU may first run after its prepared access token has expired.
// Anchor the refresh cadence to issuance, while keeping refreshes staggered.
export function initialRefreshClock(issuedAtSeconds, slot) {
  if (!Number.isFinite(issuedAtSeconds) || issuedAtSeconds <= 0 || !Number.isInteger(slot) || slot < 0) {
    throw new RangeError('A prepared session needs a valid issuance time and fixture slot');
  }
  return issuedAtSeconds * 1000 - slot * 5000;
}
