import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = process.cwd();
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_REQUESTS_PER_HOUR = Number(process.env.MAX_REQUESTS_PER_HOUR || 20);
const requestWindows = new Map();

const fieldKeys = [
  'name', 'age', 'sex', 'dob', 'weight', 'patientAddress', 'patientCity',
  'patientState', 'patientZip', 'address', 'city', 'unit',
  'complaint', 'onset', 'distress', 'initialPainScore', 'currentPainScore', 'medicalTrauma', 'allergies',
  'medications', 'history', 'lastIntake', 'alcoholDrugs', 'pregnancy',
  'disposition', 'unitDisposition', 'careDisposition', 'crewDisposition',
  'transportDisposition', 'transportedTo', 'destination', 'transportMode', 'condition', 'dispatchTime',
  'careTransferTime', 'crew', 'narrative',
];
const structuredFieldKeys = ['vitals', 'medicationList', 'historyList', 'crewMembers'];
const evidenceKeys = [...fieldKeys, ...structuredFieldKeys];
const optionalFieldKeys = new Set(['weight', 'patientAddress', 'patientCity', 'patientState', 'patientZip', 'history', 'lastIntake', 'alcoholDrugs', 'pregnancy', 'initialPainScore', 'currentPainScore', 'unitDisposition', 'careDisposition', 'crewDisposition', 'transportDisposition', 'transportedTo']);

const chartProperties = Object.fromEntries(fieldKeys.map((key) => [key, {
  type: 'string',
  description: `Chart value for ${key}. Return an empty string when not stated or safely inferable.`,
}]));
chartProperties.medicalTrauma = {
  type: 'string',
  enum: ['', 'Medical', 'Trauma', 'Medical and trauma'],
  description: 'Required classification inferred from the chief complaint and mechanism. Chest pain, dyspnea, illness, syncope, and similar non-injury complaints are Medical. Falls, collisions, wounds, fractures, and other injuries are Trauma. Use Medical and trauma when both are present.',
};
chartProperties.sex = {
  type: 'string',
  enum: ['', 'Female', 'Male', 'Unknown'],
  description: 'Required patient sex. Normalize Sex: F, F, female, and woman to Female; normalize Sex: M, M, male, and man to Male. Use Unknown only when the notes explicitly say unknown. Do not confuse unit shorthand such as M2 with patient sex.',
};
chartProperties.distress = { type: 'string', enum: ['', 'None', 'Mild', 'Moderate', 'Severe'], description: 'Overall patient distress only when explicitly described as none, mild, moderate, or severe distress. A numeric pain score is not a distress level and must not populate this field.' };
chartProperties.initialPainScore.description = 'First explicitly documented pain score, such as 6/10. Do not convert it to a distress level.';
chartProperties.currentPainScore.description = 'Most recent explicitly documented pain score, such as 5/10. Do not convert it to a distress level.';
chartProperties.unit.description = 'Responding or transporting EMS unit identifier. Extract common forms including Medic 2, Medic-2, M2, Ambulance 4, Amb 4, A4, Rescue 1, Engine 3, Squad 5, and unit #53. Normalize unambiguous abbreviations: M2 to Medic 2, Amb 4 or A4 to Ambulance 4, R1 to Rescue 1, E3 to Engine 3, and SQ5 to Squad 5. Do not confuse a room, bed, destination unit, or crew number with the EMS unit.';
chartProperties.disposition = {
  type: 'string',
  enum: ['', 'Transported', 'Patient refused care', 'Treated and released', 'Cancelled', 'Deceased', 'No patient found', 'Transferred to another unit'],
  description: 'Final patient disposition. Normalize transported/conveyed/taken to a facility as Transported; refused or declined care/transport, AMA, or signed refusal as Patient refused care; treated and left at scene as Treated and released; cancelled/disregarded calls as Cancelled; pronounced dead or DOA as Deceased; no patient located as No patient found; and transport by another EMS unit as Transferred to another unit.',
};
chartProperties.alcoholDrugs = { type: 'string', enum: ['None suspected', 'Alcohol suspected', 'Drugs suspected', 'Unknown'], description: 'Alcohol or drug involvement. Select Alcohol suspected or Drugs suspected when supported, Unknown when explicitly unknown, and otherwise default to None suspected.' };
chartProperties.pregnancy = { type: 'string', enum: ['No', 'Yes', 'Possible', 'Not applicable', 'Unknown'], description: 'Pregnancy status. Use Not applicable for a male patient under this form rule. Otherwise use Yes, Possible, or No only when supported, and Unknown when not stated.' };
chartProperties.unitDisposition = { type: 'string', enum: ['', 'Patient contact', 'No patient contact', 'Cancelled en route'], description: 'Whether this unit made patient contact. Infer Patient contact when patient demographics, assessment, care, refusal, or transport are documented; No patient contact when explicitly stated or no patient was found; Cancelled en route when cancelled before arrival.' };
chartProperties.careDisposition = { type: 'string', enum: ['', 'Transport by this unit', 'Transport by another unit', 'Refused care'], description: 'Disposition of care. Transport by this unit when this crew transported; Transport by another unit when another ground or air unit transported; Refused care when the patient refused.' };
chartProperties.crewDisposition = { type: 'string', enum: ['', 'Transported patient', 'Assisted other unit', 'Released at scene'], description: 'Crew outcome. Transported patient when this crew transported, Assisted other unit when care or transport was handled by another unit, and Released at scene for refusal, treatment/release, deceased, cancelled, or other non-transport outcomes.' };
chartProperties.transportDisposition = { type: 'string', enum: ['', 'Transported by EMS', 'Not transported', 'Air medical'], description: 'Transport outcome. Use Air medical for helicopter/air transport, Transported by EMS for ground EMS transport, and Not transported for refusal, release, deceased, cancelled, or no-patient calls.' };
chartProperties.transportedTo = { type: 'string', enum: ['', 'Hospital', 'Trauma center', 'Urgent care', 'Other'], description: 'Destination facility category. Infer Hospital from hospital, medical center, emergency department, or ED; Trauma center from trauma center; Urgent care from urgent care; and Other for another stated destination type.' };
chartProperties.patientAddress.description = 'Patient home, residence, or mailing street address from a demographics, patient information, residence, or home-address section. Do not put the incident location here unless the notes explicitly say the scene was the patient home.';
chartProperties.patientCity.description = 'City belonging to the patient home/residence address. Do not use the scene or destination city unless explicitly identified as the patient residence.';
chartProperties.patientState.description = 'State belonging to the patient home/residence address.';
chartProperties.patientZip.description = 'ZIP/postal code belonging to the patient home/residence address.';
chartProperties.address.description = 'Scene or incident street address only. Extract from scene, incident, dispatch, response-location, or location sections. An address appearing only in demographics or patient information is the patient address and this field must remain empty.';
chartProperties.city.description = 'Scene city derived only from the scene/incident location or address. Do not use the patient residence city or destination city.';
chartProperties.allergies.description = 'Reported allergies. Explicit negatives such as no allergies or NKDA must be returned as No known allergies.';
chartProperties.medications.description = 'Reported medications. Explicit negatives such as takes no medications must be returned as No medications reported.';
chartProperties.narrative.description = 'Newly synthesized chronological third-person EMS narrative using only supported facts; never copy rough source wording verbatim.';
chartProperties.crew.description = 'Readable crew summary. Keep members separate and do not merge their names or roles. This value will be normalized from crewMembers.';

