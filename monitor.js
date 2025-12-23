const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const puppeteer = require('puppeteer');

const URL = 'https://www.thornburypicturehouse.com.au/now-showing';
const CACHE_FILE = 'cache.json';

async function fetchPageWithBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    
    // Wait for content to load
    await page.waitForSelector('a[href*="/checkout/showing/"]', { timeout: 10000 });
    
    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

function parseShowtimesWithDates(html) {
  const $ = cheerio.load(html);
  const showtimeMap = {};
  
  // The page structure groups showtimes by date
  // Look for date headers and then the movies under each date
  let currentDate = null;
  
  $('body').find('*').each((i, el) => {
    const text = $(el).text().trim();
    
    // Check if this is a date header (e.g., "December 22", "December 23")
    const dateMatch = text.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})$/);
    if (dateMatch) {
      currentDate = text;
      return;
    }
    
    // If we have a current date and find a showtime link
    if (currentDate && $(el).is('a[href*="/checkout/showing/"]')) {
      const time = $(el).text().trim();
      const href = $(el).attr('href');
      
      if (time.match(/\d+:\d+(AM|PM)/i)) {
        // Extract movie name from URL
        const match = href.match(/\/showing\/([^\/]+)\//);
        if (match) {
          let movieSlug = match[1];
          let movieTitle = movieSlug
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
          
          movieTitle = movieTitle.replace(/\s(\d{4})$/, ' ($1)');
          
          if (!showtimeMap[movieTitle]) {
            showtimeMap[movieTitle] = [];
          }
          
          showtimeMap[movieTitle].push(`${currentDate} ${time}`);
        }
      }
    }
  });
  
  // Sort showtimes for each movie
  for (const movie in showtimeMap) {
    showtimeMap[movie] = showtimeMap[movie].sort();
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
  
  // Find added movies and showtimes
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
  
  // Find removed movies and showtimes
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
    addedText = 'SESSIONS ADDED:\n';
    for (const [movie, times] of Object.entries(changes.added)) {
      const timesList = Array.isArray(times) ? times : [times];
      addedText += `${movie}: ${timesList.join(', ')}\n`;
    }
  }
  
  let removedText = '';
  if (Object.keys(changes.removed).length > 0) {
    removedText = 'SESSIONS REMOVED:\n';
    for (const [movie, times] of Object.entries(changes.removed)) {
      const timesList = Array.isArray(times) ? times : [times];
      removedText += `${movie}: ${timesList.join(', ')}\n`;
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
  
  const html = await fetchPageWithBrowser();
  const newData = parseShowtimesWithDates(html);
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

main().catch(console.error);
