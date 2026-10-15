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

// ---------- BASIC SECURITY ----------

app.disable("x-powered-by");

// Required by many hosted platforms when using secure session cookies.
if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(
  helmet({
    // The existing frontend uses inline CSS/JavaScript.
    // Re-enable and configure CSP if the frontend is updated.
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false
  })
);

// ---------- SESSION CONFIGURATION ----------

const sessionSecret = process.env.SESSION_SECRET;

if (isProduction && !sessionSecret) {
  console.error("SESSION_SECRET is required in production.");
  process.exit(1);
}

app.use(
  session({
    name: "iceman.sid",
    secret: sessionSecret || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 2 * 60 * 60 * 1000
    }
  })
);

// NOTE: express-session's default MemoryStore is not suitable
// for production deployments with multiple instances or restarts.

// ---------- WEBSITE FILES ----------

const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(path.join(publicDir, "index.html"))) {
  console.error("Missing public/index.html. Check your project folders.");
  process.exit(1);
}

fs.mkdirSync(uploadDir, { recursive: true });

app.use(
  express.static(publicDir, {
    index: "index.html",
    maxAge: isProduction ? "1h" : 0
  })
);

// ---------- GEMINI AI ----------

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

app.post("/api/ai", aiLimiter, async (req, res) => {
  const rawPrompt = req.body?.prompt ?? req.body?.question;
  const prompt =
    typeof rawPrompt === "string" ? rawPrompt.trim() : "";

  if (!prompt) {
    return res.status(400).json({
      error: "Please enter a question."
    });
  }

  if (prompt.length > 8000) {
    return res.status(413).json({
      error: "Question is too long (maximum 8000 characters)."
    });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    return res.status(503).json({
      error: "Gemini is not configured. Set GEMINI_API_KEY in your hosting environment."
    });
  }

  const model = (
    process.env.GEMINI_MODEL || "gemini-2.5-flash"
  ).trim();

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(model)}:generateContent`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are ICEMAN AI, a friendly programming tutor. " +
                "Explain concepts clearly, provide safe and educational " +
                "code examples, and help debug code. Never claim code " +
                "was executed unless it was. Keep answers practical."
            }
          ]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 2048
        }
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // Keep API diagnostics on the server; never log the API key.
      console.error(
        "Gemini API error:",
        JSON.stringify({
          status: response.status,
          model,
          reason: data?.error?.status || "Unknown",
          message: data?.error?.message || "No details returned"
        })
      );

      return res.status(502).json({
        error:
          "Gemini request failed. Check your API key, model availability, quota, and server logs."
      });
    }

    const answer = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();

    if (!answer) {
      return res.status(502).json({
        error: "Gemini returned an empty response. Please try again."
      });
    }

    return res.json({ answer });
  } catch (err) {
    console.error(
      "Gemini request error:",
      err?.name || "Error",
      err?.message || "Unknown error"
    );

    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return res.status(504).json({
        error: "Gemini timed out. Please try again."
      });
    }

    return res.status(502).json({
      error: "Could not connect to Gemini. Please try again."
    });
  }
});

// ---------- ADMIN AUTHENTICATION ----------

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) {
    return res.status(401).json({
      error: "Admin login required."
    });
  }

  return next();
}

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

app.post("/api/admin/login", adminLoginLimiter, (req, res, next) => {
  const expected = process.env.ADMIN_PASSWORD;
  const supplied =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (!expected) {
    return res.status(503).json({
      error: "Admin login is not configured. Set ADMIN_PASSWORD."
    });
  }

  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);

  const matches =
    suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);

  if (!matches) {
    return res.status(401).json({
      error: "Incorrect admin password."
    });
  }

  // Regenerate the session after authentication.
  req.session.regenerate(err => {
    if (err) return next(err);

    req.session.isAdmin = true;

    req.session.save(saveErr => {
      if (saveErr) return next(saveErr);

      return res.json({
        message: "Admin login successful."
      });
    });
  });
});

app.post("/api/admin/logout", requireAdmin, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);

    res.clearCookie("iceman.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction
    });

    return res.json({ message: "Logged out." });
  });
});

app.get("/api/admin/status", (req, res) => {
  return res.json({
    authenticated: Boolean(req.session?.isAdmin)
  });
});

// ---------- ADMIN APK UPLOAD ----------

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },

  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    cb(
      null,
      `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1
  },

  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== ".apk") {
      return cb(new Error("Only .apk files are allowed."));
    }

    return cb(null, true);
  }
});

app.post("/api/admin/apk", requireAdmin, (req, res) => {
  upload.single("apk")(req, res, err => {
    if (err) {
      return res.status(400).json({
        error: err.message || "Upload failed."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Choose an APK file to upload."
      });
    }

    return res.status(201).json({
      message: "APK uploaded.",
      filename: req.file.filename,
      size: req.file.size
    });
  });
});

// ---------- HEALTH CHECK ----------

app.get("/api/health", (_req, res) => {
  return res.json({
    status: "ok",
    name: "ICEMAN CODE LEARN",
    node: process.version
  });
});

// ---------- UNKNOWN API ROUTES ----------

app.use("/api", (_req, res) => {
  return res.status(404).json({
    error: "API endpoint not found."
  });
});

// ---------- FRONTEND FALLBACK ----------

// Serve index.html for website navigation only.
// Static files such as CSS and JavaScript are handled above.
app.use((req, res, next) => {
  if (req.method !== "GET") {
    return next();
  }

  return res.sendFile(
    path.join(publicDir, "index.html"),
    err => {
      if (err) next(err);
    }
  );
});

// ---------- ERROR HANDLER ----------

app.use((err, _req, res, _next) => {
  console.error(
    "Server error:",
    err?.message || "Unknown error."
  );

  if (res.headersSent) return;

  return res.status(500).json({
    error: "Unexpected server error."
  });
});

// ---------- START SERVER ----------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ICEMAN CODE LEARN running on port ${PORT}`);
});
