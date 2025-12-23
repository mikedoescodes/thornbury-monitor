const axios = require("axios");
const fs = require("fs");

const BASE = "https://www.thornburypicturehouse.com.au";
const HOME_URL = `${BASE}/`;
const NOW_SHOWING_URL = `${BASE}/now-showing/`;
const GRAPHQL_URL = `${BASE}/graphql`; // If your DevTools "Request URL" is different, paste it here.
const SITE_ID = 12;

const CACHE_FILE = "cache.json";
const MEL_TZ = "Australia/Melbourne";
const DAYS_AHEAD = 30; // today + 30 days

// Match the query signature you saw in DevTools
const GRAPHQL_QUERY = `
query ($date: String, $ids: [ID], $movieId: ID, $movieIds: [ID], $titleClassId: ID, $titleClassIds: [ID], $siteIds: [ID], $everyShowingBadgeIds: [ID], $anyShowingBadgeIds: [ID], $resultVersion: String) {
  showingsForDate(
    date: $date
    ids: $ids
    movieId: $movieId
    movieIds: $movieIds
    titleClassId: $titleClassId
    titleClassIds: $titleClassIds
    siteIds: $siteIds
    everyShowingBadgeIds: $everyShowingBadgeIds
    anyShowingBadgeIds: $anyShowingBadgeIds
    resultVersion: $resultVersion
  ) {
    data {
      id
      time
      movie { name }
    }
  }
}
`;

function browserHeaders(extra = {}) {
  return {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-AU,en;q=0.9",
    Origin: BASE,
    Referer: NOW_SHOWING_URL,
    ...extra,
  };
}

