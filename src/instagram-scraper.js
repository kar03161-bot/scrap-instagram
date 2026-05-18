import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
// Stealth loads user-agent-override → user-preferences → user-data-dir via dynamic require;
// explicit imports keep Vercel/serverless bundles from omitting those packages.
import "puppeteer-extra-plugin-user-preferences";
import "puppeteer-extra-plugin-user-data-dir";
import { fileURLToPath } from "url";

puppeteer.use(StealthPlugin());

const IG_ORIGIN = "https://www.instagram.com";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, "../.puppeteer-profile");

/** 번들 Chrome이 없을 때 로컬 설치 Chrome 등으로 대체 */
function resolveChromeExecutablePath() {
  const fromEnv =
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || process.env.CHROME_PATH?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} raw */
export function parseCompactNumber(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().replace(/,/g, "");
  const multi = /^([\d.]+)\s*([KMB千万억])/i.exec(s);
  if (multi) {
    let n = parseFloat(multi[1]);
    const u = multi[2].toUpperCase();
    if (u === "K") n *= 1e3;
    else if (u === "M") n *= 1e6;
    else if (u === "B") n *= 1e9;
    else if (multi[2] === "万") n *= 1e4;
    else if (multi[2] === "千万") n *= 1e7;
    else if (multi[2] === "억") n *= 1e8;
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const digits = parseFloat(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(digits) ? Math.round(digits) : null;
}

/** @param {string} ogDescription */
export function parseFollowersFromOgDescription(ogDescription) {
  if (!ogDescription) return null;
  const m = ogDescription.match(
    /([\d,.]+(?:\.\d+)?)\s*([KMBkmb千万억]*)\s*Followers/i,
  );
  if (!m) return null;
  const numPart = m[1].replace(/,/g, "") + (m[2] ? m[2].toUpperCase() : "");
  return parseCompactNumber(numPart);
}

/** @param {string} text */
export function parseLikesCommentsFromText(text) {
  if (!text) return { likes: null, comments: null };
  let likes = null;
  let comments = null;

  const likeM =
    text.match(/([\d,.]+(?:\.\d+)?)\s*[KMBkmb千万억]*\s*likes?/i) ||
    text.match(/좋아요\s*([\d,.]+(?:\.\d+)?)\s*[KMBkmb千万억]*/i);
  if (likeM) likes = parseCompactNumber(likeM[1]);

  const commentM =
    text.match(/([\d,.]+(?:\.\d+)?)\s*[KMBkmb千万억]*\s*comments?/i) ||
    text.match(/댓글\s*([\d,.]+(?:\.\d+)?)\s*[KMBkmb千万억]*/i);
  if (commentM) comments = parseCompactNumber(commentM[1]);

  return { likes, comments };
}

async function dismissBlockingDialogs(page) {
  for (let i = 0; i < 4; i++) {
    try {
      const clicked = await page.evaluate(() => {
        const texts = ["Not Now", "나중에 하기", "Not now", "OK", "확인"];
        const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
        for (const b of buttons) {
          const t = (b.innerText || b.textContent || "").trim();
          if (texts.some((x) => t.includes(x))) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) await delay(400);
    } catch {
      /* ignore */
    }
    await delay(200);
  }
}

async function hasInstagramSession(page) {
  const cookies = await page.cookies(IG_ORIGIN);
  return cookies.some((cookie) => cookie.name === "sessionid" && cookie.value);
}

async function waitForManualLoginIfNeeded(page) {
  await page.waitForFunction(
    () => {
      const isLoginPage =
        location.pathname.includes("/accounts/login") || location.pathname.includes("/challenge");
      return !isLoginPage;
    },
    { timeout: 120000 },
  );
}

async function login(page, username, password, headless) {
  await page.goto(IG_ORIGIN, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await delay(800);
  await dismissBlockingDialogs(page);

  if (await hasInstagramSession(page)) return;

  await page.goto(`${IG_ORIGIN}/accounts/login/`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await delay(800);
  await dismissBlockingDialogs(page);

  const usernameInput = await page.$('input[name="username"]');
  if (!usernameInput) {
    // HEADLESS=false 상태에서는 사용자가 직접 로그인할 수 있도록 최대 2분 기다린다.
    await waitForManualLoginIfNeeded(page);
    await delay(1200);
    await dismissBlockingDialogs(page);
    if (await hasInstagramSession(page)) return;
    throw new Error(
      "로그인 입력칸을 찾지 못했습니다. HEADLESS=false로 실행한 뒤 열린 브라우저에서 수동 로그인 완료 후 다시 분석해 주세요.",
    );
  }

  await page.type('input[name="username"]', username, { delay: 20 });
  await page.type('input[name="password"]', password, { delay: 20 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);

  await delay(2500);
  await dismissBlockingDialogs(page);

  if (!(await hasInstagramSession(page))) {
    if (!headless) {
      await waitForManualLoginIfNeeded(page);
      await delay(1200);
      await dismissBlockingDialogs(page);
      if (await hasInstagramSession(page)) return;
    }
    throw new Error(
      "로그인에 실패했거나 추가 확인(2단계 인증·보안 확인)이 필요합니다. 브라우저에서 한 번 로그인해 보거나 IG_USERNAME/IG_PASSWORD를 확인하세요.",
    );
  }
}

async function getOgDescription(page) {
  return page
    .$eval('meta[property="og:description"]', (el) => el.getAttribute("content") || "")
    .catch(() => "");
}

function normalizeInstagramPostUrl(raw) {
  try {
    const url = raw.startsWith("http") ? new URL(raw) : new URL(raw, IG_ORIGIN);
    const path = url.pathname.replace(/\/$/, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 2 && (parts[0] === "p" || parts[0] === "reel")) {
      return `${IG_ORIGIN}${path}`;
    }
  } catch {
    /* skip invalid urls */
  }
  return null;
}

async function collectPostUrls(page) {
  const urls = new Set();

  for (let step = 0; step < 8 && urls.size < 10; step++) {
    const found = await page.evaluate(() => {
      const candidates = new Set();

      document.querySelectorAll("a[href]").forEach((a) => {
        const href = (/** @type {HTMLAnchorElement} */ (a)).getAttribute("href") || "";
        if (href.includes("/p/") || href.includes("/reel/")) candidates.add(href);
      });

      const html = document.documentElement.innerHTML.replace(/\\u002F/g, "/");
      for (const match of html.matchAll(
        /(?:https?:\/\/(?:www\.)?instagram\.com)?\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/g,
      )) {
        candidates.add(match[0]);
      }

      return [...candidates];
    });

    for (const href of found) {
      const normalized = normalizeInstagramPostUrl(href);
      if (normalized) urls.add(normalized);
    }

    if (urls.size >= 10) break;

    await page.evaluate(() => window.scrollBy(0, 900));
    await delay(650);
  }

  return [...urls].slice(0, 10);
}

async function getProfileAccessMessage(page) {
  const text = await page.evaluate(() => document.body?.innerText || "");
  if (/This Account is Private|비공개 계정/.test(text)) {
    return "비공개 계정이라 게시물 링크를 수집할 수 없습니다.";
  }
  if (/No Posts Yet|게시물 없음/.test(text)) {
    return "프로필에 공개 게시물이 없습니다.";
  }
  if (/Sorry, this page isn't available|페이지를 사용할 수 없습니다/.test(text)) {
    return "계정을 찾을 수 없거나 접근할 수 없는 프로필입니다.";
  }
  if (/Log in|로그인/.test(text) && !/Followers|팔로워|게시물/.test(text)) {
    return "로그인 세션이 풀려 프로필 게시물 영역을 볼 수 없습니다. HEADLESS=false로 다시 로그인해 주세요.";
  }
  return "프로필은 열렸지만 게시물 링크를 찾지 못했습니다. Instagram 화면 구조 변경 또는 일시적 차단일 수 있습니다.";
}

async function scrapeProfileSummary(page, handle) {
  const clean = handle.replace(/^@/, "").trim();
  const profileUrl = `${IG_ORIGIN}/${encodeURIComponent(clean)}/`;
  await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await delay(1200);

  const og = await getOgDescription(page);
  let followers = parseFollowersFromOgDescription(og);

  if (followers == null) {
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const fb = parseFollowersFromOgDescription(bodyText.replace(/\n/g, " "));
    followers = fb;
  }

  const postUrls = await collectPostUrls(page);
  const profileError = postUrls.length === 0 ? await getProfileAccessMessage(page) : null;

  const posts = [];
  for (let i = 0; i < postUrls.length; i++) {
    await delay(900 + Math.random() * 700);
    await page.goto(postUrls[i], { waitUntil: "networkidle2", timeout: 60000 });
    await delay(700);

    const desc = await getOgDescription(page);
    let { likes, comments } = parseLikesCommentsFromText(desc);

    if (likes == null || comments == null) {
      const blob = await page.evaluate(() => {
        const parts = [];
        document.querySelectorAll("span, li, section").forEach((el) => {
          const t = (el.innerText || "").trim();
          if (t.length > 0 && t.length < 200) parts.push(t);
        });
        return parts.join(" | ");
      });
      const fb = parseLikesCommentsFromText(blob);
      if (likes == null) likes = fb.likes;
      if (comments == null) comments = fb.comments;
    }

    posts.push({
      url: postUrls[i],
      likes,
      comments,
    });
  }

  return {
    username: clean,
    profileUrl,
    followers,
    metaOgDescription: og || null,
    posts,
    error: profileError,
  };
}

/**
 * @param {string[]} usernames
 * @param {{ igUsername: string; igPassword: string; headless?: boolean }} creds
 */
export async function analyzeInfluencers(usernames, creds) {
  const headless = creds.headless !== false;
  const executablePath = resolveChromeExecutablePath();

  const browser = await puppeteer.launch({
    headless,
    userDataDir: USER_DATA_DIR,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,900"],
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    await login(page, creds.igUsername, creds.igPassword, headless);

    const rows = [];

    const uniqueHandles = [...new Set(usernames.map((u) => u.replace(/^@/, "").trim()).filter(Boolean))];

    for (const h of uniqueHandles) {
      try {
        await delay(1500 + Math.random() * 1000);
        const row = await scrapeProfileSummary(page, h);
        rows.push(row);
      } catch (e) {
        rows.push({
          username: h.replace(/^@/, ""),
          profileUrl: `${IG_ORIGIN}/${encodeURIComponent(h)}/`,
          followers: null,
          metaOgDescription: null,
          posts: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return rows;
  } finally {
    await browser.close();
  }
}
