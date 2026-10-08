export function evidenceStatus(report, {sourceHash, imageId, scenarioSha256} = {}) {
  if (!report) return 'missing';
  if (report.passed === false || !(report.passed === true || report.verificationPassed === true)) return 'failed';
  if (report.sourceTreeSha256 && report.sourceTreeSha256 !== sourceHash) return 'historical';
  const image = report.imageId ?? report.image ?? report.candidateImage ?? report.configuration?.[0]?.image;
  if (image && image !== imageId) return 'historical';
  if (report.configuration?.some(replica => replica.image !== imageId)) return 'historical';
  if (scenarioSha256 && report.scenarioSha256 && report.scenarioSha256 !== scenarioSha256) return 'historical';
  if (scenarioSha256 && !report.scenarioSha256) return 'unbound';
  if (!report.sourceTreeSha256 && !image) return 'unbound';
  return 'passed';
}

export function launchDecision({cloud, support, soak, recovery, rollback, security, observationDays = 0}) {
  const blockers = [];
  if (cloud?.passed !== true || cloud.cloud !== true) blockers.push('HTTPS cloud staging acceptance is missing');
  for (const [name, report] of Object.entries({support, soak, recovery, rollback, security})) {
    if (report?.passed !== true) blockers.push(`${name} verification is missing or failed`);
  }
  const iterations = soak?.result?.metrics?.['iterations{scenario:mixed}']?.count;
  if (soak?.profile !== 'soak' || !Number.isFinite(soak?.measuredSeconds) || soak.measuredSeconds < 14400 || !Number.isFinite(iterations) || iterations < 50 * 4 * 3600) {
    blockers.push('A complete four-hour soak at the declared workload is required');
  }
  if (observationDays < 30) blockers.push('A full 30-day production SLO window has not been observed');
  return {approved: blockers.length === 0, blockers};
}
