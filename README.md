# EMS AI Chart Demo

A browser-based EMS patient care record prototype with an AI-assisted intake workflow. It is a demonstration product and is not intended for real patient documentation or production clinical use.

## Demo pages

- `/ems-ai-assistant.html` — AI intake, structured extraction, follow-up questions, and narrative rewriting
- `/ems-chart.html` — interactive ePCR chart, CAD demo import, live completion tracking, and submission demo

The two pages share chart data through browser local storage. The AI page calls a small server-side OpenAI proxy so the API key never appears in browser code.

## Run locally

Use Node.js 22 or newer:

```bash
OPENAI_API_KEY=your_key_here node server.mjs
```

Then open `http://127.0.0.1:8765`.

## Deploy on Render

1. Create a new Blueprint in Render and select this repository.
2. Render will detect `render.yaml`.
3. Add `OPENAI_API_KEY` as a secret environment variable.
4. Deploy the service.

The public AI and chart URLs will be:

- `https://YOUR-SERVICE.onrender.com/ems-ai-assistant.html`
- `https://YOUR-SERVICE.onrender.com/ems-chart.html`

## Run with Docker

```bash
docker build -t ems-ai-demo .
docker run --rm -p 8765:8765 -e OPENAI_API_KEY=your_key_here ems-ai-demo
```

## Security and clinical notice

- Never commit an OpenAI API key or place it in client-side JavaScript.
- The demo includes a basic per-IP AI request limit. A real public product should add authentication, durable rate limiting, logging controls, and abuse monitoring.
- Do not enter protected health information or real patient data into this demo.
- All AI-generated documentation must be reviewed by a qualified clinician.