const crewMembersProperty = {
  type: 'array',
  description: 'Every documented human crew member as a separate array item. Search the full narrative for actual names associated with care or crew roles. Never combine multiple people in one item and never treat a post, station, unit, apparatus, room, bed, or location identifier as a person.',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'One crew member name or identifier without repeating a certification prefix that belongs in certificationLevel.' },
      role: { type: 'string', enum: ['', 'Primary care', 'Driver', 'Attendant', 'Observer'], description: 'Primary care for the lead clinician/attending provider; Driver for the vehicle operator; Attendant for a second caregiver or person riding with the patient; Observer for a student or ride-along.' },
      certificationLevel: { type: 'string', enum: ['', 'EMT', 'AEMT', 'Paramedic', 'RN', 'Other'], description: 'Certification only when stated or unambiguously included with the member.' },
    },
    required: ['name', 'role', 'certificationLevel'],
    additionalProperties: false,
  },
};

const vitalsProperty = {
  type: 'array',
  description: 'Vital-sign observations in chronological source order. A vital timestamp belongs only to this observation and must never be reused as dispatch time.',
  items: {
    type: 'object',
    properties: {
      time: { type: 'string', description: 'Observation time in HH:MM 24-hour format when stated.' },
      heartRate: { type: 'string' },
      systolicBP: { type: 'string' },
      diastolicBP: { type: 'string' },
      spo2: { type: 'string' },
      respiratoryRate: { type: 'string' },
      glucose: { type: 'string' },
      painScore: { type: 'string' },
    },
    required: ['time', 'heartRate', 'systolicBP', 'diastolicBP', 'spo2', 'respiratoryRate', 'glucose', 'painScore'],
    additionalProperties: false,
  },
};

const medicationListProperty = {
  type: 'array',
  description: 'All unique home medications supported anywhere in the supplied sources. Preserve available dose, route, frequency, and reason.',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' }, dose: { type: 'string' }, route: { type: 'string' },
      frequency: { type: 'string' }, reason: { type: 'string' },
    },
    required: ['name', 'dose', 'route', 'frequency', 'reason'],
    additionalProperties: false,
  },
};