function mergeSetCookies(existingCookieHeader, setCookieArray) {
  const existing = new Map();
  if (existingCookieHeader) {
    existingCookieHeader.split(";").forEach((kv) => {
      const [k, ...rest] = kv.trim().split("=");
      if (!k) return;
      existing.set(k, rest.join("="));
    });
  }
  for (const c of setCookieArray || []) {
    const [kv] = c.split(";");
    const [k, ...rest] = kv.trim().split("=");
    if (!k) continue;
    existing.set(k, rest.join("="));
  }
  return Array.from(existing.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function extractCsrfToken(html) {
  // Common patterns:
  // <meta name="csrf-token" content="...">
  // window.csrfToken = "..."
  const metaMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
  if (metaMatch?.[1]) return metaMatch[1];

  const jsMatch = html.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/i);
  if (jsMatch?.[1]) return jsMatch[1];

  return null;
}

function toYMD(dateObj) {
  // YYYY-MM-DD in Melbourne local date
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MEL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(dateObj);

  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function addDays(dateObj, days) {
  const d = new Date(dateObj.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function primeSession() {
  // Hit HOME and NOW_SHOWING to get the full cookie set, plus CSRF (if present).
  let cookies = "";
  let csrfToken = null;

  // 1) Home page
  const homeResp = await axios.get(HOME_URL, {
    headers: browserHeaders({ Accept: "text/html,application/xhtml+xml" }),
    timeout: 20000,
    validateStatus: () => true,
  });
  cookies = mergeSetCookies(cookies, homeResp.headers["set-cookie"]);
  csrfToken = csrfToken || extractCsrfToken(homeResp.data || "");

  // 2) Now showing page
  const nowResp = await axios.get(NOW_SHOWING_URL, {
    headers: browserHeaders({ Accept: "text/html,application/xhtml+xml", Cookie: cookies }),
    timeout: 20000,
    validateStatus: () => true,
  });
  cookies = mergeSetCookies(cookies, nowResp.headers["set-cookie"]);
  csrfToken = csrfToken || extractCsrfToken(nowResp.data || "");

  return { cookies, csrfToken };
}

async function fetchShowingsForDate(session, ymd) {
  const variables = {
    siteIds: [SITE_ID],
    date: ymd,
    ids: null,
    movieId: null,
    movieIds: null,
    titleClassId: null,
    titleClassIds: null,
    everyShowingBadgeIds: null,
    anyShowingBadgeIds: null,
    resultVersion: null,
  };

  const headers = browserHeaders({
    "Content-Type": "application/json",
    Cookie: session.cookies,
    "X-Requested-With": "XMLHttpRequest",
  });

  // If we found a CSRF token, include it
  if (session.csrfToken) {
    headers["X-CSRF-Token"] = session.csrfToken;
  }

  const resp = await axios.post(
    GRAPHQL_URL,
    { query: GRAPHQL_QUERY, variables },
    {
      headers,
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  // Some GraphQL setups return { data: {}, error: {...} } on auth failures.
  const bodySnippet =
    typeof resp.data === "string"
      ? resp.data.slice(0, 400)
      : JSON.stringify(resp.data).slice(0, 400);

  if (resp.status === 403) {
    throw new Error(`GraphQL 403 for date=${ymd}. Body snippet: ${bodySnippet}`);
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`GraphQL HTTP ${resp.status} for date=${ymd}. Body snippet: ${bodySnippet}`);
  }
  if (resp.data?.error?.message) {
    throw new Error(`GraphQL error for date=${ymd}: ${resp.data.error.message}`);
  }
  if (resp.data?.errors?.length) {
    throw new Error(`GraphQL errors for date=${ymd}: ${JSON.stringify(resp.data.errors).slice(0, 600)}`);
  }

  return resp.data?.data?.showingsForDate?.data ?? [];
}

async function getAllShowtimesRollingMonth() {
  const session = await primeSession();

  const map = {};
  let cursor = new Date();

  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const ymd = toYMD(cursor);

    const showings = await fetchShowingsForDate(session, ymd);

    for (const s of showings) {
      const movie = s?.movie?.name?.trim();
      const iso = s?.time;
      if (!movie || !iso) continue;

      const d = new Date(iso);

      const dateStr = d.toLocaleDateString("en-AU", {
        month: "long",
        day: "numeric",
        timeZone: MEL_TZ,
      });

      const timeStr = d
        .toLocaleTimeString("en-AU", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: MEL_TZ,
        })
        .toLowerCase();

      const formatted = `${dateStr} ${timeStr}`;

      if (!map[movie]) map[movie] = [];
      map[movie].push(formatted);
    }

    cursor = addDays(cursor, 1);
    await new Promise((r) => setTimeout(r, 150));
  }

  for (const movie of Object.keys(map)) {
    map[movie] = Array.from(new Set(map[movie])).sort();
  }

  return map;
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

function formatDateTimeMelbourne(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString("en-AU", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: MEL_TZ,
    timeZoneName: "short",
  });
}

function detectChanges(oldData, newData) {
  if (!oldData) {
    const movieCount = Object.keys(newData).length;
    const showtimeCount = Object.values(newData).reduce((sum, arr) => sum + arr.length, 0);
    return {
      changed: true,
      isInitial: true,
      message: `Initial check: ${movieCount} movies with ${showtimeCount} showtimes found`,
    };
  }

  const added = {};
  const removed = {};

  for (const [movie, times] of Object.entries(newData)) {
    if (!oldData[movie]) {
      added[movie] = times;
    } else {
      const newTimes = times.filter((t) => !oldData[movie].includes(t));
      if (newTimes.length) added[movie] = newTimes;
    }
  }

  for (const [movie, times] of Object.entries(oldData)) {
    if (!newData[movie]) {
      removed[movie] = times;
    } else {
      const gone = times.filter((t) => !newData[movie].includes(t));
      if (gone.length) removed[movie] = gone;
    }
  }

  const changed = Object.keys(added).length > 0 || Object.keys(removed).length > 0;
  return { changed, isInitial: false, added, removed };
}

function formatMessage(changes, timestampIso) {
  if (changes.isInitial) {
    return {
      value1: changes.message,
      value2: "",
      value3: formatDateTimeMelbourne(timestampIso),
    };
  }

  let addedText = "";
  if (Object.keys(changes.added).length) {
    addedText = "SESSIONS ADDED:<br>\n";
    for (const [movie, times] of Object.entries(changes.added)) {
      addedText += `${movie}: ${times.join(", ")}<br>\n`;
    }
  }

  let removedText = "";
  if (Object.keys(changes.removed).length) {
    removedText = "SESSIONS REMOVED:<br>\n";
    for (const [movie, times] of Object.entries(changes.removed)) {
      removedText += `${movie}: ${times.join(", ")}<br>\n`;
    }
  }

  return {
    value1: addedText || "No sessions added",
    value2: removedText || "No sessions removed",
    value3: formatDateTimeMelbourne(timestampIso),
  };
}

async function sendNotification(message) {
  const webhookUrl = process.env.IFTTT_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("IFTTT_WEBHOOK_URL not set");

  await axios.post(webhookUrl, message, { timeout: 20000 });
  console.log("Notification sent successfully");
}

async function main() {
  console.log("Checking Thornbury Picture House...");

  const oldData = loadCache();

  let newData;
  try {
    newData = await getAllShowtimesRollingMonth();
  } catch (e) {
    // IMPORTANT: do NOT notify and do NOT overwrite cache on auth/fetch failure
    console.error("Error fetching showtimes:", e.message || e);
    process.exit(1);
  }

  const movieCount = Object.keys(newData).length;
  const showtimeCount = Object.values(newData).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Found ${movieCount} movies with ${showtimeCount} total showtimes`);

  const changes = detectChanges(oldData, newData);

  if (changes.changed) {
    console.log("Changes detected!");
    const msg = formatMessage(changes, new Date().toISOString());
    console.log(msg);
    await sendNotification(msg);
  } else {
    console.log("No changes detected");
  }

  saveCache(newData);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
