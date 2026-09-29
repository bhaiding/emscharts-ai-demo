import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baseUrl = process.env.EMS_DEMO_URL || 'http://127.0.0.1:8765';
const notes = await readFile(new URL('./fixtures/john-smith-case.txt', import.meta.url), 'utf8');
const response = await fetch(`${baseUrl}/api/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: notes }),
});
const payload = await response.json();
assert.equal(response.ok, true, payload.error || `Extraction failed with ${response.status}`);

const chart = payload.chart;
assert.equal(chart.name, 'John Smith');
assert.equal(chart.sex, 'Male');
assert.equal(chart.unit, 'Medic 53');
assert.equal(chart.patientCity, 'Notre Dame');
assert.equal(chart.city, '', 'Patient city must not be copied into scene city');
assert.equal(chart.address, '', 'Demographics address must not be copied into scene address');
assert.equal(chart.dispatchTime, '', 'A vital time must not become dispatch time');
assert.equal(chart.distress, '', 'A pain score must not become overall distress');
assert.equal(chart.pregnancy, 'Not applicable');
assert.equal(chart.disposition, '', 'An en-route patch must not prove completed transport');
assert.deepEqual(chart.crewMembers, [], 'Medic 53 is a unit, not a crew member');
assert.equal(chart.initialPainScore, '6/10');
assert.equal(chart.currentPainScore, '5/10');
assert.ok(chart.vitals.some((vital) => vital.time === '21:02' && vital.heartRate === '72'));
assert.ok(chart.vitals.some((vital) => vital.time === '21:17' && vital.heartRate === '76'));

const medications = chart.medicationList.map((item) => item.name.toLowerCase());
for (const medication of ['warfarin', 'carvedilol', 'lisinopril', 'furosemide', 'spironolactone', 'atorvastatin']) {
  assert.ok(medications.some((name) => name.includes(medication)), `Missing medication: ${medication}`);
}
const history = chart.historyList.map((item) => `${item.condition} ${item.details}`.toLowerCase()).join(' ');
for (const expected of ['heart failure', 'myocardial infarction', 'atrial fibrillation', 'hypertension', 'hyperlipidemia', 'stent', '35%']) {
  assert.ok(history.includes(expected), `Missing history detail: ${expected}`);
}
for (const key of ['dispatchTime', 'distress', 'address', 'city', 'crew', 'disposition']) {
  assert.ok(payload.missingQuestions.some((item) => item.key === key), `Missing follow-up question: ${key}`);
}

console.log('John Smith regression passed.');