const historyListProperty = {
  type: 'array',
  description: 'All unique medical and surgical history items supported anywhere in the supplied sources, including available dates and clinical details.',
  items: {
    type: 'object',
    properties: { condition: { type: 'string' }, details: { type: 'string' } },
    required: ['condition', 'details'],
    additionalProperties: false,
  },
};

const extractionSchema = {
  type: 'object',
  properties: {
    chart: {
      type: 'object',
      properties: { ...chartProperties, vitals: vitalsProperty, medicationList: medicationListProperty, historyList: historyListProperty, crewMembers: crewMembersProperty },
      required: [...fieldKeys, ...structuredFieldKeys],
      additionalProperties: false,
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: evidenceKeys },
          value: { type: 'string' },
          source: { type: 'string' },
          evidence: { type: 'string' },
          status: { type: 'string', enum: ['explicit', 'normalized', 'inferred', 'defaulted', 'conflict', 'unknown'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['key', 'value', 'source', 'evidence', 'status', 'confidence'],
        additionalProperties: false,
      },
    },
    missingQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: fieldKeys },
          question: { type: 'string' },
        },
        required: ['key', 'question'],
        additionalProperties: false,
      },
    },
  },
  required: ['chart', 'evidence', 'missingQuestions'],
  additionalProperties: false,
};

const systemInstructions = `You are an EMS chart abstraction assistant. Extract patient care record data from rough EMS notes and create a clear clinical narrative.

Rules:
- Never invent patient facts, treatments, vital signs, times, personnel, or outcomes.
- Preserve explicit negative findings as chartable values. Examples: "no allergies" becomes "No known allergies"; "takes no medications" becomes "No medications reported".
- Patient sex is required. Recognize compact demographic forms such as "Sex: M", "Sex=M", "M", "Sex: F", and "Sex=F" when they clearly label patient sex, and normalize to Male or Female.
- Infer medicalTrauma from the chief complaint and mechanism. Chest pain/pressure, dyspnea, syncope, abdominal pain, altered mental status, and other non-injury complaints must be Medical. Falls, collisions, lacerations, fractures, assaults, and other injury mechanisms must be Trauma. Use Medical and trauma when both are present. Use an empty string only when neither the complaint nor mechanism supports a classification.
- Extract scene city from the location/address context, not from a destination hospital name.
- Treat document section labels and nearby headings as evidence. An address in Demographics, Patient Information, Residence, Home Address, or Mailing Address belongs in patientAddress/patientCity/patientState/patientZip. An address in Scene, Incident, Dispatch, Response Location, or Call Location belongs in address/city. Never copy a demographics address into the scene fields. Populate both only when the notes explicitly establish that the incident occurred at the patient's residence.
- The input contains separately labeled source documents. Use the source label in every evidence item. A medication/history sheet is authoritative for its listed medications and history; call notes are authoritative for their written demographics and observations; a hospital patch describes status during transport but does not by itself prove arrival or completed transport. Treat facts in fictional demo documents as supplied evidence, but omit demo disclaimers and meta-commentary from the clinical narrative.
- Aggregate rather than replace: extract every unique medication into medicationList and every unique medical/surgical history item into historyList across all sources. Preserve available dose, route, frequency, reason, dates, procedures, and ejection fraction. Also provide readable summary strings in medications and history.
- Put every vital-sign observation into vitals. A time printed in a vitals row belongs to that observation and must never populate dispatchTime. Do not infer dispatch from the earliest timestamp; dispatch time requires explicit dispatch labeling.
- A numeric pain score such as 5/10 is pain, not overall distress. Put it in the matching vital record and initialPainScore/currentPainScore. Populate distress only when a source explicitly describes none, mild, moderate, or severe distress.
- Attempt every supported field, including optional fields. Optional does not mean ignore it: extract weight, patient residence information, medical history, last oral intake, and alcohol/drug information whenever supported. Leave an optional field empty when absent and never ask a follow-up question for it.
- Search the entire narrative—not only a Crew heading—for actual human names associated with crew roles, and return each person separately in crewMembers. Use role descriptions to select Primary care, Driver, Attendant, or Observer. Examples: "Jones attended/was lead medic" means Primary care; "Smith drove/operator" means Driver; "Brown rode in back/assisted with care" means Attendant; "student Lee/ride-along" means Observer. "Post 53", "Station 2", "Medic 7", "Unit 53", "Ambulance 4", an ED room, and a hospital bed are not people and must never appear in crewMembers. If no human crew name is stated, return an empty array rather than converting an operational identifier into a person.
- For pregnancy, use Not applicable for a male patient under this form's configured rule; use Yes, Possible, or No only when supported; otherwise use Unknown. Default alcoholDrugs to "None suspected" when no involvement is stated. These fields should not generate follow-up questions.
- Infer compatible operational selections from the final outcome: patient details or documented assessment implies unitDisposition "Patient contact"; explicit no contact/no patient implies "No patient contact"; this unit transporting implies careDisposition "Transport by this unit", crewDisposition "Transported patient", and transportDisposition "Transported by EMS"; refusal implies careDisposition "Refused care" and transportDisposition "Not transported"; transport by another or air unit implies careDisposition "Transport by another unit" and crewDisposition "Assisted other unit". Infer transportedTo from the facility type named in the notes.
- Always look for the responding or transporting EMS unit, including compact forms such as M2, Medic-2, Amb 4, A4, unit #53, Rescue 1, E3, and SQ5. Normalize these to readable names. Do not use an ED room, hospital unit, bed number, or crew member number as the EMS unit.
- Always determine final disposition from explicit completed-call evidence. Map transported/conveyed/taken to a facility to "Transported"; refused or declined care/transport, AMA, RMA, or signed refusal to "Patient refused care"; treated and released at scene to "Treated and released"; cancelled/disregarded to "Cancelled"; pronounced dead/DOA to "Deceased"; no patient found/unable to locate to "No patient found"; and transport by another EMS unit to "Transferred to another unit". "En route", "during transport", an ETA, a plan, or a hospital patch alone does not prove completed transport or arrival. Leave disposition empty and ask for the final outcome when no completed outcome is supplied.
- Use empty strings for information that is not present and cannot be safely inferred.
- Times should be HH:MM when available. Dates should be YYYY-MM-DD when available.
- The narrative must always be newly synthesized as concise, chronological, third-person EMS documentation rather than copied verbatim. Use complete sentences, resolve fragments and repeated wording, and improve clinical clarity. Include only supported facts. Do not claim assessments, interventions, or responses that were not supplied. In context, "tx" may mean transport; never turn it into treatment unless an actual intervention is named.
- Evidence should quote or closely paraphrase the shortest source phrase supporting each non-empty field and identify its source label. Set status to explicit for directly stated facts, normalized for formatting changes, inferred for supported conclusions, defaulted for application defaults, conflict when sources disagree, and unknown when unresolved. Mark inferred/defaulted values medium or low confidence rather than presenting them as direct high-confidence facts.
- Counterexamples: "Vitals at 9:02 PM" is not dispatch at 9:02 PM. "Pain 5/10" is not moderate distress. "Medic 53" is a unit, not a crew member. An address under Demographics is not a scene address. "En route with an ETA of eight minutes" is not completed transport or transfer of care.
- Ask one concise question for every missing field that is required to complete a typical patient care record. Do not ask for a field already resolved by an explicit negative statement. When disposition is not Transported, do not ask for destination, transport mode, condition at destination, or care-transfer time.
- Optional fields in this application are weight, patient residence address/city/state/ZIP, medical history, last oral intake, pain scores, pregnancy, alcohol/drug information, and the detailed disposition selections. Extract or infer them when possible, but never include them in missingQuestions.`;

