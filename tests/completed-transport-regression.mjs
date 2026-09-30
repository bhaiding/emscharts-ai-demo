import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baseUrl = process.env.EMS_DEMO_URL || 'http://127.0.0.1:8765';
const notes = await readFile(new URL('./fixtures/completed-hospital-patch.txt', import.meta.url), 'utf8');
const response = await fetch(`${baseUrl}/api/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: notes }),
});
const payload = await response.json();
assert.equal(response.ok, true, payload.error || `Extraction failed with ${response.status}`);

const chart = payload.chart;
assert.equal(chart.distress, 'Moderate');
assert.equal(chart.disposition, 'Transported');
assert.equal(chart.transportMode, 'Emergent');
assert.equal(chart.careTransferTime, '21:30');
assert.equal(chart.transportedTo, 'Hospital');
assert.equal(chart.condition, '', 'Destination condition was not documented');
assert.deepEqual(chart.crewMembers, [], 'Medic 53 and “our crew” do not identify a human crew member');

for (const resolved of ['distress', 'disposition', 'transportMode', 'careTransferTime']) {
  assert.ok(!payload.missingQuestions.some((item) => item.key === resolved), `Resolved field was still requested: ${resolved}`);
}
for (const unresolved of ['condition', 'crew']) {
  assert.ok(payload.missingQuestions.some((item) => item.key === unresolved), `Missing follow-up question: ${unresolved}`);
}

console.log('Completed transport regression passed.');
