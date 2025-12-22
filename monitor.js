const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const URL = 'https://www.thornburypicturehouse.com.au/now-showing';
const CACHE_FILE = 'cache.json';

async function fetchPage() {
  try {
    const response = await axios.get(URL);
    return response.data;
  } catch (error) {
    console.error('Error fetching page:', error.message);
    return null;
  }
}

function parseShowtimes(html) {
  const $ = cheerio.load(html);
  const showtimeMap = {};
  
  // Find all showtime links - they have a specific pattern
  $('a[href*="/checkout/showing/"]').each((i, el) => {
    const time = $(el).text().trim();
    const href = $(el).attr('href');
    
    // Extract movie name from the URL
    const match = href.match(/\/showing\/([^\/]+)\//);
    if (match && time.match(/\d+:\d+(AM|PM)/)) {
      let movieSlug = match[1];
      // Convert slug to title case
      let movieTitle = movieSlug
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      
      // Handle year in parentheses
      movieTitle = movieTitle.replace(/\s(\d{4})$/, ' ($1)');
      
      if (!showtimeMap[movieTitle]) {
        showtimeMap[movieTitle] = [];
      }
      showtimeMap[movieTitle].push(time);
    }
  });
  
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
  
  // Find added movies and showtimes
  for (const [movie, times] of Object.entries(newData)) {
    if (!oldData[movie]) {
      // Entirely new movie
      added[movie] = times;
    } else {
      // Check for new showtimes for existing movie
      const newTimes = times.filter(t => !oldData[movie].includes(t));
      if (newTimes.length > 0) {
        added[movie] = newTimes;
      }
    }
  }
  
  // Find removed movies and showtimes
  for (const [movie, times] of Object.entries(oldData)) {
    if (!newData[movie]) {
      // Movie removed entirely
      removed[movie] = times;
    } else {
      // Check for removed showtimes
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
    addedText = 'SESSIONS ADDED:\n';
    for (const [movie, times] of Object.entries(changes.added)) {
      addedText += `${movie}: ${times.join(', ')}\n`;
    }
  }
  
  let removedText = '';
  if (Object.keys(changes.removed).length > 0) {
    removedText = 'SESSIONS REMOVED:\n';
    for (const [movie, times] of Object.entries(changes.removed)) {
      removedText += `${movie}: ${times.join(', ')}\n`;
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
  
  const html = await fetchPage();
  if (!html) {
    console.error('Failed to fetch page');
    return;
  }
  
  const newData = parseShowtimes(html);
  const oldData = loadCache();
  
  const movieCount = Object.keys(newData).length;
  const showtimeCount = Object.values(newData).reduce((sum, times) => sum + times.length, 0);
  console.log(`Found ${movieCount} movies with ${showtimeCount} showtimes`);
  
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