function normalizedUnit(type, identifier) {
  const labels = { medic: 'Medic', m: 'Medic', ambulance: 'Ambulance', amb: 'Ambulance', a: 'Ambulance', rescue: 'Rescue', r: 'Rescue', engine: 'Engine', e: 'Engine', squad: 'Squad', sq: 'Squad' };
  return `${labels[type.toLowerCase()] || 'Unit'} ${identifier.toUpperCase()}`;
}

function unitFromNotes(text) {
  const named = text.match(/\b(medic|ambulance|amb|rescue|engine|squad)\s*[-#:]?\s*([a-z]?\d+[a-z]?)\b/i);
  if (named) return normalizedUnit(named[1], named[2]);
  const numbered = text.match(/\bunit\s*(?:number|no\.?|#)?\s*[-#:]?\s*([a-z]?\d+[a-z]?)\b/i);
  if (numbered) return `Unit ${numbered[1].toUpperCase()}`;
  const compact = text.match(/\b(M|A|R|E|SQ)\s*[-#]?\s*(\d+[A-Z]?)\b/i);
  return compact ? normalizedUnit(compact[1], compact[2]) : '';
}

function dispositionFromNotes(text) {
  const rules = [
    ['Deceased', /\b(?:pronounced (?:dead|deceased)|death pronounced|dead on arrival|d\.?(?:o\.?)?a\.?)\b/i],
    ['Patient refused care', /\b(?:refus(?:ed|al)|declined (?:care|evaluation|transport)|signed (?:a )?refusal|against medical advice|a\.?(?:m\.?)?a\.?|r\.?(?:m\.?)?a\.?)\b/i],
    ['Cancelled', /\b(?:call )?cancell?ed\b|\bdisregard(?:ed)?\b/i],
    ['No patient found', /\b(?:no patient (?:found|located)|unable to locate (?:the )?patient|gone on arrival)\b/i],
    ['Transferred to another unit', /\b(?:transported by|care transferred to)\s+(?:another|other|mutual aid)\s+(?:ems )?unit\b/i],
    ['Treated and released', /\b(?:treated and released|released at scene|treated at scene and (?:left|released))\b/i],
    ['Transported', /\b(?:patient (?:was )?)?(?:transported|conveyed)\b|\btaken to\s+(?:the\s+)?(?:hospital|medical center|trauma center|emergency department|ed)\b/i],
  ];
  const matches = rules.map(([value, pattern], priority) => {
    const match = text.match(pattern);
    return match ? { value, index: match.index, priority } : null;
  }).filter(Boolean);
  return matches.sort((a, b) => b.index - a.index || a.priority - b.priority)[0]?.value || '';
}

function splitSourceDocuments(text) {
  const marker = /(?:^|\n)\s*(Image transcription \(([^)]+)\)|Voice recorded hospital patch|Voice transcription(?: \([^)]+\))?|Call notes|Run notes)\s*:\s*/gi;
  const matches = [...text.matchAll(marker)];
  if (!matches.length) return [{ label: 'Run notes', type: 'run_notes', text: text.trim() }];
  const sources = [];
  if (matches[0].index > 0 && text.slice(0, matches[0].index).trim()) {
    sources.push({ label: 'Run notes', type: 'run_notes', text: text.slice(0, matches[0].index).trim() });
  }
  matches.forEach((match, index) => {
    const label = match[1].trim();
    const filename = String(match[2] || '').toLowerCase();
    const body = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim();
    if (!body) return;
    let type = 'run_notes';
    if (/voice|hospital patch/i.test(label)) type = 'hospital_patch';
    else if (/medication|history|medical|meds/.test(filename)) type = 'medication_history_sheet';
    else if (/call|incident|note/.test(filename) || /call notes/i.test(label)) type = 'call_notes';
    sources.push({ label, type, text: body });
  });
  return sources.length ? sources : [{ label: 'Run notes', type: 'run_notes', text: text.trim() }];
}

function sexFromNotes(text) {
  const explicit = text.match(/\b(?:patient\s+)?sex\s*[:=\-]\s*(female|male|f|m)\b/i);
  if (!explicit) return '';
  return /^f/i.test(explicit[1]) ? 'Female' : 'Male';
}

function destinationType(chart, text) {
  const value = `${chart.destination || ''} ${text}`;
  if (/\btrauma (?:center|centre)\b/i.test(value)) return 'Trauma center';
  if (/\burgent care\b/i.test(value)) return 'Urgent care';
  if (/\b(?:hospital|medical cent(?:er|re)|emergency department|ED)\b/i.test(value)) return 'Hospital';
  return chart.destination ? 'Other' : '';
}

function isLikelyCrewPerson(name) {
  const value = String(name || '').trim();
  if (!value || !/[A-Za-z]/.test(value)) return false;
  if (/^(?:post|station|base|unit|medic|ambulance|amb|rescue|engine|squad|truck|apparatus|vehicle|room|bed|ed|hospital)\s*(?:no\.?|number|#)?\s*[-#:]?\s*[A-Z]?\d+[A-Z]?$/i.test(value)) return false;
  if (/^(?:post|station|base|unit|apparatus|vehicle)\b/i.test(value)) return false;
  return true;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasCrewAssociation(name, text) {
  const pattern = new RegExp(escapeRegExp(name), 'ig');
  const rolePattern = /\b(?:crew|provider|clinician|medic|paramedic|emt|aemt|driver|operator|attendant|partner|primary care|lead|rode in back|student|ride[- ]along)\b/i;
  for (const match of text.matchAll(pattern)) {
    const context = text.slice(Math.max(0, match.index - 100), match.index + match[0].length + 100);
    if (rolePattern.test(context)) return true;
  }
  return false;
}

function cleanString(value) {
  return String(value || '').trim();
}

function normalizeClockTime(value) {
  const text = cleanString(value).replace(/\./g, '');
  const match = text.match(/^(\d{1,2}):(\d{2})\s*([ap])?m?$/i);
  if (!match) return text;
  let hour = Number(match[1]);
  const period = String(match[3] || '').toLowerCase();
  if (period === 'p' && hour < 12) hour += 12;
  if (period === 'a' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function normalizePainScore(value) {
  const text = cleanString(value);
  if (/^(?:10|[0-9])$/.test(text)) return `${text}/10`;
  return text;
}

function dedupeBy(items, keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeStructuredLists(chart) {
  chart.vitals = (Array.isArray(chart.vitals) ? chart.vitals : []).map((item) => ({
    time: normalizeClockTime(item?.time), heartRate: cleanString(item?.heartRate), systolicBP: cleanString(item?.systolicBP),
    diastolicBP: cleanString(item?.diastolicBP), spo2: cleanString(item?.spo2), respiratoryRate: cleanString(item?.respiratoryRate),
    glucose: cleanString(item?.glucose), painScore: normalizePainScore(item?.painScore),
  })).filter((item) => Object.values(item).some(Boolean));
  chart.medicationList = dedupeBy((Array.isArray(chart.medicationList) ? chart.medicationList : []).map((item) => ({
    name: cleanString(item?.name), dose: cleanString(item?.dose), route: cleanString(item?.route),
    frequency: cleanString(item?.frequency), reason: cleanString(item?.reason),
  })).filter((item) => item.name), (item) => item.name);
  chart.historyList = dedupeBy((Array.isArray(chart.historyList) ? chart.historyList : []).map((item) => ({
    condition: cleanString(item?.condition), details: cleanString(item?.details),
  })).filter((item) => item.condition), (item) => item.condition);
  if (chart.medicationList.length) chart.medications = chart.medicationList.map((item) => {
    const administration = [item.dose, item.route, item.frequency].filter(Boolean).join(' · ');
    return `${item.name}${administration ? ` — ${administration}` : ''}${item.reason ? ` (${item.reason})` : ''}`;
  }).join('\n');
  if (chart.historyList.length) chart.history = chart.historyList.map((item) => `${item.condition}${item.details ? ` — ${item.details}` : ''}`).join('\n');
  const painScores = chart.vitals.map((item) => item.painScore).filter(Boolean);
  if (painScores.length) {
    chart.initialPainScore = painScores[0];
    chart.currentPainScore = painScores.at(-1);
  }
}

function pregnancyFromNotes(text, sex) {
  if (sex === 'Male') return 'Not applicable';
  if (/\b(?:possibly|possibly is|may be|could be) pregnant\b/i.test(text)) return 'Possible';
  if (/\b(?:denies pregnancy|not pregnant|pregnancy\s*[:=]\s*no)\b/i.test(text)) return 'No';
  if (/\b(?:is pregnant|pregnancy\s*[:=]\s*yes|pregnant patient)\b/i.test(text)) return 'Yes';
  return 'Unknown';
}

function hasExplicitDispatchTime(text) {
  return /\b(?:dispatch(?:ed)?|notified|call received)\s*(?:time\s*)?(?:at|:|=|-)?\s*\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?/i.test(text);
}

function explicitDistress(text) {
  const match = text.match(/\b(no apparent|no acute|none|mild|moderate|severe)\s+(?:level of\s+)?distress\b/i);
  if (!match) return '';
  if (/^no|none/i.test(match[1])) return 'None';
  return match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
}

function hasCompletedOutcome(text) {
  return /\b(?:patient (?:was )?)?(?:transported|conveyed|taken)\s+to\b|\barrived at\b|\bcare (?:was )?transferred\b|\b(?:refus(?:ed|al)|declined (?:care|transport)|treated and released|released at scene|pronounced (?:dead|deceased)|dead on arrival|no patient (?:found|located)|call cancell?ed|disregarded)\b/i.test(text);
}

function ensureQuestion(result, key, question) {
  if (!result.missingQuestions.some((item) => item.key === key)) result.missingQuestions.push({ key, question });
}

function applyOperationalSelections(chart, sourceText) {
  const noContact = /\b(?:no patient contact|without patient contact|unable to locate (?:the )?patient|no patient (?:found|located))\b/i.test(sourceText);
  const cancelledEnRoute = /\b(?:cancell?ed|disregarded)\b[\s\S]{0,40}\b(?:en route|before arrival|prior to arrival)\b|\b(?:en route|before arrival|prior to arrival)\b[\s\S]{0,40}\b(?:cancell?ed|disregarded)\b/i.test(sourceText);
  const patientDetails = ['name', 'age', 'sex', 'complaint', 'allergies', 'medications'].some((key) => String(chart[key] || '').trim());
  if (/\b(?:transported|conveyed|transport)\b[\s\S]{0,40}\bnon[- ]?emergent\b|\bnon[- ]?emergent\b[\s\S]{0,40}\b(?:transported|conveyed|transport)\b/i.test(sourceText)) chart.transportMode = 'Non-emergent';
  else if (/\b(?:transported|conveyed|transport)\b[\s\S]{0,40}\bemergent\b|\bemergent\b[\s\S]{0,40}\b(?:transported|conveyed|transport)\b/i.test(sourceText)) chart.transportMode = 'Emergent';
  if (cancelledEnRoute) chart.unitDisposition = 'Cancelled en route';
  else if (noContact || chart.disposition === 'No patient found') chart.unitDisposition = 'No patient contact';
  else if (patientDetails || ['Transported', 'Patient refused care', 'Treated and released', 'Deceased', 'Transferred to another unit'].includes(chart.disposition)) chart.unitDisposition = 'Patient contact';

  const airTransport = /\b(?:air medical|medical helicopter|helicopter|flight crew|lifeline|medevac)\b/i.test(sourceText);
  if (chart.disposition === 'Transported') {
    chart.careDisposition = airTransport ? 'Transport by another unit' : 'Transport by this unit';
    chart.crewDisposition = airTransport ? 'Assisted other unit' : 'Transported patient';
    chart.transportDisposition = airTransport ? 'Air medical' : 'Transported by EMS';
    chart.transportedTo = chart.transportedTo || destinationType(chart, sourceText);
  } else if (chart.disposition === 'Transferred to another unit') {
    chart.careDisposition = 'Transport by another unit';
    chart.crewDisposition = 'Assisted other unit';
    chart.transportDisposition = airTransport ? 'Air medical' : 'Transported by EMS';
    chart.transportedTo = chart.transportedTo || destinationType(chart, sourceText);
  } else if (chart.disposition === 'Patient refused care') {
    chart.careDisposition = 'Refused care';
    chart.crewDisposition = 'Released at scene';
    chart.transportDisposition = 'Not transported';
    chart.transportMode = 'No transport';
  } else if (['Treated and released', 'Cancelled', 'Deceased', 'No patient found'].includes(chart.disposition)) {
    chart.crewDisposition = chart.disposition === 'Cancelled' && cancelledEnRoute ? '' : 'Released at scene';
    chart.transportDisposition = 'Not transported';
    chart.transportMode = 'No transport';
  }
}

function normalizeExtraction(result, sourceText, sources = splitSourceDocuments(sourceText)) {
  const chart = result.chart || {};
  normalizeStructuredLists(chart);
  const explicitSex = sexFromNotes(sourceText);
  if (explicitSex) chart.sex = explicitSex;
  const sourceUnit = unitFromNotes(sourceText);
  if (sourceUnit) chart.unit = sourceUnit;
  const inProgressOnly = /\b(?:en route|during transport|estimated arrival|ETA)\b/i.test(sourceText) && !hasCompletedOutcome(sourceText);
  const sourceDisposition = inProgressOnly ? '' : dispositionFromNotes(sourceText);
  if (sourceDisposition) chart.disposition = sourceDisposition;
  else if (inProgressOnly && chart.disposition === 'Transported') chart.disposition = '';
  chart.pregnancy = pregnancyFromNotes(sourceText, chart.sex);
  chart.alcoholDrugs = chart.alcoholDrugs || 'None suspected';
  chart.dispatchTime = hasExplicitDispatchTime(sourceText) ? chart.dispatchTime : '';
  chart.distress = explicitDistress(sourceText);
  const sceneContext = /\b(?:scene|incident|dispatch|response|call)\s+(?:address|location|city)\b|\brespond(?:ed|ing)\s+to\b/i.test(sourceText);
  if (!sceneContext && cleanString(chart.address).toLowerCase() === cleanString(chart.patientAddress).toLowerCase()) chart.address = '';
  if (!sceneContext && cleanString(chart.city).toLowerCase() === cleanString(chart.patientCity).toLowerCase()) chart.city = '';
  chart.crewMembers = (Array.isArray(chart.crewMembers) ? chart.crewMembers : [])
    .map((member) => ({ name: String(member?.name || '').trim(), role: String(member?.role || '').trim(), certificationLevel: String(member?.certificationLevel || '').trim() }))
    .map((member) => ({ ...member, name: member.certificationLevel ? member.name.replace(/^(?:EMT|AEMT|Paramedic|RN)\s+/i, '') : member.name }))
    .filter((member) => isLikelyCrewPerson(member.name))
    .filter((member) => member.name.toLowerCase() !== cleanString(chart.name).toLowerCase())
    .filter((member) => hasCrewAssociation(member.name, sourceText));
  chart.crew = chart.crewMembers.length ? chart.crewMembers.map((member) => `${member.name}${member.role ? ` — ${member.role}` : ''}`).join('; ') : '';
  applyOperationalSelections(chart, sourceText);
  result.missingQuestions = (result.missingQuestions || []).filter(({ key }) => !optionalFieldKeys.has(key));
  if (chart.disposition && chart.disposition !== 'Transported') result.missingQuestions = result.missingQuestions.filter(({ key }) => !['destination', 'transportMode', 'condition', 'careTransferTime'].includes(key));
  result.missingQuestions = result.missingQuestions.filter(({ key }) => !String(chart[key] || '').trim());
  if (!chart.crew && !result.missingQuestions.some(({ key }) => key === 'crew')) result.missingQuestions.push({ key: 'crew', question: 'What are the names and roles of the human crew members documented for this call?' });
  if (!chart.dispatchTime) ensureQuestion(result, 'dispatchTime', 'What was the explicitly recorded dispatch time?');
  if (!chart.distress) ensureQuestion(result, 'distress', 'What was the patient’s documented overall level of distress (not the pain score)?');
  if (!chart.address) ensureQuestion(result, 'address', 'What was the scene or incident street address?');
  if (!chart.city) ensureQuestion(result, 'city', 'What was the scene city?');
  if (!chart.disposition) ensureQuestion(result, 'disposition', 'What was the final disposition after the call was completed?');
  result.chart = chart;
  return result;
}

async function openAIResponse({ instructions, input, name, schema }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not available to the local server.');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input,
      store: false,
      text: { format: { type: 'json_schema', name, strict: true, schema } },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI request failed (${response.status}).`);
  const outputText = payload.output_text || payload.output
    ?.flatMap((item) => item.content || [])
    .find((item) => item.type === 'output_text')?.text;
  if (!outputText) throw new Error('The model did not return structured chart data.');
  return JSON.parse(outputText);
}

async function readJson(req, maxBytes = 200_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) throw new Error('Request is too large.');
  }
  return JSON.parse(body || '{}');
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function allowAIRequest(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const client = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const current = requestWindows.get(client);
  if (!current || now - current.startedAt >= 3_600_000) {
    requestWindows.set(client, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_HOUR) return false;
  current.count += 1;
  return true;
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/extract') {
      if (!allowAIRequest(req)) return sendJson(res, 429, { error: 'Demo AI request limit reached. Please try again later.' });
      const { text } = await readJson(req);
      if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: 'Run notes are required.' });
      const sources = splitSourceDocuments(text.trim());
      const result = await openAIResponse({
        instructions: systemInstructions,
        input: `Extract the EMS chart from these separately labeled source documents:\n\n${JSON.stringify(sources, null, 2)}`,
        name: 'ems_chart_extraction',
        schema: extractionSchema,
      });
      return sendJson(res, 200, normalizeExtraction(result, text, sources));
    }

    if (req.method === 'POST' && req.url === '/api/rewrite') {
      if (!allowAIRequest(req)) return sendJson(res, 429, { error: 'Demo AI request limit reached. Please try again later.' });
      const { sourceText, chart } = await readJson(req);
      const narrativeSchema = {
        type: 'object',
        properties: { narrative: { type: 'string' } },
        required: ['narrative'],
        additionalProperties: false,
      };
      const result = await openAIResponse({
        instructions: `${systemInstructions}\nReturn only a rewritten narrative using the source notes and the verified chart values.`,
        input: `Source notes:\n${String(sourceText || '')}\n\nVerified chart values:\n${JSON.stringify(chart || {})}`,
        name: 'ems_narrative_rewrite',
        schema: narrativeSchema,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && req.url === '/api/transcribe-note') {
      if (!allowAIRequest(req)) return sendJson(res, 429, { error: 'Demo AI request limit reached. Please try again later.' });
      const { imageDataUrl } = await readJson(req, 28_100_000);
      if (typeof imageDataUrl !== 'string' || !/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(imageDataUrl)) {
        return sendJson(res, 400, { error: 'Upload a JPEG, PNG, WebP, or GIF image.' });
      }
      if (imageDataUrl.length > 28_000_000) return sendJson(res, 413, { error: 'The image must be 20 MB or smaller.' });
      const result = await openAIResponse({
        instructions: `You transcribe images of handwritten or printed EMS notes. Return a faithful plain-text transcription of only the text that is visibly present. Preserve clinically meaningful abbreviations, numbers, times, medication names, and line order where practical. Do not infer missing words or add patient facts. Use [unclear] for text that cannot be read. If no note text is visible, return an empty transcription.`,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'Transcribe all readable note text in this image for inclusion in rough EMS run notes.' },
            { type: 'input_image', image_url: imageDataUrl, detail: 'high' },
          ],
        }],
        name: 'ems_note_image_transcription',
        schema: {
          type: 'object',
          properties: { transcription: { type: 'string' } },
          required: ['transcription'],
          additionalProperties: false,
        },
      });
      return sendJson(res, 200, result);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
    const requested = req.url === '/' ? '/ems-ai-assistant.html' : decodeURIComponent(req.url.split('?')[0]);
    const relative = normalize(requested).replace(/^[/\\]+/, '');
    const filePath = join(ROOT, relative);
    if (!filePath.startsWith(ROOT)) return sendJson(res, 403, { error: 'Forbidden.' });
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not found');
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  } catch (error) {
    const status = error?.code === 'ENOENT' || error?.message === 'Not found' ? 404 : 500;
    sendJson(res, status, { error: status === 404 ? 'Not found.' : error.message || 'Unexpected server error.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`EMS AI server running at http://${HOST}:${PORT}`);
  console.log(`OpenAI model: ${MODEL}`);
});
