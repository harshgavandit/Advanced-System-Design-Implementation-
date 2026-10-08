export const TEST_URI = 'mongodb://127.0.0.1:28027/phase0_contract_test?directConnection=true';

export function assertTestTarget(uri) {
  if (uri !== TEST_URI) throw new Error('Refusing writes outside the exact isolated Phase 0 MongoDB target');
  return 'phase0_contract_test';
}
