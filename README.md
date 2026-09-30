# EMS AI Chart Demo

An interactive prototype that explores how AI could assist EMS clinicians with electronic patient care record (ePCR) documentation. Rough run notes are converted into structured chart fields, missing required information is identified, and the narrative is rewritten into clearer chronological documentation.

This project is a demonstration only. It is not a certified ePCR, medical device, or production clinical system.

## Live demos

- **[AI Intake Assistant](https://ems-ai-demo.onrender.com/ems-ai-assistant.html)** — enter rough call notes, extract chartable facts with OpenAI, answer follow-up questions, and generate a clearer narrative.
- **[Patient Care Record](https://ems-ai-demo.onrender.com/ems-chart.html)** — review or edit the full chart, import sample CAD calls, monitor completion, and simulate chart submission.

The Render free service may take several seconds to wake up after a period of inactivity.

## What the prototype demonstrates

### AI-assisted intake

- Extracts demographics, incident details, chief complaint, history, disposition, destination, operational times, and crew information from free text.
- Keeps separately labeled note images, call notes, and hospital patches as distinct sources so evidence provenance and context survive extraction.
- Captures repeat vital signs as structured observations and keeps pain scores separate from the clinician's overall distress assessment.
- Normalizes completed-call language such as medium distress, lights-and-sirens transport, and destination handoff times into the chart's controlled options.
- Aggregates complete medication and medical/surgical history lists across every supplied source instead of allowing a shorter call note to replace a more detailed history sheet.
- Normalizes common unit shorthand such as `M2`, `Amb 4`, and `unit #53`, and maps final outcomes to chart-compatible dispositions including transported, refused care, deceased, cancelled, and no patient found.
- Separates patient residence information from the scene address using demographics and incident-section context, while still extracting optional information whenever it is available.
- Extracts multiple crew members as separate records with inferred roles and certification levels, and derives compatible unit, care, crew, transport, and facility disposition selections.
- Recognizes explicit negatives such as “no known allergies” and “takes no medications.”
- Infers medical versus trauma classification when supported by the complaint or mechanism.
- Identifies required information that is still missing and generates follow-up questions.
- Rewrites the patient care narrative for clarity while instructing the model not to invent unsupported facts.
- Uploads JPEG, PNG, WebP, or GIF note images for AI transcription directly into Run Notes. Voice recording remains a disabled visual placeholder for a future workflow.

### Interactive ePCR chart

- Provides patient, assessment, repeat-vitals, history, narrative, incident, destination, time, and crew sections.
- Synchronizes with the AI intake page through browser local storage.
- Updates section counts and overall chart completion as information is added or cleared.
- Imports two fictional CAD records using Notre Dame-area demo addresses.
- Enables submission only after all required fields are complete.
- Displays a simulated successful upload message naming the receiving hospital.

## How it works

The two browser pages share chart data using `localStorage`. The AI page sends notes to a small Node.js server, which calls the OpenAI Responses API using structured JSON output. The OpenAI API key remains on the server and is never included in client-side code.

The model extracts supported facts into a strict schema and supplies evidence, source labels, confidence, and extraction status. A deterministic normalization layer then enforces safety-critical boundaries that are easier to test as rules: vital timestamps cannot become dispatch time, numeric pain cannot become distress, demographic addresses cannot silently become scene addresses, unit identifiers cannot become crew members, and an en-route hospital patch cannot by itself prove the final disposition. The supplied John Smith example is retained as an integration regression test in `tests/`.

The public demo includes a basic per-IP request limit. A production implementation would also require authentication, durable rate limiting, audit logging, access controls, encryption policies, clinical validation, and organization-specific ePCR integrations.

## Clinical and privacy notice

- Do not enter real patient information or protected health information into this public demo.
- AI-generated documentation can contain mistakes and must be reviewed by a qualified clinician.
- This prototype is not intended for patient care, billing, compliance, or official medical-record use.
- Never commit an OpenAI API key or place it in browser JavaScript.
