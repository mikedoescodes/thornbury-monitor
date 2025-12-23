const axios = require('axios');
const fs = require('fs');

const GRAPHQL_URL = 'https://www.thornburypicturehouse.com.au/graphql';
const SITE_ID = 12;
const CACHE_FILE = 'cache.json';

const GRAPHQL_QUERY = `
query ($siteIds: [ID]) {
  showingsForDate(siteIds: $siteIds) {
    data {
      id
      time
      movie {
        id
        name
      }
    }
  }
}
`;

async function getAllShowtimes() {
  try {
    const response = await axios.post(GRAPHQL_URL, {
      query: GRAPHQL_QUERY,
      variables: {
        siteIds: [SITE_ID],
        date: null
      }
    });

    const showings = response.data.data.showingsForDate.data;
    const showtimeMap = {};

    for (const showing of showings) {
      const movieName = showing.movie.name;
      const time = new Date(showing.time);
      
      // Format: "December 23 6:10 pm"
      const dateStr = time.toLocaleDateString('en-US', { 
        month: 'long', 
        day: 'numeric',
        timeZone: 'Australia/Melbourne'
      });
      const timeStr = time.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        timeZone: 'Australia/Melbourne'
      }).toLowerCase();
      
      const formattedTime = `${dateStr} ${timeStr}`;
      
      if (!showtimeMap[movieName]) {
        showtimeMap[movieName] = [];
      }
      showtimeMap[movieName].push(formattedTime);
    }

    // Sort showtimes for each movie
    for (const movie in showtimeMap) {
      showtimeMap[movie] = showtimeMap[movie].sort();
    }

    return showtimeMap;
  } catch (error) {
    console.error('Error fetching showtimes:', error.message);
    return {};
  }
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
  return date.toLocaleString('en-AU', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric', 
    hour: 'numeric', 
    minute: '2-digit',
    timeZone: 'Australia/Melbourne',
    timeZoneName: 'short'
  });
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
