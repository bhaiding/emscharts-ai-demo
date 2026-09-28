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
- Normalizes common unit shorthand such as `M2`, `Amb 4`, and `unit #53`, and maps final outcomes to chart-compatible dispositions including transported, refused care, deceased, cancelled, and no patient found.
- Recognizes explicit negatives such as “no known allergies” and “takes no medications.”
- Infers medical versus trauma classification when supported by the complaint or mechanism.
- Identifies required information that is still missing and generates follow-up questions.
- Rewrites the patient care narrative for clarity while instructing the model not to invent unsupported facts.
- Uploads JPEG, PNG, WebP, or GIF note images for AI transcription directly into Run Notes. Voice recording remains a disabled visual placeholder for a future workflow.

### Interactive ePCR chart

- Provides patient, assessment, history, narrative, incident, destination, time, and crew sections.
- Synchronizes with the AI intake page through browser local storage.
- Updates section counts and overall chart completion as information is added or cleared.
- Imports two fictional CAD records using Notre Dame-area demo addresses.
- Enables submission only after all required fields are complete.
- Displays a simulated successful upload message naming the receiving hospital.

## How it works

The two browser pages share chart data using `localStorage`. The AI page sends notes to a small Node.js server, which calls the OpenAI Responses API using structured JSON output. The OpenAI API key remains on the server and is never included in client-side code.

The public demo includes a basic per-IP request limit. A production implementation would also require authentication, durable rate limiting, audit logging, access controls, encryption policies, clinical validation, and organization-specific ePCR integrations.

## Run locally

Use Node.js 22 or newer:

```bash
OPENAI_API_KEY=your_key_here node server.mjs
```

Then open:

- `http://127.0.0.1:8765/ems-ai-assistant.html`
- `http://127.0.0.1:8765/ems-chart.html`

## Deploy your own copy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bhaiding/emscharts-ai-demo)

The included `render.yaml` creates the web service and prompts for `OPENAI_API_KEY` as a secret environment variable.

Docker is also supported:

```bash
docker build -t ems-ai-demo .
docker run --rm -p 8765:8765 -e OPENAI_API_KEY=your_key_here ems-ai-demo
```

## Clinical and privacy notice

- Do not enter real patient information or protected health information into this public demo.
- AI-generated documentation can contain mistakes and must be reviewed by a qualified clinician.
- This prototype is not intended for patient care, billing, compliance, or official medical-record use.
- Never commit an OpenAI API key or place it in browser JavaScript.
