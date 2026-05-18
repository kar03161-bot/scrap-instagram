import fs from "fs";
import { createRequire } from "module";
import path from "path";
import chromium from "@sparticuz/chromium";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
// Stealth loads user-agent-override → user-preferences → user-data-dir via dynamic require;
// explicit imports keep Vercel/serverless bundles from omitting those packages.
import "puppeteer-extra-plugin-user-preferences";
import "puppeteer-extra-plugin-user-data-dir";
import vanillaPuppeteer from "puppeteer-core";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);

/**
 * Sparticuz는 import.meta.url 기준으로 bin을 찾는데, Vercel 번들 시 경로가 깨질 수 있어
 * 실제 설치 위치 기준으로 bin 디렉터리를 찾는다.
 * @returns {string | undefined}
 */
function resolveSparticuzChromiumBinDir() {
  const fromEnv = process.env.SPARTICUZ_CHROMIUM_BIN?.trim();
  if (fromEnv && fs.existsSync(path.join(fromEnv, "chromium.br"))) {
    return path.resolve(fromEnv);
  }

  try {
    if (typeof import.meta.resolve === "function") {
      const resolved = fileURLToPath(import.meta.resolve("@sparticuz/chromium"));
      const binDir = path.normalize(path.join(path.dirname(resolved), "..", "..", "bin"));
      if (fs.existsSync(path.join(binDir, "chromium.br"))) return binDir;
    }
  } catch {
    /* Node 18 또는 해석 실패 */
  }

  try {
    const resolved = require.resolve("@sparticuz/chromium");
    const binDir = path.normalize(path.join(path.dirname(resolved), "..", "..", "bin"));
    if (fs.existsSync(path.join(binDir, "chromium.br"))) return binDir;
  } catch {
    /* ignore */
  }

  const cwdBin = path.join(process.cwd(), "node_modules/@sparticuz/chromium/bin");
  if (fs.existsSync(path.join(cwdBin, "chromium.br"))) {
    return path.normalize(cwdBin);
  }

  return undefined;
}

const puppeteer = addExtra(vanillaPuppeteer);
puppeteer.use(StealthPlugin());

/** @param {unknown} reason */
function errorMessageFromUnknown(reason) {
  if (reason instanceof Error) {
    return reason.message || reason.name || String(reason);
  }
  if (reason == null) {
    return "";
  }
  if (typeof reason === "string") {
    return reason;
  }
  if (typeof reason === "object") {
    const msg = /** @type {{ message?: unknown }} */ (reason).message;
    if (typeof msg === "string" && msg.length > 0) {
      return msg;
    }
    try {
      const s = JSON.stringify(reason);
      if (s && s !== "{}") return s;
    } catch {
      /* ignore */
    }
  }
  return String(reason);
}

const IG_ORIGIN = "https://www.instagram.com";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, "../.puppeteer-profile");

/** www / apex 모두에서 세션 쿠키 조회 */
async function getInstagramCookiesJar(page) {
  const sets = await Promise.all([
    page.cookies(IG_ORIGIN).catch(() => []),
    page.cookies("https://instagram.com").catch(() => []),
  ]);
  const byKey = new Map();
  for (const c of sets.flat()) {
    byKey.set(`${c.name}|${c.domain}|${c.path}`, c);
  }
  return [...byKey.values()];
}

/** @param {string} path */
function instagramPathStillInAuthFlow(path) {
  const p = path || "";
  return (
    p.includes("/accounts/login") ||
    p.includes("/challenge") ||
    p.includes("/checkpoint") ||
    p.includes("/two_factor") ||
    p.includes("/accounts/onetap") ||
    p.includes("/accounts/signup") ||
    p.includes("/accounts/account_recovery") ||
    p.includes("/accounts/password") ||
    p.includes("/consent") ||
    /\/oauth\//i.test(p)
  );
}

/**
 * DOM에서 로그인 폼이 “실제로 보이는지”만 로그아웃 판정에 사용 (숨은 input 오탐 방지)
 */
