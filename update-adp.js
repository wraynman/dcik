#!/usr/bin/env node
/**
 * update-adp.js — DCIK Daily ADP Updater
 *
 * Fetches latest FantasyPros 2026 Rookie ADP & Dynasty Overall ADP,
 * then patches the rookieAdp / overallAdp values inside NFL_2026 in index.html.
 *
 * Usage:   node update-adp.js
 * Quiet:   node update-adp.js --quiet
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const QUIET = process.argv.includes('--quiet');
const INDEX = path.resolve(__dirname, 'index.html');
const TODAY = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

const log = (...a) => { if (!QUIET) console.log(...a); };

// ─────────────────────────────────────────────────────────────────────
// Name normaliser — MUST match norm() in index.html
// ─────────────────────────────────────────────────────────────────────
function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(jr|sr|ii|iii|iv|v)\s*$/, '')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────
// HTTP GET with redirect following
// ─────────────────────────────────────────────────────────────────────
function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('Too many redirects'));
    const req = https.get(url, {
      headers: {
        'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept'          : 'text/html,application/xhtml+xml',
        'Accept-Language' : 'en-US,en;q=0.9',
        'Accept-Encoding' : 'identity',   // avoid compressed responses
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location, hops + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Parse FantasyPros ADP page → Map<norm(name), adp (float)>
// ─────────────────────────────────────────────────────────────────────
function parseAdpMap(html) {
  const map = new Map();

  // Strategy 1: embedded JSON (FP sometimes puts data in a script block)
  const jsonPats = [
    /var\s+ecrData\s*=\s*(\{[\s\S]+?\})\s*;/,
    /window\.ecrData\s*=\s*(\{[\s\S]+?\})\s*;/,
    /"players"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
  ];
  for (const pat of jsonPats) {
    const m = html.match(pat);
    if (!m) continue;
    try {
      const raw = m[1].startsWith('[') ? JSON.parse(m[1]) : JSON.parse(m[1]).players;
      if (Array.isArray(raw) && raw.length > 0) {
        for (const p of raw) {
          const name = norm(p.player_name || p.name || '');
          const adp  = parseFloat(p.avg || p.adp || '');
          if (name && !isNaN(adp)) map.set(name, adp);
        }
        if (map.size > 10) return map;   // looks legit
      }
    } catch (_) {}
  }

  // Strategy 2: scan every table row for a player link + a trailing ADP number
  // FantasyPros markup: <a href="/nfl/players/...">Player Name</a>
  const rowRe  = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const nameRe = /href="[^"]*\/nfl\/players\/[^"]*"[^>]*>\s*([^<]+)/i;
  const tdRe   = /<td[^>]*>([\d.]+)<\/td>/g;

  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const nameM   = rowHtml.match(nameRe);
    if (!nameM) continue;

    const name = norm(nameM[1]);
    if (!name) continue;

    // Collect all numeric <td> values; ADP is usually the last one
    const nums = [];
    let tdMatch;
    const tdReCopy = /<td[^>]*>([\d.]+)<\/td>/g;
    while ((tdMatch = tdReCopy.exec(rowHtml)) !== null) nums.push(parseFloat(tdMatch[1]));

    const adp = nums[nums.length - 1];
    if (adp != null && !isNaN(adp)) map.set(name, adp);
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────────
// Parse dynasty overall ADP → Map<norm(name), rank (int)>
// ─────────────────────────────────────────────────────────────────────
function parseOverallMap(html) {
  const map  = new Map();
  const rowRe  = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const nameRe = /href="[^"]*\/nfl\/players\/[^"]*"[^>]*>\s*([^<]+)/i;

  let rank = 0;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (/<th\b/i.test(rowHtml)) continue;   // skip header rows

    const nameM = rowHtml.match(nameRe);
    if (!nameM) continue;

    // Use explicit rank cell if present, else increment counter
    const rankM = rowHtml.match(/^<td[^>]*>(\d+)<\/td>/);
    rank = rankM ? parseInt(rankM[1], 10) : rank + 1;

    const name = norm(nameM[1]);
    if (name && !map.has(name)) map.set(name, rank);
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────────
// Patch a single line of the NFL_2026 array
// Returns { line, rookieChanged, overallChanged }
// ─────────────────────────────────────────────────────────────────────
function patchLine(line, rookieMap, overallMap) {
  const nameM = line.match(/name:"([^"]+)"/);
  if (!nameM) return { line, rookieChanged: false, overallChanged: false };

  const key = norm(nameM[1]);
  let out = line;
  let rookieChanged = false, overallChanged = false;

  const newRookie = rookieMap.get(key);
  if (newRookie != null) {
    const before = out;
    out = out.replace(/rookieAdp:([\d.]+|null)/, `rookieAdp:${newRookie}`);
    rookieChanged = out !== before;
  }

  const newOverall = overallMap.get(key);
  if (newOverall != null) {
    const before = out;
    out = out.replace(/overallAdp:([\d.]+|null)/, `overallAdp:${newOverall}`);
    overallChanged = out !== before;
  }

  return { line: out, rookieChanged, overallChanged };
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────
async function main() {
  log('📡 Fetching FantasyPros ADP data…');

  const [rookieHtml, overallHtml] = await Promise.all([
    get('https://www.fantasypros.com/nfl/adp/rookies.php?year=2026'),
    get('https://www.fantasypros.com/nfl/adp/dynasty-overall.php'),
  ]);

  const rookieMap  = parseAdpMap(rookieHtml);
  const overallMap = parseOverallMap(overallHtml);

  log(`   Rookie ADP entries found : ${rookieMap.size}`);
  log(`   Overall ADP entries found: ${overallMap.size}`);

  if (rookieMap.size < 5) {
    console.error('❌ Rookie ADP parse returned too few results — FantasyPros HTML may have changed.');
    process.exit(1);
  }

  // Patch index.html line by line
  const src   = fs.readFileSync(INDEX, 'utf8');
  const lines = src.split('\n');

  let rookieUpdates = 0, overallUpdates = 0;
  const patched = lines.map(line => {
    const { line: newLine, rookieChanged, overallChanged } = patchLine(line, rookieMap, overallMap);
    if (rookieChanged)  rookieUpdates++;
    if (overallChanged) overallUpdates++;
    return newLine;
  });

  // Update the date comment above the NFL_2026 array
  const result = patched.join('\n')
    .replace(
      /(ADP: FantasyPros consensus[^·\n]* · )[^\n]*/,
      `$1${TODAY}`
    )
    .replace(
      /(ADP source: FantasyPros consensus[^·<\n]* · )[^\n<]*/,
      `$1${TODAY}`
    );

  fs.writeFileSync(INDEX, result, 'utf8');

  log(`\n✅ Done!`);
  log(`   rookieAdp  updated: ${rookieUpdates} players`);
  log(`   overallAdp updated: ${overallUpdates} players`);
  log(`   Date stamp → ${TODAY}`);
  log(`   File: ${INDEX}`);

  if (rookieUpdates === 0) {
    console.warn('⚠️  No rookieAdp values changed. Check that player names still match FantasyPros.');
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
