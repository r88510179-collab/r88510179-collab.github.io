// The Weekly Admin accepts the organizer's complete Pick'em sheet.
// A valid set of four tracked entries is never enough to publish a full-pool sheet silently.
// Keep this pure so the release gate is directly regression-tested in Node.
export function publicationPreflight(candidate) {
  const cfg=candidate?.config;
  if (!cfg) return ['No validated weekly configuration'];
  const problems=[];
  const tracked=Array.isArray(cfg.participants)?cfg.participants:[];
  const field=Array.isArray(cfg.fieldEntries)?cfg.fieldEntries:[];
  if (cfg.fullFieldReady!==true) {
    const detail=(candidate?.fullFieldIssues||[]).slice(0,3).join('; ');
    problems.push('Complete pool field not validated'+(detail?': '+detail:''));
  }
  if (tracked.length!==4) problems.push('Expected exactly four tracked entries');
  if (field.length===0) problems.push('No anonymized competitors were validated');
  if (!Number.isSafeInteger(cfg.competitionSize)||cfg.competitionSize!==tracked.length+field.length)
    problems.push('Full-pool entry count mismatch');
  if (cfg.fullFieldEntryCount!==undefined&&cfg.fullFieldEntryCount!==field.length)
    problems.push('Anonymized field entry count mismatch');
  return problems;
}
