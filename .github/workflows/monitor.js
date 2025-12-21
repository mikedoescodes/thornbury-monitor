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

function parseMovies(html) {
  const $ = cheerio.load(html);
  const movies = [];
  const showtimes = [];
  
  // Extract current movies
  $('a[href*="/movie/"]').each((i, el) => {
    const title = $(el).text().trim();
    if (title && !movies.includes(title)) {
      movies.push(title);
    }
  });
  
  // Extract showtimes (movie + time pairs)
  const showtimeSection = $('body').text();
  const showtimeMatches = showtimeSection.match(/([A-Z][^|]+)\s*\|\s*(\d+:\d+(?:AM|PM))/g);
  if (showtimeMatches) {
    showtimeMatches.forEach(match => {
      showtimes.push(match.trim());
    });
  }
  
  return {
    movies: movies.sort(),
    showtimes: showtimes.sort(),
    timestamp: new Date().toISOString()
  };
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

function detectChanges(oldData, newData) {
  if (!oldData) {
    return {
      changed: true,
      movieChanges: `Initial check: ${newData.movies.length} movies found`,
      showtimeChanges: `${newData.showtimes.length} showtimes found`
    };
  }
  
  const movieChanges = [];
  const showtimeChanges = [];
  
  // Check for new or removed movies
  const addedMovies = newData.movies.filter(m => !oldData.movies.includes(m));
  const removedMovies = oldData.movies.filter(m => !newData.movies.includes(m));
  
  if (addedMovies.length > 0) {
    movieChanges.push(`Added: ${addedMovies.join(', ')}`);
  }
  if (removedMovies.length > 0) {
    movieChanges.push(`Removed: ${removedMovies.join(', ')}`);
  }
  
  // Check for showtime changes
  const addedShowtimes = newData.showtimes.filter(s => !oldData.showtimes.includes(s));
  const removedShowtimes = oldData.showtimes.filter(s => !newData.showtimes.includes(s));
  
  if (addedShowtimes.length > 0) {
    showtimeChanges.push(`Added: ${addedShowtimes.join(', ')}`);
  }
  if (removedShowtimes.length > 0) {
    showtimeChanges.push(`Removed: ${removedShowtimes.join(', ')}`);
  }
  
  const changed = movieChanges.length > 0 || showtimeChanges.length > 0;
  
  return {
    changed,
    movieChanges: movieChanges.length > 0 ? movieChanges.join(' | ') : 'No changes',
    showtimeChanges: showtimeChanges.length > 0 ? showtimeChanges.join(' | ') : 'No changes'
  };
}

async function sendNotification(changes, timestamp) {
  const webhookUrl = process.env.IFTTT_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.error('IFTTT_WEBHOOK_URL not set');
    return;
  }
  
  try {
    await axios.post(webhookUrl, {
      value1: changes.movieChanges,
      value2: changes.showtimeChanges,
      value3: timestamp
    });
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
  
  const newData = parseMovies(html);
  const oldData = loadCache();
  
  console.log(`Found ${newData.movies.length} movies and ${newData.showtimes.length} showtimes`);
  
  const changes = detectChanges(oldData, newData);
  
  if (changes.changed) {
    console.log('Changes detected!');
    console.log('Movie changes:', changes.movieChanges);
    console.log('Showtime changes:', changes.showtimeChanges);
    await sendNotification(changes, newData.timestamp);
  } else {
    console.log('No changes detected');
  }
  
  saveCache(newData);
}

main();
