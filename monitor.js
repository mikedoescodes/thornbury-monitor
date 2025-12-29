/**
 * Thornbury Picture House showtimes monitor
 * - Fetches showings via their GraphQL endpoint for a rolling window (today + 30 days)
 * - Caches results to cache.json
 * - Detects added/removed sessions vs last run
 * - Ignores past sessions when comparing (so old sessions dropping off won't trigger)
 */

const axios = require("axios");
const fs = require("fs");

const BASE = "https://www.thornburypicturehouse.com.au";
const HOME_URL = `${BASE}/`;
const NOW_SHOWING_URL = `${BASE}/now-showing/`;
const GRAPHQL_URL = `${BASE}/graphql`;

const SITE_ID = 12;
const CIRCUIT_ID = 8;
const CACHE_FILE = "cache.json";
const MEL_TZ = "Australia/Melbourne";

// Rolling window: today + 30 days
const DAYS_AHEAD = 30;

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
    count
    resultVersion
  }
}
`;

function buildHeaders(cookieHeader) {
  return {
    accept: "*/*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    "content-type": "application/json",
    origin: BASE,
    referer: NOW_SHOWING_URL,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",

    // Required by backend auth/permission layer
    "client-type": "consumer",
    "circuit-id": String(CIRCUIT_ID),
    "site-id": String(SITE_ID),
    "is-electron-mode": "false",

    cookie: cookieHeader,
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

async function primeCookies() {
  let cookies = "";

  const ua =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

  const homeResp = await axios.get(HOME_URL, {
    headers: {
      "user-agent": ua,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    },
    timeout: 20000,
    validateStatus: () => true,
  });
  cookies = mergeSetCookies(cookies, homeResp.headers["set-cookie"]);

  const nowResp = await axios.get(NOW_SHOWING_URL, {
    headers: {
      "user-agent": ua,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
      cookie: cookies,
    },
    timeout: 20000,
    validateStatus: () => true,
  });
  cookies = mergeSetCookies(cookies, nowResp.headers["set-cookie"]);

  return cookies;
}

function toYMD(dateObj) {
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

async function fetchShowingsForDate(cookieHeader, ymd) {
  const variables = {
    date: ymd,
    ids: [],
    movieId: null,
    movieIds: [],
    titleClassId: null,
    titleClassIds: [],
    siteIds: [SITE_ID],
    everyShowingBadgeIds: [null],
    anyShowingBadgeIds: null,
    resultVersion: null,
  };

  const resp = await axios.post(
    GRAPHQL_URL,
    { query: GRAPHQL_QUERY, variables },
    {
      headers: buildHeaders(cookieHeader),
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  const snippet =
    typeof resp.data === "string"
      ? resp.data.slice(0, 400)
      : JSON.stringify(resp.data).slice(0, 400);

  if (resp.status === 403) {
    throw new Error(`GraphQL 403 for date=${ymd}. Body snippet: ${snippet}`);
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`GraphQL HTTP ${resp.status} for date=${ymd}. Body snippet: ${snippet}`);
  }
  if (resp.data?.error?.message) {
    throw new Error(`GraphQL error for date=${ymd}: ${resp.data.error.message}`);
  }
  if (resp.data?.errors?.length) {
    throw new Error(
      `GraphQL errors for date=${ymd}: ${JSON.stringify(resp.data.errors).slice(0, 600)}`
    );
  }

  return resp.data?.data?.showingsForDate?.data ?? [];
}

/**
 * Map shape:
 *   { [movieName]: [ isoString, isoString, ... ] }
 *
 * We store ISO strings in cache (not formatted local strings).
 */
async function getAllShowtimesRollingMonth() {
  const cookieHeader = await primeCookies();

  const map = {};
  let cursor = new Date();

  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const ymd = toYMD(cursor);
    const showings = await fetchShowingsForDate(cookieHeader, ymd);

    for (const s of showings) {
      const movie = s?.movie?.name?.trim();
      const iso = s?.time;
      if (!movie || !iso) continue;

      if (!map[movie]) map[movie] = [];
      map[movie].push(iso);
    }

    cursor = addDays(cursor, 1);
    await new Promise((r) => setTimeout(r, 150));
  }

  // Deduplicate + sort chronologically
  for (const movie of Object.keys(map)) {
    map[movie] = Array.from(new Set(map[movie])).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime()
    );
  }

  return map;
}

function isPastShowtime(isoString) {
  const t = new Date(isoString).getTime();
  if (!Number.isFinite(t)) return false;
  return t < Date.now();
}

function filterPastShowtimes(showtimeMap) {
  const filtered = {};
  for (const [movie, times] of Object.entries(showtimeMap || {})) {
    const futureTimes = (times || []).filter((t) => !isPastShowtime(t));
    if (futureTimes.length > 0) {
      filtered[movie] = futureTimes;
    }
  }
  return filtered;
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

function formatSessionMelbourne(isoString) {
  const d = new Date(isoString);

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

  return `${dateStr} ${timeStr}`;
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

  // Filter out past showtimes from BOTH old and new data before comparison
  const filteredOldData = filterPastShowtimes(oldData);
  const filteredNewData = filterPastShowtimes(newData);

  const added = {};
  const removed = {};

  // Compare filtered datasets
  for (const [movie, times] of Object.entries(filteredNewData)) {
    if (!filteredOldData[movie]) {
      added[movie] = times;
    } else {
      const newTimes = times.filter((t) => !filteredOldData[movie].includes(t));
      if (newTimes.length) added[movie] = newTimes;
    }
  }

  for (const [movie, times] of Object.entries(filteredOldData)) {
    if (!filteredNewData[movie]) {
      removed[movie] = times;
    } else {
      const gone = times.filter((t) => !filteredNewData[movie].includes(t));
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
      addedText += `${movie}: ${times.map(formatSessionMelbourne).join(", ")}<br>\n`;
    }
  }

  let removedText = "";
  if (Object.keys(changes.removed).length) {
    removedText = "SESSIONS REMOVED:<br>\n";
    for (const [movie, times] of Object.entries(changes.removed)) {
      removedText += `${movie}: ${times.map(formatSessionMelbourne).join(", ")}<br>\n`;
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
