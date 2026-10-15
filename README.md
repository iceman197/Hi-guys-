# ICEMAN CODE LEARN

A mobile-first coding academy starter project. The homepage is a single `public/index.html` file with HTML, CSS, and browser JavaScript combined in it. Node.js/Express stays in the project root.

## Project structure

```text
iceman-code-learn/
├── public/
│   └── index.html       # Complete single-file frontend
├── uploads/             # Created automatically for authorized APK uploads
├── server.js            # Express backend and Gemini API proxy
├── package.json
├── render.yaml
├── .env.example
├── .gitignore
└── README.md
```

## Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
# Edit .env and set GEMINI_API_KEY, ADMIN_PASSWORD, SESSION_SECRET
npm start
```

Open `http://localhost:3000`.

## Deploy to Render

1. Push this folder to a new GitHub repository.
2. In Render, create a **New Web Service** and connect the repository's `main` branch.
3. Render can use `render.yaml`, or set build command `npm install` and start command `npm start`.
4. Add these environment variables in Render:
   - `GEMINI_API_KEY`: your Gemini API key (secret; server-side only)
   - `ADMIN_PASSWORD`: a long, unique admin password
   - `SESSION_SECRET`: a long random secret (the blueprint generates one)
   - `GEMINI_MODEL`: optional; default is `gemini-2.5-flash`
   - `NODE_ENV=production`
5. Deploy and test `https://YOUR-SERVICE.onrender.com/api/health`.

**Never commit `.env` or paste API keys into `public/index.html`, `app.js`, or any browser JavaScript.**

## Included now

- Responsive dark neon-blue dashboard inspired by the supplied reference
- Course cards and beginner lesson checklists
- HTML/CSS/JavaScript live preview in a sandboxed iframe
- AI coding help buttons inside both editor modes and every coding lab; each sends its context to the protected `/api/ai` backend
- Python editor that runs in the browser through Pyodide (first run requires internet access)
- Local projects, snippets, course progress and quizzes stored in this browser
- Local developer tools: JSON formatter, Base64 encoder/decoder, color picker and case converter
- Gemini AI proxy at `POST /api/ai`
- Admin password login endpoint and protected APK upload endpoint
- Health check at `GET /api/health`

## Important limitations / production hardening

- Browser localStorage is per browser/device and is not a user account database or cloud sync.
- Python execution uses Pyodide in the browser, not on the Node.js server. It requires an internet connection to download the runtime the first time; some Python packages may not be available.
- Admin login uses an in-memory Express session store by default. For production use across restarts or multiple instances, configure a persistent session store.
- Render free web services use ephemeral local storage. APK uploads can disappear after restart/redeploy; use persistent storage or object storage before relying on uploads.
- APK uploads are restricted to `.apk` extension and admin login, but extension checks do not prove an APK is safe. Scan and review uploads before distribution.
- `index.html` uses inline CSS and JS to keep the frontend in one file; CSP is disabled in Helmet for that reason. Review a strict Content Security Policy before production launch.
- Before public launch, add CSRF protection, account-based authorization if multiple admins/users are needed, and automated tests.
