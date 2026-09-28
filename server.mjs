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
  'complaint', 'onset', 'distress', 'medicalTrauma', 'allergies',
  'medications', 'history', 'lastIntake', 'alcoholDrugs', 'disposition',
  'destination', 'transportMode', 'condition', 'dispatchTime',
  'careTransferTime', 'crew', 'narrative',
];
const optionalFieldKeys = new Set(['weight', 'patientAddress', 'patientCity', 'patientState', 'patientZip', 'history', 'lastIntake', 'alcoholDrugs']);

const chartProperties = Object.fromEntries(fieldKeys.map((key) => [key, {
  type: 'string',
  description: `Chart value for ${key}. Return an empty string when not stated or safely inferable.`,
}]));
chartProperties.medicalTrauma = {
  type: 'string',
  enum: ['', 'Medical', 'Trauma', 'Medical and trauma'],
  description: 'Required classification inferred from the chief complaint and mechanism. Chest pain, dyspnea, illness, syncope, and similar non-injury complaints are Medical. Falls, collisions, wounds, fractures, and other injuries are Trauma. Use Medical and trauma when both are present.',
};
chartProperties.unit.description = 'Responding or transporting EMS unit identifier. Extract common forms including Medic 2, Medic-2, M2, Ambulance 4, Amb 4, A4, Rescue 1, Engine 3, Squad 5, and unit #53. Normalize unambiguous abbreviations: M2 to Medic 2, Amb 4 or A4 to Ambulance 4, R1 to Rescue 1, E3 to Engine 3, and SQ5 to Squad 5. Do not confuse a room, bed, destination unit, or crew number with the EMS unit.';
chartProperties.disposition = {
  type: 'string',
  enum: ['', 'Transported', 'Patient refused care', 'Treated and released', 'Cancelled', 'Deceased', 'No patient found', 'Transferred to another unit'],
  description: 'Final patient disposition. Normalize transported/conveyed/taken to a facility as Transported; refused or declined care/transport, AMA, or signed refusal as Patient refused care; treated and left at scene as Treated and released; cancelled/disregarded calls as Cancelled; pronounced dead or DOA as Deceased; no patient located as No patient found; and transport by another EMS unit as Transferred to another unit.',
};
chartProperties.patientAddress.description = 'Patient home, residence, or mailing street address from a demographics, patient information, residence, or home-address section. Do not put the incident location here unless the notes explicitly say the scene was the patient home.';
chartProperties.patientCity.description = 'City belonging to the patient home/residence address. Do not use the scene or destination city unless explicitly identified as the patient residence.';
chartProperties.patientState.description = 'State belonging to the patient home/residence address.';
chartProperties.patientZip.description = 'ZIP/postal code belonging to the patient home/residence address.';
chartProperties.address.description = 'Scene or incident street address only. Extract from scene, incident, dispatch, response-location, or location sections. An address appearing only in demographics or patient information is the patient address and this field must remain empty.';
chartProperties.city.description = 'Scene city derived only from the scene/incident location or address. Do not use the patient residence city or destination city.';
chartProperties.allergies.description = 'Reported allergies. Explicit negatives such as no allergies or NKDA must be returned as No known allergies.';
chartProperties.medications.description = 'Reported medications. Explicit negatives such as takes no medications must be returned as No medications reported.';
chartProperties.narrative.description = 'Newly synthesized chronological third-person EMS narrative using only supported facts; never copy rough source wording verbatim.';

const extractionSchema = {
  type: 'object',
  properties: {
    chart: {
      type: 'object',
      properties: chartProperties,
      required: fieldKeys,
      additionalProperties: false,
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: fieldKeys },
          evidence: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['key', 'evidence', 'confidence'],
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
- Infer medicalTrauma from the chief complaint and mechanism. Chest pain/pressure, dyspnea, syncope, abdominal pain, altered mental status, and other non-injury complaints must be Medical. Falls, collisions, lacerations, fractures, assaults, and other injury mechanisms must be Trauma. Use Medical and trauma when both are present. Use an empty string only when neither the complaint nor mechanism supports a classification.
- Extract scene city from the location/address context, not from a destination hospital name.
- Treat document section labels and nearby headings as evidence. An address in Demographics, Patient Information, Residence, Home Address, or Mailing Address belongs in patientAddress/patientCity/patientState/patientZip. An address in Scene, Incident, Dispatch, Response Location, or Call Location belongs in address/city. Never copy a demographics address into the scene fields. Populate both only when the notes explicitly establish that the incident occurred at the patient's residence.
- Attempt every supported field, including optional fields. Optional does not mean ignore it: extract weight, patient residence information, medical history, last oral intake, and alcohol/drug information whenever supported. Leave an optional field empty when absent and never ask a follow-up question for it.
- Always look for the responding or transporting EMS unit, including compact forms such as M2, Medic-2, Amb 4, A4, unit #53, Rescue 1, E3, and SQ5. Normalize these to readable names. Do not use an ED room, hospital unit, bed number, or crew member number as the EMS unit.
- Always determine final disposition from the complete call outcome. Map transported/conveyed/taken to a facility to "Transported"; refused or declined care/transport, AMA, RMA, or signed refusal to "Patient refused care"; treated and released at scene to "Treated and released"; cancelled/disregarded to "Cancelled"; pronounced dead/DOA to "Deceased"; no patient found/unable to locate to "No patient found"; and transport by another EMS unit to "Transferred to another unit". A recommendation to transport is not proof that transport occurred.
- Use empty strings for information that is not present and cannot be safely inferred.
- Times should be HH:MM when available. Dates should be YYYY-MM-DD when available.
- The narrative must always be newly synthesized as concise, chronological, third-person EMS documentation rather than copied verbatim. Use complete sentences, resolve fragments and repeated wording, and improve clinical clarity. Include only supported facts. Do not claim assessments, interventions, or responses that were not supplied. In context, "tx" may mean transport; never turn it into treatment unless an actual intervention is named.
- Evidence should quote or closely paraphrase the shortest source phrase supporting each non-empty field. Mark inferred classifications medium confidence.
- Ask one concise question for every missing field that is required to complete a typical patient care record. Do not ask for a field already resolved by an explicit negative statement. When disposition is not Transported, do not ask for destination, transport mode, condition at destination, or care-transfer time.
- Optional fields in this application are weight, patient residence address/city/state/ZIP, medical history, last oral intake, and alcohol/drug information. Extract them when present, but never include them in missingQuestions.`;

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

function normalizeExtraction(result, sourceText) {
  const chart = result.chart || {};
  const sourceUnit = unitFromNotes(sourceText);
  if (sourceUnit) chart.unit = sourceUnit;
  const sourceDisposition = dispositionFromNotes(sourceText);
  if (sourceDisposition) chart.disposition = sourceDisposition;
  result.missingQuestions = (result.missingQuestions || []).filter(({ key }) => !optionalFieldKeys.has(key));
  if (chart.disposition && chart.disposition !== 'Transported') result.missingQuestions = result.missingQuestions.filter(({ key }) => !['destination', 'transportMode', 'condition', 'careTransferTime'].includes(key));
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
      const result = await openAIResponse({
        instructions: systemInstructions,
        input: `Extract the EMS chart from these source notes:\n\n${text.trim()}`,
        name: 'ems_chart_extraction',
        schema: extractionSchema,
      });
      return sendJson(res, 200, normalizeExtraction(result, text));
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
