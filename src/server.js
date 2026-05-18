import "dotenv/config";
import fs from "fs";
import express from "express";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";
import { analyzeInfluencers } from "./instagram-scraper.js";

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

/** Vercel UI에 붙은 따옴표까지 복사된 경우 제거 */
function normalizeEnvSecret(value) {
  if (value == null) return "";
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const PORT = Number(process.env.PORT) || 3000;

const igUsername = normalizeEnvSecret(process.env.IG_USERNAME);
const igPassword = normalizeEnvSecret(process.env.IG_PASSWORD);

/** 기본 true(헤드리스). 아래 값만 창 모드(false). 정규식 `|` 분기로는 `no` 가 부분 문자열로도 매칭되는 문제가 있어 배열로만 판별 */
function readHeadlessDefaultTrue() {
  const raw = process.env.HEADLESS;
  if (raw == null || String(raw).trim() === "") return true;
  const v = String(raw).trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no" || v === "off" || v === "n") return false;
  return true;
}
const headless = readHeadlessDefaultTrue();
const igCookiesPath = path.resolve(
  process.cwd(),
  (process.env.IG_COOKIES_PATH || ".instagram-cookies.json").trim(),
);

function hasReadableInstagramCookieFile() {
  try {
    if (!fs.existsSync(igCookiesPath) || fs.statSync(igCookiesPath).size < 12) {
      return false;
    }
    const parsed = JSON.parse(fs.readFileSync(igCookiesPath, "utf8"));
    return (
      Array.isArray(parsed) &&
      parsed.some((c) => c && c.name === "sessionid" && String(c.value).length > 0)
    );
  } catch {
    return false;
  }
}

/** 풀링 URL 우선 (Vercel/Neon 권장). neon() HTTP는 호스트 매핑 불일치 시 resource-not-found(404)가 날 수 있어 TCP(pg) 사용. */
const databaseUrl =
  process.env.POSTGRES_URL?.trim() || process.env.POSTGRES_URL_NON_POOLING?.trim();

/**
 * pg v8+ 경고 제거: require/prefer/verify-ca 가 곧 libpq 의미로 바뀔 예정.
 * 지금처럼 강한 검증을 유지하려면 연결 문자열에 sslmode=verify-full 을 명시한다.
 * @param {string | undefined} url
 */
function postgresUrlWithExplicitVerifyFull(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    const mode = (u.searchParams.get("sslmode") || "").toLowerCase();
    if (["prefer", "require", "verify-ca"].includes(mode)) {
      u.searchParams.set("sslmode", "verify-full");
    }
    return u.toString();
  } catch {
    return url;
  }
}

const hasDatabaseConfig = Boolean(databaseUrl);
/** @type {pg.Pool | undefined} */
let dbPool;

/** @param {TemplateStringsArray} strings @param {unknown[]} values */
function templateToParameterizedSql(strings, values) {
  let text = strings[0] ?? "";
  for (let i = 1; i < strings.length; i++) {
    text += `$${i}${strings[i] ?? ""}`;
  }
  return [text, values];
}