async function pageShowsVisibleLoginForm(page) {
  return page.evaluate(() => {
    const visible = (/** @type {Element | null} */ el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    };
    const u = document.querySelector('input[name="username"]');
    const pw = document.querySelector('input[name="password"]');
    return visible(u) && visible(pw);
  });
}

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

  if (process.platform === "linux") {
    const candidates = [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

function shouldUseSparticuzChromium() {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.AWS_EXECUTION_ENV,
  );
}

/**
 * @param {{ headless?: boolean }} creds
 * @returns {Promise<{ launchOpts: object; loginHeadless: boolean }>}
 */
async function buildLaunchOptions(creds) {
  const useSparticuz = shouldUseSparticuzChromium();
  console.log("[instagram-scraper] buildLaunchOptions", {
    useSparticuzChromium: useSparticuz,
    credsHeadless: creds.headless,
  });
  if (useSparticuz) {
    chromium.setGraphicsMode = false;
    const chromiumBinDir = resolveSparticuzChromiumBinDir();
    if (!chromiumBinDir) {
      throw new Error(
        "@sparticuz/chromium의 bin( chromium.br 등)을 찾을 수 없습니다. Vercel 배포 시 vercel.json의 includeFiles에 node_modules/@sparticuz/chromium/bin/** 가 포함되는지, " +
          "또는 환경 변수 SPARTICUZ_CHROMIUM_BIN에 brotli 파일이 있는 디렉터리 절대 경로를 지정해 보세요.",
      );
    }
    const defaultViewport = {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      hasTouch: false,
      isLandscape: true,
      isMobile: false,
    };
    return {
      loginHeadless: true,
      launchOpts: {
        args: await vanillaPuppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
        defaultViewport,
        executablePath: await chromium.executablePath(chromiumBinDir),
        headless: "shell",
        userDataDir: path.join("/tmp", "ig-puppeteer-profile"),
      },
    };
  }

  const executablePath = resolveChromeExecutablePath();
  if (!executablePath) {
    throw new Error(
      "Chrome 실행 파일을 찾을 수 없습니다. Google Chrome을 설치하거나 CHROME_PATH / PUPPETEER_EXECUTABLE_PATH를 설정한 뒤 다시 시도해 주세요. (로컬에서 npm run install-browser 실행 후 안내 경로를 환경 변수로 지정할 수 있습니다.)",
    );
  }
  const headless = creds.headless === false ? false : true;
  console.log("[instagram-scraper] buildLaunchOptions → 로컬 Chrome", {
    executablePath,
    loginHeadless: headless,
  });
  return {
    loginHeadless: headless,
    launchOpts: {
      headless,
      userDataDir: USER_DATA_DIR,
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,900"],
      defaultViewport: { width: 1280, height: 900 },
    },
  };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} raw */
export function parseCompactNumber(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().replace(/,/g, "");
  const multi = /^([\d.]+)\s*(K|M|B|천만|千万|천|만|万|억)/i.exec(s);
  if (multi) {
    let n = parseFloat(multi[1]);
    const u = multi[2].toUpperCase();
    if (u === "K") n *= 1e3;
    else if (u === "M") n *= 1e6;
    else if (u === "B") n *= 1e9;
    else if (multi[2] === "천") n *= 1e3;
    else if (multi[2] === "만" || multi[2] === "万") n *= 1e4;
    else if (multi[2] === "천만" || multi[2] === "千万") n *= 1e7;
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
    text.match(/([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?\s*likes?/i) ||
    text.match(/좋아요\s*([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?/i);
  if (likeM) likes = parseCompactNumber(`${likeM[1]}${likeM[2] || ""}`);

  const commentM =
    text.match(/([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?\s*comments?/i) ||
    text.match(/댓글\s*([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?/i);
  if (commentM) comments = parseCompactNumber(`${commentM[1]}${commentM[2] || ""}`);

  return { likes, comments };
}

/** @param {string} text */
export function parseViewsFromText(text) {
  if (!text) return null;
  const patterns = [
    /([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?\s*views?\b/i,
    /views?\s*([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?/i,
    /조회수\s*([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?\s*(?:회)?/i,
    /([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?\s*(?:회)?\s*조회/i,
    /재생\s*([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?\s*(?:회)?/i,
    /([\d,.]+(?:\.\d+)?)\s*(K|M|B|k|m|b|천만|千万|천|만|万|억)?\s*(?:회)?\s*재생/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return parseCompactNumber(`${match[1]}${match[2] || ""}`);
    }
  }

  return null;
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

/**
 * Puppeteer에 sessionid 쿠키가 있어도, Instagram 서버가 IP/환경 불일치로 로그아웃 UI를 주는 경우가 있다.
 * 특히 집/localhost에서 만든 sessionid를 Vercel(데이터센터 IP)에서 쓰면 흔함.
 */
async function instagramUiShowsLoggedOut(page) {
  if (await pageShowsVisibleLoginForm(page)) return true;

  return page.evaluate(() => {
    const p = location.pathname || "";

    /** 로그인된 홈·피드에서 흔한 요소(우선 확인 — 아래 “로그아웃” 휴리스틱 오탐 방지) */
    const looksLoggedIn =
      !!document.querySelector("main article") ||
      !!document.querySelector('[role="main"] article') ||
      !!document.querySelector('a[href*="/direct/inbox"]') ||
      !!document.querySelector(
        '[aria-label="Home"], [aria-label="홈"], svg[aria-label="Home"], svg[aria-label="홈"]',
      ) ||
      !!document.querySelector(
        '[aria-label="New post" i], [aria-label="새 게시물" i], [aria-label="만들기" i], [aria-label="Create" i]',
      );
    if (looksLoggedIn) return false;

    if (p.includes("/accounts/login") || p.includes("/challenge")) return true;
    const html = document.documentElement.innerHTML || "";
    // `logged_out_` 는 빌드된 스크립트에도 들어가 오탐이 많아 제외. FelidaeLoggedOutSessionHint 만 유지.
    if (/FelidaeLoggedOutSessionHint/i.test(html)) return true;

    if (p === "/" || p === "") {
      const hasHome =
        document.querySelector('[aria-label="Home"]') ||
        document.querySelector("svg[aria-label='Home']") ||
        document.querySelector("svg[aria-label='홈']") ||
        document.querySelector('a[href*="/direct/inbox"]');
      if (!hasHome) {
        const t = (document.body?.innerText || "").slice(0, 3000);
        if (
          (/\bLog in\b|로그인/i.test(t) && /\bSign up\b|가입/i.test(t)) ||
          (t.includes("Log in") && t.includes("Sign up"))
        ) {
          return true;
        }
      }
    }
    return false;
  });
}

async function hasInstagramSession(page) {
  const cookies = await getInstagramCookiesJar(page);
  return cookies.some((cookie) => cookie.name === "sessionid" && cookie.value);
}

/**
 * 수동 로그인: onetap·2FA 등으로 URL만 바뀌었어도 sessionid가 늦게 잡힐 수 있어 폴링한다.
 */
async function waitForManualLoginSessionReady(page, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await hasInstagramSession(page)) && !(await instagramUiShowsLoggedOut(page))) {
        return;
      }
    } catch {
      /* ignore */
    }
    await delay(650);
  }
}

async function refreshInstagramSessionProbe(page) {
  try {
    await page.goto(`${IG_ORIGIN}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(1500);
    await dismissBlockingDialogs(page);
  } catch {
    /* keep current page */
  }
}

/** @type {string[]} */
const USERNAME_SELECTORS = [
  'input[name="username"]',
  'input[autocomplete="username"]',
  'input[aria-label*="Phone number" i]',
  'input[aria-label*="username" i]',
  'input[aria-label*="전화번호" i]',
  'input[aria-label*="사용자 이름" i]',
  'form[method="post"] input[type="text"]:not([name="email"])',
];

/** @type {string[]} */
const PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[aria-label*="Password" i]',
  'input[aria-label*="비밀번호" i]',
];

async function resolveLoginSelectors(page) {
  for (const u of USERNAME_SELECTORS) {
    for (const p of PASSWORD_SELECTORS) {
      const ok = await page.evaluate(
        (us, ps) => Boolean(document.querySelector(us) && document.querySelector(ps)),
        u,
        p,
      );
      if (ok) return { usernameSelector: u, passwordSelector: p };
    }
  }
  return null;
}

async function waitForLoginForm(page, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCheckpointOrBlockedPath(page)) return null;
    const resolved = await resolveLoginSelectors(page);
    if (resolved) return resolved;
    await delay(450);
  }
  return null;
}

async function isCheckpointOrBlockedPath(page) {
  return page.evaluate(() => {
    const p = location.pathname;
    return (
      p.includes("/challenge") ||
      p.includes("/accounts/suspended") ||
      p.includes("/checkpoint")
    );
  });
}

/** 새 브라우저/탭에서 이전 Instagram 세션을 쓰지 않도록 쿠키 제거 */
async function clearBrowserCookiesForNewLogin(page) {
  const client = await page.createCDPSession();
  await client.send("Network.clearBrowserCookies");
}

async function saveInstagramCookiesToFile(page, filePath) {
  const cookies = await getInstagramCookiesJar(page);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2), "utf8");
  console.info(`[instagram-scraper] Instagram 쿠키 파일 저장: ${filePath}`);
}

async function tryReuseSavedCookies(page, filePath) {
  console.log("[instagram-scraper] tryReuseSavedCookies 시작", { filePath, exists: Boolean(filePath && fs.existsSync(filePath)) });
  if (!filePath || !fs.existsSync(filePath)) return false;

  let list;
  try {
    list = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
  if (!Array.isArray(list) || list.length === 0) return false;

  try {
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    try {
      await page.setCookie(...list);
    } catch {
      return false;
    }

    await page.goto(IG_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await delay(1500);
    await dismissBlockingDialogs(page);
    if (!(await hasInstagramSession(page))) {
      console.log("[instagram-scraper] tryReuseSavedCookies → sessionid 없음, 재사용 안 함");
      return false;
    }
    if (await instagramUiShowsLoggedOut(page)) {
      console.log("[instagram-scraper] tryReuseSavedCookies → 로그아웃 UI, 재사용 안 함");
      return false;
    }
    console.log("[instagram-scraper] tryReuseSavedCookies → 세션 유효, 재사용 성공");
    return true;
  } catch (err) {
    console.warn(
      "[instagram-scraper] 저장 쿠키 재사용 실패(무시하고 로그인 단계로 진행):",
      err?.message || err,
    );
    return false;
  }
}

/**
 * 헤드리스용: 쿠키는 호출 전에 이미 비운 상태에서 시작.
 * 성공 시 cookieFilePath 에 저장.
 */
async function performAutomatedPasswordLogin(page, username, password, headless, cookieFilePath) {
  await page.goto(`${IG_ORIGIN}/accounts/login/`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await delay(1000);
  await dismissBlockingDialogs(page);

  if (await isCheckpointOrBlockedPath(page)) {
    throw new Error(
      "Instagram 보안 확인·챌린지 화면입니다. " +
        (headless
          ? "서버 헤드리스 환경에서는 이 화면을 직접 통과하기 어렵습니다. 로컬에서 HEADLESS=false로 실행해 브라우저에서 확인을 완료해 보세요."
          : "브라우저 창에서 확인을 완료한 뒤 다시 분석을 시도해 주세요."),
    );
  }

  let form = await waitForLoginForm(page);
  if (!form) {
    const loginLink = await page.$('a[href*="/accounts/login"]');
    if (loginLink) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
        loginLink.click(),
      ]);
      await delay(1200);
      await dismissBlockingDialogs(page);
      form = await waitForLoginForm(page, 25000);
    }
  }

  if (!form) {
    if (headless) {
      throw new Error(
        "Instagram 로그인 폼을 찾지 못했습니다(동의·챌린지·UI 변경 가능). 헤드리스에서는 자동 로그인이 막히는 경우가 많습니다.",
      );
    }
    await waitForManualLoginIfNeeded(page);
    await delay(1200);
    await dismissBlockingDialogs(page);
    if ((await hasInstagramSession(page)) && !(await instagramUiShowsLoggedOut(page))) {
      if (cookieFilePath) await saveInstagramCookiesToFile(page, cookieFilePath);
      return;
    }
    throw new Error(
      "로그인 화면을 찾지 못했습니다. 터미널에서 HEADLESS=false 로 서버를 실행하면 Chrome 창이 열립니다. " +
        "창이 안 보이면 .env에 HEADLESS=false 가 있는지 확인한 뒤 서버를 다시 시작하세요.",
    );
  }

  await page.click(form.usernameSelector, { clickCount: 3 }).catch(() => {});
  await page.type(form.usernameSelector, username, { delay: 25 });
  await page.click(form.passwordSelector, { clickCount: 3 }).catch(() => {});
  await page.type(form.passwordSelector, password, { delay: 25 });

  const navPromise = page
    .waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 })
    .catch(() => {});

  const clicked = await page.evaluate(() => {
    const direct = document.querySelector('form button[type="submit"], button[type="submit"]');
    if (direct) {
      direct.click();
      return true;
    }
    const byText = Array.from(document.querySelectorAll("button, [role='button']")).find((b) => {
      const t = (b.textContent || "").trim().toLowerCase();
      return (
        t === "log in" ||
        t.includes("log in") ||
        t === "로그인" ||
        (t.includes("로그인") && t.length < 20)
      );
    });
    if (byText) {
      byText.click();
      return true;
    }
    return false;
  });
  if (!clicked) {
    await page.click('button[type="submit"]').catch(() => {});
  }

  await navPromise;
  await delay(2800);
  await dismissBlockingDialogs(page);

  if (!(await hasInstagramSession(page))) {
    if (!headless) {
      await waitForManualLoginIfNeeded(page);
      await delay(1200);
      await dismissBlockingDialogs(page);
      if ((await hasInstagramSession(page)) && !(await instagramUiShowsLoggedOut(page))) {
        if (cookieFilePath) await saveInstagramCookiesToFile(page, cookieFilePath);
        return;
      }
    }
    throw new Error(
      "로그인에 실패했거나 추가 확인(2단계 인증·보안 확인)이 필요합니다. IG_USERNAME/IG_PASSWORD를 확인하거나, HEADLESS=false로 브라우저에서 직접 로그인해 주세요.",
    );
  }
  if (await instagramUiShowsLoggedOut(page)) {
    throw new Error(
      "로그인 후에도 Instagram이 로그아웃 화면을 보여 줍니다. IP 차단·추가 인증일 수 있습니다.",
    );
  }
  if (cookieFilePath) await saveInstagramCookiesToFile(page, cookieFilePath);
}

async function waitForManualLoginIfNeeded(page) {
  try {
    await page.waitForFunction(
      () => {
        const h = (location.hostname || "").toLowerCase();
        if (!h.includes("instagram.com")) return false;
        const path = location.pathname || "";
        const stillAuth =
          path.includes("/accounts/login") ||
          path.includes("/challenge") ||
          path.includes("/checkpoint") ||
          path.includes("/two_factor") ||
          path.includes("/accounts/onetap") ||
          path.includes("/accounts/signup") ||
          path.includes("/accounts/account_recovery") ||
          path.includes("/accounts/password") ||
          path.includes("/consent") ||
          /\/oauth\//i.test(path);
        return !stillAuth;
      },
      { timeout: 120000 },
    );
  } catch {
    const url = page.url();
    throw new Error(
      "수동 로그인 대기 중 시간이 초과되었거나, 브라우저에 Instagram 로그인 화면이 아직 열리지 않았습니다. " +
        `Chrome 창에서 ${IG_ORIGIN}/accounts/login/ 이 보이는지 확인하세요. 현재 URL: ${url}`,
    );
  }
}

/**
 * 1) cookiePath JSON이 있으면 적용 후 유효하면 그대로 사용
 * 2) 헤드리스가 아니면: 쿠키 초기화 → 로그인 페이지에서 수동 로그인 대기 → cookiePath 저장
 * 3) 헤드리스면: 쿠키 초기화 → IG_USERNAME/IG_PASSWORD 자동 로그인 → cookiePath 저장
 * @param {string} cookieFilePath
 */
async function login(page, username, password, headless, cookieFilePath) {
  const resolvedCookiePath =
    cookieFilePath || path.join(__dirname, "../.instagram-cookies.json");

  console.log("[instagram-scraper] login 진입", {
    headless,
    hasUsername: Boolean(username),
    hasPassword: Boolean(password),
    resolvedCookiePath,
  });

  if (await tryReuseSavedCookies(page, resolvedCookiePath)) {
    console.log("[instagram-scraper] login 분기: 저장 쿠키 세션 재사용 후 return");
    console.info(`[instagram-scraper] 저장된 쿠키로 세션 사용: ${resolvedCookiePath}`);
    return;
  }

  console.log("[instagram-scraper] login 분기: 저장 쿠키 없음 또는 무효 → 다음 단계");

  if (!headless) {
    console.log("[instagram-scraper] login 분기: 수동 로그인(창 모드) — /accounts/login/ 이동");
    console.info(
      "[instagram-scraper] 브라우저에서 Instagram에 로그인해 주세요. 완료되면 쿠키가 파일에 저장됩니다.",
    );
    await clearBrowserCookiesForNewLogin(page);
    await page.goto(`${IG_ORIGIN}/accounts/login/`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await delay(800);
    await dismissBlockingDialogs(page);

    try {
      if (typeof page.bringToFront === "function") {
        await page.bringToFront();
      }
    } catch {
      /* ignore */
    }
    const afterGoto = page.url();
    if (!afterGoto.toLowerCase().includes("instagram.com")) {
      throw new Error(
        `Instagram 로그인 페이지로 이동하지 못했습니다. 네트워크·방화벽·프록시를 확인해 주세요. 현재 URL: ${afterGoto}`,
      );
    }

    console.log("[instagram-scraper] 수동 로그인: URL 확인 OK, 사용자 로그인 대기 시작", {
      url: afterGoto,
    });
    await waitForManualLoginIfNeeded(page);
    await delay(1200);
    await dismissBlockingDialogs(page);

    await waitForManualLoginSessionReady(page, 75_000);
    if (!(await hasInstagramSession(page)) || (await instagramUiShowsLoggedOut(page))) {
      console.log("[instagram-scraper] 수동 로그인: 세션 미확인 → 메인 피드로 이동 후 재확인");
      await refreshInstagramSessionProbe(page);
      await waitForManualLoginSessionReady(page, 45_000);
    }

    let hasSessProbe = await hasInstagramSession(page);
    let looksOutProbe = await instagramUiShowsLoggedOut(page);
    if (hasSessProbe && looksOutProbe) {
      console.log(
        "[instagram-scraper] sessionid는 있으나 로그아웃 UI로 판정됨 → 피드·내비 로딩 대기 후 재검사",
      );
      try {
        await page.waitForSelector(
          "main article, [role='main'] article, a[href*='/direct/inbox']",
          { timeout: 25_000 },
        );
      } catch {
        /* ignore */
      }
      await delay(1200);
      await dismissBlockingDialogs(page);
    }

    if (!(await hasInstagramSession(page)) || (await instagramUiShowsLoggedOut(page))) {
      const url = page.url();
      const hasSess = await hasInstagramSession(page);
      const looksOut = await instagramUiShowsLoggedOut(page);
      console.warn("[instagram-scraper] 수동 로그인 검증 실패", {
        url,
        hasSessionid: hasSess,
        uiLooksLoggedOut: looksOut,
      });
      throw new Error(
        "수동 로그인이 끝나지 않았거나 Instagram이 세션을 거부했습니다. 로그인·보안 확인을 마친 뒤 다시 시도해 주세요.",
      );
    }
    console.log("[instagram-scraper] login 분기: 수동 로그인 완료 → 쿠키 저장");
    await saveInstagramCookiesToFile(page, resolvedCookiePath);
    return;
  }

  if (!username || !password) {
    console.log("[instagram-scraper] login 분기: 헤드리스인데 IG_USERNAME/PASSWORD 없음 → throw");
    throw new Error(
      "저장된 Instagram 쿠키가 없거나 만료되었습니다. " +
        "로컬에서 HEADLESS=false로 서버를 실행해 브라우저에서 한 번 로그인하면 쿠키가 저장되거나, IG_USERNAME·IG_PASSWORD를 설정하세요.",
    );
  }

  await clearBrowserCookiesForNewLogin(page);
  console.log("[instagram-scraper] login 분기: 헤드리스 자동 로그인(폼)");
  await performAutomatedPasswordLogin(page, username, password, headless, resolvedCookiePath);
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

  for (let step = 0; step < 12 && urls.size < 20; step++) {
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

    if (urls.size >= 20) break;

    await page.evaluate(() => window.scrollBy(0, 900));
    await delay(650);
  }

  return [...urls].slice(0, 20);
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
  const reels = [];
  for (let i = 0; i < postUrls.length; i++) {
    const postUrl = postUrls[i];
    const isReel = postUrl.includes("/reel/");
    const isRecentReel = isReel && i < 10;

    if (i >= 10 && posts.length >= 10) {
      break;
    }
    if (isReel && !isRecentReel) {
      continue;
    }
    if (!isReel && posts.length >= 10) {
      continue;
    }

    await delay(900 + Math.random() * 700);
    await page.goto(postUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await delay(700);

    const desc = await getOgDescription(page);
    if (isReel) {
      let views = parseViewsFromText(desc);

      if (views == null) {
        const blob = await page.evaluate(() => {
          const parts = [];
          document.querySelectorAll("span, li, section, div").forEach((el) => {
            const t = (el.innerText || "").trim();
            if (t.length > 0 && t.length < 200) parts.push(t);
          });
          return parts.join(" | ");
        });
        views = parseViewsFromText(blob);
      }

      reels.push({
        url: postUrl,
        views,
      });
      continue;
    }

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
      url: postUrl,
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
    reels,
    error: profileError,
  };
}

/**
 * @param {string[]} usernames
 * @param {{ igUsername?: string; igPassword?: string; headless?: boolean; cookiePath?: string }} creds
 */
export async function analyzeInfluencers(usernames, creds) {
  console.log("[instagram-scraper] analyzeInfluencers 시작", {
    userCount: usernames.length,
    credsHeadless: creds.headless,
    hasIgUsername: Boolean(creds.igUsername),
    cookiePath: creds.cookiePath,
  });

  const { launchOpts, loginHeadless } = await buildLaunchOptions(creds);
  console.log("[instagram-scraper] puppeteer.launch 호출", {
    loginHeadless,
    launchHeadless: launchOpts.headless,
  });

  const browser = await puppeteer.launch(launchOpts);
  console.log("[instagram-scraper] puppeteer.launch 완료");

  try {
    const page = await browser.newPage();
    console.log("[instagram-scraper] newPage 완료");
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    const cookiePath = creds.cookiePath || path.join(__dirname, "../.instagram-cookies.json");
    console.log("[instagram-scraper] login() 호출 전", { loginHeadless, cookiePath });
    await login(page, creds.igUsername, creds.igPassword, loginHeadless, cookiePath);
    console.log("[instagram-scraper] login() 완료");

    const rows = [];

    const uniqueHandles = [...new Set(usernames.map((u) => u.replace(/^@/, "").trim()).filter(Boolean))];

    for (const h of uniqueHandles) {
      console.log("[instagram-scraper] scrapeProfileSummary", { handle: h });
      try {
        await delay(1500 + Math.random() * 1000);
        const row = await scrapeProfileSummary(page, h);
        rows.push(row);
        console.log("[instagram-scraper] scrapeProfileSummary 완료", {
          handle: h,
          error: row.error ?? null,
          postCount: row.posts?.length ?? 0,
          reelCount: row.reels?.length ?? 0,
        });
      } catch (e) {
        console.warn("[instagram-scraper] scrapeProfileSummary 실패(행에 error 기록)", {
          handle: h,
          message: errorMessageFromUnknown(e),
        });
        rows.push({
          username: h.replace(/^@/, ""),
          profileUrl: `${IG_ORIGIN}/${encodeURIComponent(h)}/`,
          followers: null,
          metaOgDescription: null,
          posts: [],
          reels: [],
          error: errorMessageFromUnknown(e),
        });
      }
    }

    console.log("[instagram-scraper] analyzeInfluencers 정상 종료(루프 완료)", {
      rows: rows.length,
    });
    return rows;
  } finally {
    console.log("[instagram-scraper] browser.close()");
    await browser.close();
  }
}
