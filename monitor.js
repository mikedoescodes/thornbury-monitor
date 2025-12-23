const axios = require("axios");
const fs = require("fs");

const BASE = "https://www.thornburypicturehouse.com.au";
const NOW_SHOWING_URL = `${BASE}/now-showing`;
const GRAPHQL_URL = `${BASE}/graphql`;
const SITE_ID = 12;

const CACHE_FILE = "cache.json";
const MEL_TZ = "Australia/Melbourne";

// Rolling window: today + 30 days
const DAYS_AHEAD = 30;

// Keep the query signature matching what you saw in DevTools.
// We set variables.date to a specific YYYY-MM-DD.
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
    Referer: `${NOW_SHOWING_URL}/`,
    ...extra,
  };
}

async function getCookieHeader() {
  const resp = await axios.get(`${NOW_SHOWING_URL}/`, {
    headers: browserHeaders({ Accept: "text/html,application/xhtml+xml" }),
    timeout: 20000,
    validateStatus: () => true,
  });

  const setCookie = resp.headers["set-cookie"] || [];
  return setCookie
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
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

async function fetchShowingsForDate(cookieHeader, ymd) {
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

  const resp = await axios.post(
    GRAPHQL_URL,
    { query: GRAPHQL_QUERY, variables },
    {
      headers: browserHeaders({
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "X-Requested-With": "XMLHttpRequest",
      }),
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  if (resp.status === 403) {
    const snippet =
      typeof resp.data === "string"
        ? resp.data.slice(0, 300)
        : JSON.stringify(resp.data).slice(0, 300);
    throw new Error(`GraphQL 403 for date=${ymd}. Body snippet: ${snippet}`);
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(
      `GraphQL HTTP ${resp.status} for date=${ymd}: ${JSON.stringify(resp.data).slice(0, 300)}`
    );
  }
  if (resp.data?.errors?.length) {
    throw new Error(
      `GraphQL errors for date=${ymd}: ${JSON.stringify(resp.data.errors).slice(0, 500)}`
    );
  }

  // Some GraphQL implementations return { data: {}, error: {...} } (non-standard).
  // Handle that too:
  if (resp.data?.error?.message) {
    throw new Error(`GraphQL error for date=${ymd}: ${resp.data.error.message}`);
  }

  return resp.data?.data?.showingsForDate?.data ?? [];
}

async function getAllShowtimesRollingMonth() {
  const cookieHeader = await getCookieHeader();

  const map = {};
  let cursor = new Date();

  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const ymd = toYMD(cursor);

    const showings = await fetchShowingsForDate(cookieHeader, ymd);

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

    // small pause to reduce chances of rate limiting / blocking
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
    // IMPORTANT: don't overwrite cache, don't notify, fail the run
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
