import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { analyzeInfluencers } from "./instagram-scraper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const igUsername = process.env.IG_USERNAME?.trim();
const igPassword = process.env.IG_PASSWORD?.trim();
const headless = process.env.HEADLESS !== "false";

app.use(express.json({ limit: "512kb" }));
// 로컬: public 정적 파일. Vercel 프로덕션에서는 public/** 가 CDN으로 제공되며 express.static 은 무시됨.
app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasCredentials: Boolean(igUsername && igPassword) });
});

app.post("/api/analyze", async (req, res) => {
  if (!igUsername || !igPassword) {
    return res.status(400).json({
      error:
        ".env에 IG_USERNAME, IG_PASSWORD가 설정되어 있지 않습니다. .env.example을 참고해 주세요.",
    });
  }

  const { usernames } = req.body || {};
  let list = [];

  if (Array.isArray(usernames)) {
    list = usernames.map((u) => String(u).trim()).filter(Boolean);
  } else if (typeof usernames === "string") {
    list = usernames
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
  }

  if (list.length === 0) {
    return res.status(400).json({ error: "분석할 인스타그램 아이디를 하나 이상 입력해 주세요." });
  }

  if (list.length > 25) {
    return res.status(400).json({ error: "한 번에 최대 25개 계정까지 분석할 수 있습니다." });
  }

  try {
    const results = await analyzeInfluencers(list, {
      igUsername,
      igPassword,
      headless,
    });
    res.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
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
