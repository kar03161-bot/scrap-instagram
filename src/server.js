import "dotenv/config";
import express from "express";
import path from "path";
import { createClient, createPool } from "@vercel/postgres";
import { fileURLToPath } from "url";
import { analyzeInfluencers } from "./instagram-scraper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const igUsername = process.env.IG_USERNAME?.trim();
const igPassword = process.env.IG_PASSWORD?.trim();
const igSessionId = process.env.IG_SESSIONID?.trim();
const headless = process.env.HEADLESS !== "false";
const databaseUrl =
  process.env.POSTGRES_URL?.trim() || process.env.POSTGRES_URL_NON_POOLING?.trim();
const hasDatabaseConfig = Boolean(databaseUrl);
let pooledDatabase;

async function dbQuery(strings, ...values) {
  if (!databaseUrl) {
    throw new Error(
      "Vercel DB 연결 정보(POSTGRES_URL 또는 POSTGRES_URL_NON_POOLING)가 설정되어 있지 않습니다.",
    );
  }

  if (databaseUrl.includes("-pooler.")) {
    pooledDatabase ||= createPool({ connectionString: databaseUrl });
    return pooledDatabase.sql(strings, ...values);
  }

  const client = createClient({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await client.sql(strings, ...values);
  } finally {
    await client.end();
  }
}

/** @param {unknown} reason */
function messageFromUnknown(reason) {
  if (reason instanceof Error) {
    return reason.message || reason.name || "오류가 발생했습니다.";
  }
  if (reason == null) {
    return "알 수 없는 오류가 발생했습니다.";
  }
  if (typeof reason === "string") {
    return reason;
  }
  if (typeof reason === "object") {
    const obj = /** @type {Record<string, unknown>} */ (reason);
    const msg = obj.message;
    if (typeof msg === "string" && msg.length > 0) {
      return msg;
    }
    const err = obj.error;
    if (typeof err === "string" && err.length > 0) {
      return err;
    }
    try {
      const s = JSON.stringify(reason);
      if (s && s !== "{}") return s;
    } catch {
      /* ignore */
    }
  }
  try {
    return String(reason);
  } catch {
    return "알 수 없는 오류가 발생했습니다.";
  }
}

function normalizeUsernames(usernames) {
  if (Array.isArray(usernames)) {
    return usernames.map((u) => String(u).replace(/^@/, "").trim()).filter(Boolean);
  }

  if (typeof usernames === "string") {
    return usernames
      .split(/[\n,]+/)
      .map((u) => u.replace(/^@/, "").trim())
      .filter(Boolean);
  }

  return [];
}

function avg(values) {
  const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (nums.length === 0) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function calcErPercent(row) {
  if (!row.followers || row.followers <= 0) return null;
  const posts = row.posts || [];
  const avgLikes = avg(posts.map((p) => p.likes));
  const avgComments = avg(posts.map((p) => p.comments));
  if (avgLikes == null || avgComments == null) return null;
  return ((avgLikes + avgComments) / row.followers) * 100;
}

function gradeFor(erPercent) {
  if (erPercent == null) return "-";
  if (erPercent >= 5) return "S";
  if (erPercent >= 3) return "A";
  if (erPercent >= 1) return "B";
  if (erPercent >= 0.5) return "C";
  return "D";
}

function enrichInfluencerResult(row) {
  const posts = row.posts || [];
  const likes = avg(posts.map((post) => post.likes));
  const comments = avg(posts.map((post) => post.comments));
  const er = calcErPercent(row);

  return {
    ...row,
    likes,
    comments,
    er,
    grade: gradeFor(er),
  };
}

async function ensureInfluencerTable() {
  await dbQuery`
    CREATE TABLE IF NOT EXISTS influencer (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      followers INTEGER,
      likes NUMERIC,
      comments NUMERIC,
      er NUMERIC,
      grade TEXT,
      analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function findExistingUsernames(usernames) {
  if (!hasDatabaseConfig) {
    return [];
  }
  await ensureInfluencerTable();
  const clean = [...new Set(usernames.map((u) => u.toLowerCase()))];
  if (clean.length === 0) return [];

  const existing = [];
  for (const username of clean) {
    const { rows } = await dbQuery`
      SELECT username
      FROM influencer
      WHERE LOWER(username) = ${username}
      LIMIT 1
    `;
    if (rows[0]?.username) existing.push(rows[0].username);
  }

  return existing.sort((a, b) => a.localeCompare(b));
}

async function saveInfluencerResults(results) {
  const enriched = results.map(enrichInfluencerResult);
  if (!hasDatabaseConfig) {
    return enriched;
  }

  await ensureInfluencerTable();

  for (const row of enriched) {
    await dbQuery`
      INSERT INTO influencer (username, followers, likes, comments, er, grade, analyzed_at)
      VALUES (
        ${row.username},
        ${row.followers},
        ${row.likes},
        ${row.comments},
        ${row.er},
        ${row.grade},
        NOW()
      )
      ON CONFLICT (username) DO UPDATE SET
        followers = EXCLUDED.followers,
        likes = EXCLUDED.likes,
        comments = EXCLUDED.comments,
        er = EXCLUDED.er,
        grade = EXCLUDED.grade,
        analyzed_at = EXCLUDED.analyzed_at
    `;
  }

  return enriched;
}

app.use(express.json({ limit: "512kb" }));
// 로컬: public 정적 파일. Vercel 프로덕션에서는 public/** 가 CDN으로 제공되며 express.static 은 무시됨.
app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasCredentials: Boolean(igSessionId || (igUsername && igPassword)),
    hasDatabase: hasDatabaseConfig,
  });
});

app.get("/api/influencers", async (_req, res) => {
  try {
    if (!hasDatabaseConfig) {
      return res.json({ results: [] });
    }
    await ensureInfluencerTable();
    const { rows } = await dbQuery`
      SELECT username, followers, likes, comments, er, grade, analyzed_at
      FROM influencer
      ORDER BY analyzed_at DESC
    `;

    res.json({
      results: rows.map((row) => ({
        username: row.username,
        followers: row.followers,
        likes: row.likes == null ? null : Number(row.likes),
        comments: row.comments == null ? null : Number(row.comments),
        er: row.er == null ? null : Number(row.er),
        grade: row.grade,
        analyzedAt: row.analyzed_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: messageFromUnknown(err) });
  }
});

app.post("/api/influencers/check", async (req, res) => {
  const list = normalizeUsernames(req.body?.usernames);
  if (list.length === 0) {
    return res.status(400).json({ error: "조회할 인스타그램 아이디를 하나 이상 입력해 주세요." });
  }

  try {
    const existing = await findExistingUsernames(list);
    res.json({ existing });
  } catch (err) {
    res.status(500).json({ error: messageFromUnknown(err) });
  }
});

app.post("/api/analyze", async (req, res) => {
  if (!igSessionId && (!igUsername || !igPassword)) {
    return res.status(400).json({
      error:
        ".env에 IG_SESSIONID 또는 IG_USERNAME/IG_PASSWORD가 설정되어 있지 않습니다. .env.example을 참고해 주세요.",
    });
  }

  const { usernames } = req.body || {};
  const list = normalizeUsernames(usernames);

  if (list.length === 0) {
    return res.status(400).json({ error: "분석할 인스타그램 아이디를 하나 이상 입력해 주세요." });
  }

  if (list.length > 25) {
    return res.status(400).json({ error: "한 번에 최대 25개 계정까지 분석할 수 있습니다." });
  }

  try {
    const existing = await findExistingUsernames(list);
    if (existing.length > 0) {
      return res.status(409).json({ error: "이미 분석한 계정입니다", existing });
    }

    const results = await analyzeInfluencers(list, {
      igUsername,
      igPassword,
      igSessionId,
      headless,
    });
    const savedResults = await saveInfluencerResults(results);
    res.json({ results: savedResults });
  } catch (err) {
    res.status(500).json({ error: messageFromUnknown(err) });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
    if (!igUsername || !igPassword) {
      console.warn("[경고] IG_USERNAME / IG_PASSWORD 가 .env에 없습니다.");
    }
  });
}

export default app;
