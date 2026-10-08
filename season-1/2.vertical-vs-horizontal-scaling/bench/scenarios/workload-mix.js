// A coprime permutation preserves exact 70/20/8/2 proportions in each hundred
// arrivals while spreading expensive writes instead of grouping them in a burst.
export function workloadBucket(iteration) {
  if (!Number.isSafeInteger(iteration) || iteration < 0) throw Error('Invalid workload iteration');
  return ((iteration % 100) * 37) % 100;
}