async function dbQuery(strings, ...values) {
  if (!databaseUrl) {
    throw new Error(
      "Vercel DB 연결 정보(POSTGRES_URL 또는 POSTGRES_URL_NON_POOLING)가 설정되어 있지 않습니다.",
    );
  }

  const maxEnv = Number(process.env.PG_POOL_MAX);
  const poolMax =
    Number.isFinite(maxEnv) && maxEnv > 0 ? Math.min(10, maxEnv) : 5;

  dbPool ||= new Pool({
    connectionString: postgresUrlWithExplicitVerifyFull(databaseUrl) ?? databaseUrl,
    max: poolMax,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 20_000,
  });

  const [text, params] = templateToParameterizedSql(strings, values);
  return dbPool.query(text, params);
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

function calcReelErPercent(row) {
  if (!row.followers || row.followers <= 0) return null;
  const reels = row.reels || [];
  const reelErValues = reels.map((reel) => {
    if (typeof reel.er === "number" && !Number.isNaN(reel.er)) return reel.er;
    if (typeof reel.views === "number" && !Number.isNaN(reel.views)) {
      return (reel.views / row.followers) * 100;
    }
    return null;
  });
  return avg(reelErValues);
}

function followerSegmentFor(followers) {
  if (followers == null || followers <= 0) return null;
  if (followers < 10_000) return { label: "나노", s: 8, a: 5, b: 3 };
  if (followers < 50_000) return { label: "마이크로", s: 6, a: 4, b: 2.5 };
  if (followers < 100_000) return { label: "미드티어", s: 4.5, a: 3, b: 1.8 };
  if (followers < 500_000) return { label: "매크로", s: 3.5, a: 2, b: 1.2 };
  return { label: "메가", s: 2.5, a: 1.5, b: 0.8 };
}

function gradeFor(erPercent, followers) {
  const segment = followerSegmentFor(followers);
  if (erPercent == null || !segment) return "-";
  if (erPercent >= segment.s) return "S";
  if (erPercent >= segment.a) return "A";
  if (erPercent >= segment.b) return "B";
  return "C";
}

function enrichInfluencerResult(row) {
  const posts = row.posts || [];
  const likes = avg(posts.map((post) => post.likes));
  const comments = avg(posts.map((post) => post.comments));
  const er = calcErPercent(row);
  const reelEr = calcReelErPercent(row);

  return {
    ...row,
    likes,
    comments,
    er,
    reelEr,
    grade: gradeFor(er, row.followers),
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
      reel_er NUMERIC,
      grade TEXT,
      analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await dbQuery`
    ALTER TABLE influencer
    ADD COLUMN IF NOT EXISTS reel_er NUMERIC
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
      INSERT INTO influencer (username, followers, likes, comments, er, reel_er, grade, analyzed_at)
      VALUES (
        ${row.username},
        ${row.followers},
        ${row.likes},
        ${row.comments},
        ${row.er},
        ${row.reelEr},
        ${row.grade},
        NOW()
      )
      ON CONFLICT (username) DO UPDATE SET
        followers = EXCLUDED.followers,
        likes = EXCLUDED.likes,
        comments = EXCLUDED.comments,
        er = EXCLUDED.er,
        reel_er = EXCLUDED.reel_er,
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
    hasCredentials:
      hasReadableInstagramCookieFile() ||
      Boolean(igUsername && igPassword) ||
      (!headless && !process.env.VERCEL),
    hasSavedInstagramCookies: hasReadableInstagramCookieFile(),
    hasPasswordCredentials: Boolean(igUsername && igPassword),
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
      SELECT username, followers, likes, comments, er, reel_er, grade, analyzed_at
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
        reelEr: row.reel_er == null ? null : Number(row.reel_er),
        grade: gradeFor(row.er == null ? null : Number(row.er), row.followers),
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
  const canHeadlessRun =
    hasReadableInstagramCookieFile() || Boolean(igUsername && igPassword);
  console.log("[api/analyze] 요청 수신", {
    headlessEffective: headless,
    headlessEnvRaw: process.env.HEADLESS,
    canHeadlessRun,
    hasReadableCookieFile: hasReadableInstagramCookieFile(),
    hasIgCredentials: Boolean(igUsername && igPassword),
    hasDatabase: hasDatabaseConfig,
  });
  if (headless && !canHeadlessRun) {
    console.log("[api/analyze] 분기: 400 헤드리스 불가(쿠키·비번 없음)");
    return res.status(400).json({
      error:
        "헤드리스 모드에서는 `.instagram-cookies.json`(IG_COOKIES_PATH로 경로 변경 가능)에 저장된 쿠키가 있거나, IG_USERNAME·IG_PASSWORD가 필요합니다. " +
        "처음 한 번은 HEADLESS=false로 서버를 실행한 뒤 브라우저에서 Instagram에 수동 로그인하면 쿠키 파일이 저장됩니다.",
    });
  }

  const { usernames } = req.body || {};
  const list = normalizeUsernames(usernames);

  if (list.length === 0) {
    console.log("[api/analyze] 분기: 400 사용자명 없음");
    return res.status(400).json({ error: "분석할 인스타그램 아이디를 하나 이상 입력해 주세요." });
  }

  if (list.length > 25) {
    console.log("[api/analyze] 분기: 400 너무 많은 계정");
    return res.status(400).json({ error: "한 번에 최대 25개 계정까지 분석할 수 있습니다." });
  }

  try {
    console.log("[api/analyze] DB 중복 조회 시작", { usernames: list });
    const existing = await findExistingUsernames(list);
    console.log("[api/analyze] DB 중복 조회 완료", { existing });
    if (existing.length > 0) {
      console.log("[api/analyze] 분기: 409 이미 분석됨");
      return res.status(409).json({ error: "이미 분석한 계정입니다", existing });
    }

    console.log("[api/analyze] analyzeInfluencers 호출", {
      count: list.length,
      cookiePath: igCookiesPath,
    });
    const results = await analyzeInfluencers(list, {
      igUsername,
      igPassword,
      headless,
      cookiePath: igCookiesPath,
    });
    console.log("[api/analyze] analyzeInfluencers 반환", {
      rows: results?.length,
    });

    console.log("[api/analyze] saveInfluencerResults 호출");
    const savedResults = await saveInfluencerResults(results);
    console.log("[api/analyze] saveInfluencerResults 완료 → 200");
    res.json({ results: savedResults });
  } catch (err) {
    console.error("[api/analyze] 500 원인", err);
    res.status(500).json({ error: messageFromUnknown(err) });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
    console.log(
      `[server] HEADLESS 환경변수(raw)=${JSON.stringify(process.env.HEADLESS)} → effective headless=${headless} (Chrome 창=${!headless})`,
    );
    if (headless) {
      console.warn(
        "[안내] 로그인용 Chrome 창을 보려면 .env에 HEADLESS=false 로 저장한 뒤 서버를 다시 시작하세요.",
      );
    } else {
      console.log("[안내] Chrome 창이 열립니다. Instagram 보안·동의 화면은 브라우저에서 처리할 수 있습니다.");
    }
    if (!hasReadableInstagramCookieFile() && (!igUsername || !igPassword) && headless) {
      console.warn(
        "[경고] 저장된 Instagram 쿠키가 없고 IG_USERNAME도 없습니다. HEADLESS=false로 한 번 로그인해 `.instagram-cookies.json`을 만드세요.",
      );
    }
  });
}

export default app;
