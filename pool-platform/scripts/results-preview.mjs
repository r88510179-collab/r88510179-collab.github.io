// Read-only Phase 9 final-results preview. No network, credentials, mutations, authorization, or result
// publication. The grading itself lives in ../results-grading.js, one implementation shared with the pages
// and the offline season replay; this file keeps the import path its callers and tests use.
export {validateFinalWeek,previewPickemStandings,previewSurvivorOutcomes} from '../results-grading.js';
