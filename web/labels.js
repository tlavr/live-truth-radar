// Display labels: topic slugs and platform ids stay as they are in the data and URLs,
// the page shows them with proper capitals ("jensen-huang-resignation" -> "Jensen Huang resignation").

const WORDS = Object.fromEntries([
  // acronyms
  'AI', 'AP', 'BBC', 'CEO', 'CIA', 'CNN', 'COVID', 'ECB', 'EU', 'FBI', 'G7', 'G20', 'IMF', 'NATO', 'NHS', 'UK', 'UN', 'US', 'USA', 'WHO', 'YLE',
  // places and peoples
  'Africa', 'America', 'American', 'Baltic', 'Beijing', 'Berlin', 'Brussels', 'China', 'Chinese', 'Denmark', 'Espoo', 'Estonia',
  'Europe', 'European', 'Finland', 'Finnish', 'France', 'French', 'Gaza', 'Germany', 'German', 'Helsinki', 'India', 'Iran',
  'Israel', 'Japan', 'Kyiv', 'London', 'Moscow', 'Norway', 'Paris', 'Poland', 'Russia', 'Russian', 'Sweden', 'Swedish',
  'Taiwan', 'Tallinn', 'Tampere', 'Turku', 'Ukraine', 'Ukrainian', 'Washington',
  // people
  'Biden', 'Elon', 'Harris', 'Huang', 'Jensen', 'Macron', 'Musk', 'Putin', 'Stubb', 'Trump', 'Zelensky', 'Zelenskyy',
  // companies and products
  'Amazon', 'Apple', 'ChatGPT', 'Gemini', 'Google', 'Hostinger', 'Meta', 'Microsoft', 'Nokia', 'Nvidia', 'OpenAI',
  'Reddit', 'Tesla', 'TikTok', 'Telegram', 'Windows', 'YouTube',
].map(w => [w.toLowerCase(), w]));

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

export function topicLabel(slug) {
  const words = String(slug ?? '').split(/[-_\s]+/).filter(Boolean).map(w => WORDS[w.toLowerCase()] ?? w.toLowerCase());
  return words.length ? cap(words.join(' ')) : '';
}

const PLATFORMS = {x: 'X', reddit: 'Reddit', news: 'News', bluesky: 'Bluesky', mastodon: 'Mastodon', telegram: 'Telegram', youtube: 'YouTube'};
export const platformLabel = p => PLATFORMS[String(p ?? '').toLowerCase()] ?? cap(String(p ?? ''));
