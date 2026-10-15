import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
app.use(helmet({
  // The single-file frontend uses inline styles/scripts. Keep the other Helmet protections.
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false }));

const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && !sessionSecret) {
  console.error("SESSION_SECRET is required in production.");
  process.exit(1);
}
app.use(session({
  name: "iceman.sid",
  secret: sessionSecret || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 2 * 60 * 60 * 1000 }
}));

const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
app.use(express.static(publicDir, { index: "index.html", maxAge: isProduction ? "1h" : 0 }));

const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });
app.post("/api/ai", aiLimiter, async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: "Please enter a question." });
  if (prompt.length > 8000) return res.status(413).json({ error: "Question is too long (maximum 8000 characters)." });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Gemini is not configured yet. Add GEMINI_API_KEY in Render environment variables." });

  try {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "You are ICEMAN AI, a friendly programming tutor. Explain concepts clearly, provide safe and educational code examples, and help debug code. Never claim code was executed unless it was. Keep answers practical." }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 2048 }
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Gemini API returned status", response.status, data?.error?.message || "");
      return res.status(502).json({ error: "Gemini request failed. Check the API key, model access, and Render logs." });
    }
    const answer = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    if (!answer) return res.status(502).json({ error: "Gemini returned an empty response. Please try again." });
    res.json({ answer });
  } catch (err) {
    console.error("Gemini request error:", err.message);
    res.status(504).json({ error: "Gemini did not respond in time. Please try again." });
  }
});

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) return res.status(401).json({ error: "Admin login required." });
  next();
}
app.post("/api/admin/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-7", legacyHeaders: false }), (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  const supplied = typeof req.body?.password === "string" ? req.body.password : "";
  if (!expected) return res.status(503).json({ error: "Admin login is not configured. Set ADMIN_PASSWORD in Render." });
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Incorrect admin password." });
  req.session.isAdmin = true;
  res.json({ message: "Admin login successful." });
});
app.post("/api/admin/logout", requireAdmin, (req, res) => req.session.destroy(() => res.json({ message: "Logged out." })));
app.get("/api/admin/status", (req, res) => res.json({ authenticated: Boolean(req.session?.isAdmin) }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // APK files only; this endpoint is admin-protected.
    if (path.extname(file.originalname).toLowerCase() !== ".apk") return cb(new Error("Only .apk files are allowed."));
    cb(null, true);
  }
});
app.post("/api/admin/apk", requireAdmin, (req, res) => {
  upload.single("apk")(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "Choose an APK file to upload." });
    res.status(201).json({ message: "APK uploaded.", filename: req.file.filename, size: req.file.size });
  });
});

app.get("/api/health", (_req, res) => res.json({ status: "ok", name: "ICEMAN CODE LEARN", node: process.version }));
app.get("/{*splat}", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.use((err, _req, res, _next) => {
  console.error("Unhandled server error:", err.message);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, "0.0.0.0", () => console.log(`ICEMAN CODE LEARN running on port ${PORT}`));
