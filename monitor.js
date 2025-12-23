const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const BASE_URL = 'https://www.thornburypicturehouse.com.au';
const NOW_SHOWING_URL = `${BASE_URL}/now-showing`;
const CACHE_FILE = 'cache.json';

async function fetchPage(url) {
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error(`Error fetching ${url}:`, error.message);
    return null;
  }
}

async function getMovieList(html) {
  const $ = cheerio.load(html);
  const movies = new Set();
  
  $('a[href*="/movie/"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href && href.startsWith('/movie/')) {
      const movieSlug = href.replace('/movie/', '');
      const title = $(el).text().trim();
      if (title) {
        movies.add(JSON.stringify({ slug: movieSlug, title }));
      }
    }
  });
  
  return Array.from(movies).map(m => JSON.parse(m));
}

async function getMovieShowtimes(movieSlug) {
  const url = `${BASE_URL}/movie/${movieSlug}`;
  const html = await fetchPage(url);
  if (!html) return [];
  
  const $ = cheerio.load(html);
  const showtimes = [];
  
  $('a[href*="/checkout/showing/"]').each((i, el) => {
    const text = $(el).text().trim();
    const match = text.match(/(.*?),\s*(\d+:\d+\s*(?:am|pm))/i);
    if (match) {
      const dateStr = match[1].trim();
      const timeStr = match[2].trim();
      showtimes.push(`${dateStr} ${timeStr}`);
    }
  });
  
  return showtimes;
}

async function getAllShowtimes() {
  console.log('Fetching now showing page...');
  const html = await fetchPage(NOW_SHOWING_URL);
  if (!html) return {};
  
  const movies = await getMovieList(html);
  console.log(`Found ${movies.length} movies`);
  
  const showtimeMap = {};
  
  for (const movie of movies) {
    console.log(`Fetching showtimes for: ${movie.title}`);
    const showtimes = await getMovieShowtimes(movie.slug);
    if (showtimes.length > 0) {
      showtimeMap[movie.title] = showtimes.sort();
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  return showtimeMap;
}

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    const data = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  }
  return null;
}

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

function formatDateTime(isoString) {
  const date = new Date(isoString);
  const options = { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric', 
    hour: 'numeric', 
    minute: '2-digit',
    timeZoneName: 'short'
  };
  return date.toLocaleString('en-AU', options);
}

function detectChanges(oldData, newData) {
  if (!oldData) {
    const movieCount = Object.keys(newData).length;
    const showtimeCount = Object.values(newData).reduce((sum, times) => sum + times.length, 0);
    return {
      changed: true,
      isInitial: true,
      message: `Initial check: ${movieCount} movies with ${showtimeCount} showtimes found`
    };
  }
  
  const added = {};
  const removed = {};
  
  for (const [movie, times] of Object.entries(newData)) {
    if (!oldData[movie]) {
      added[movie] = times;
    } else {
      const newTimes = times.filter(t => !oldData[movie].includes(t));
      if (newTimes.length > 0) {
        added[movie] = newTimes;
      }
    }
  }
  
  for (const [movie, times] of Object.entries(oldData)) {
    if (!newData[movie]) {
      removed[movie] = times;
    } else {
      const removedTimes = times.filter(t => !newData[movie].includes(t));
      if (removedTimes.length > 0) {
        removed[movie] = removedTimes;
      }
    }
  }
  
  const hasChanges = Object.keys(added).length > 0 || Object.keys(removed).length > 0;
  
  return {
    changed: hasChanges,
    isInitial: false,
    added,
    removed
  };
}

function formatMessage(changes, timestamp) {
  if (changes.isInitial) {
    return {
      value1: changes.message,
      value2: '',
      value3: formatDateTime(timestamp)
    };
  }
  
  let addedText = '';
  if (Object.keys(changes.added).length > 0) {
    addedText = 'SESSIONS ADDED:<br>\n';
    for (const [movie, times] of Object.entries(changes.added)) {
      const timesList = Array.isArray(times) ? times : [times];
      addedText += `${movie}: ${timesList.join(', ')}<br>\n`;
    }
  }
  
  let removedText = '';
  if (Object.keys(changes.removed).length > 0) {
    removedText = 'SESSIONS REMOVED:<br>\n';
    for (const [movie, times] of Object.entries(changes.removed)) {
      const timesList = Array.isArray(times) ? times : [times];
      removedText += `${movie}: ${timesList.join(', ')}<br>\n`;
    }
  }
  
  return {
    value1: addedText || 'No sessions added',
    value2: removedText || 'No sessions removed',
    value3: formatDateTime(timestamp)
  };
}

async function sendNotification(message) {
  const webhookUrl = process.env.IFTTT_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.error('IFTTT_WEBHOOK_URL not set');
    return;
  }
  
  try {
    await axios.post(webhookUrl, message);
    console.log('Notification sent successfully');
  } catch (error) {
    console.error('Error sending notification:', error.message);
  }
}

async function main() {
  console.log('Checking Thornbury Picture House...');
  
  const newData = await getAllShowtimes();
  const oldData = loadCache();
  
  const movieCount = Object.keys(newData).length;
  const showtimeCount = Object.values(newData).reduce((sum, times) => sum + times.length, 0);
  console.log(`Found ${movieCount} movies with ${showtimeCount} total showtimes`);
  
  const changes = detectChanges(oldData, newData);
  
  if (changes.changed) {
    console.log('Changes detected!');
    const message = formatMessage(changes, new Date().toISOString());
    console.log('Sending notification...');
    console.log(message);
    await sendNotification(message);
  } else {
    console.log('No changes detected');
  }
  
  saveCache(newData);
}

main();
