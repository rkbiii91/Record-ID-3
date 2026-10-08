require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json({ limit: '12mb' })); // photos as base64 can be a few MB
app.use(express.static(path.join(__dirname, 'public')));

const {
  ANTHROPIC_API_KEY,
  DISCOGS_TOKEN,
  DISCOGS_USER_AGENT = 'VinylIDApp/1.0',
  PORT = 3000
} = process.env;

if (!ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY is not set in .env');
if (!DISCOGS_TOKEN) console.warn('WARNING: DISCOGS_TOKEN is not set in .env');

// ---------- Step 1: identify the record from a photo ----------
app.post('/api/identify', async (req, res) => {
  try {
    const { image } = req.body; // data URL, e.g. "data:image/jpeg;base64,...."
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Image must be a base64 data URL' });
    const [, mediaType, base64Data] = match;

    const prompt = `You are looking at a photo of a vinyl record label (and possibly the runout/deadwax area etched near the center hole).
Extract what you can see and respond with ONLY raw JSON, no markdown fences, no commentary, in exactly this shape:
{
  "artist": "string or null",
  "release_title": "string or null — the album or single title, ONLY if printed as its own distinct heading separate from individual song names",
  "track_titles": ["array of individual song titles visible on THIS label — usually just one for a 45 single's side, or several for an LP side's tracklist. Empty array if none are legible."],
  "label_name": "string or null — the record label/company name, e.g. Motown, Columbia",
  "catalog_number": "string or null — the printed catalog/release number on the label",
  "matrix_runout": "string or null",
  "year": "string or null — ONLY if an actual year is printed on the label itself, not a guess",
  "confidence_notes": "one short sentence about what you're unsure of, especially runout/matrix text which is often hard to read"
}
If a field truly isn't visible or legible, use null (or [] for track_titles). Do not guess catalog numbers, matrix numbers, or years you can't actually read — it's fine to say you're not confident.`;

    async function callVision() {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 500,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
                { type: 'text', text: prompt }
              ]
            }
          ]
        })
      });

      const data = await anthropicRes.json();

      // Log the FULL response on any non-200 so Render's logs show the real reason
      // (bad API key, rate limit, invalid model name, etc.) instead of a guess.
      if (!anthropicRes.ok) {
        console.error('Anthropic API returned an error. Status:', anthropicRes.status, 'Body:', JSON.stringify(data));
        const err = new Error(data?.error?.message || 'Vision API request failed');
        err.detail = data;
        err.status = 502;
        throw err;
      }

      const textBlock = (data.content || []).find(b => b.type === 'text');
      const rawText = textBlock?.text || '';

      // Pull out the first {...} block rather than assuming the whole reply is
      // pure JSON — tolerates the model adding a stray word or markdown fence
      // despite instructions not to.
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('No JSON object found in model response. Full text was:', rawText);
        const err = new Error('Response contained no JSON');
        throw err;
      }

      try {
        return JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.error('JSON.parse failed on extracted text:', jsonMatch[0]);
        throw parseErr;
      }
    }

    let extracted;
    try {
      extracted = await callVision();
    } catch (e) {
      console.error('First identify attempt failed:', e.message);
      // One retry — handles transient/odd-formatted responses without failing the whole request
      try {
        extracted = await callVision();
      } catch (e2) {
        console.error('Second identify attempt also failed:', e2.message, e2.detail ? JSON.stringify(e2.detail) : '');
        return res.status(502).json({
          error: e2.message || 'Could not read the label from this photo',
          stage: 'identify'
        });
      }
    }

    res.json(extracted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error identifying record' });
  }
});

// ---------- Shared helper: full release info + marketplace stats + videos ----------
async function getReleaseDetails(id) {
  const headers = { 'User-Agent': DISCOGS_USER_AGENT };

  const releaseRes = await fetch(
    `https://api.discogs.com/releases/${id}?token=${DISCOGS_TOKEN}`,
    { headers }
  );
  const release = await releaseRes.json();
  if (!releaseRes.ok) {
    const err = new Error('Discogs release error');
    err.detail = release;
    err.status = 502;
    throw err;
  }

  let marketplace = { lowest_price: null, currency: null, num_for_sale: 0 };
  try {
    const statsRes = await fetch(
      `https://api.discogs.com/marketplace/stats/${id}?token=${DISCOGS_TOKEN}`,
      { headers }
    );
    if (statsRes.ok) {
      const stats = await statsRes.json();
      marketplace = {
        lowest_price: stats.lowest_price?.value ?? null,
        currency: stats.lowest_price?.currency ?? null,
        num_for_sale: stats.num_for_sale ?? 0
      };
    }
  } catch (e) {
    console.warn('Marketplace stats unavailable for release', id);
  }

  // Price Suggestions: Discogs' own suggested value per condition grade (Mint, NM,
  // VG+, VG, Good, Fair, Poor) — a real, authenticated API endpoint. This is NOT the
  // same thing as the site's historical Low/Median/High sold-price stats (those have
  // no API — see sell_history_url below), so we keep it clearly labeled as suggestions.
  let priceSuggestions = [];
  try {
    const suggRes = await fetch(
      `https://api.discogs.com/marketplace/price_suggestions/${id}?token=${DISCOGS_TOKEN}`,
      { headers }
    );
    if (suggRes.ok) {
      const suggData = await suggRes.json();
      priceSuggestions = Object.entries(suggData || {}).map(([condition, info]) => ({
        condition,
        price: info?.value ?? null,
        currency: info?.currency ?? null
      }));
    }
  } catch (e) {
    console.warn('Price suggestions unavailable for release', id);
  }

  // Have/Want/Rating ARE in the official API's release resource (release.community).
  // Low/Median/High/Last-Sold are NOT — those only exist as rendered HTML on Discogs'
  // own /sell/history/ page, so we link to it instead of fabricating/scraping it.
  const community = {
    have: release.community?.have ?? null,
    want: release.community?.want ?? null,
    rating_average: release.community?.rating?.average ?? null,
    rating_count: release.community?.rating?.count ?? null
  };

  return {
    artist: (release.artists || []).map(a => a.name).join(', '),
    title: release.title,
    label: (release.labels || []).map(l => l.name).join(', '),
    year: release.year,
    catalog_number: (release.labels || []).map(l => l.catno).join(', '),
    tracklist: (release.tracklist || []).map(t => ({ position: t.position, title: t.title, duration: t.duration })),
    genres: release.genres,
    styles: release.styles,
    images: (release.images || []).map(i => i.uri),
    community,
    price_suggestions: priceSuggestions,
    marketplace: {
      ...marketplace,
      marketplace_url: `https://www.discogs.com/sell/release/${id}`,
      sell_history_url: `https://www.discogs.com/sell/history/${id}`,
      stats_url: `https://www.discogs.com/release/stats/${id}`
    },
    videos: (release.videos || []).map(v => ({ title: v.title, url: v.uri })),
    discogs_release_url: release.uri || `https://www.discogs.com/release/${id}`
  };
}

// ---------- Search Discogs for candidate releases (kept for flexibility) ----------
app.get('/api/discogs-search', async (req, res) => {
  try {
    const { q, artist, catno, title } = req.query;
    const params = new URLSearchParams({ type: 'release', token: DISCOGS_TOKEN });
    if (q) params.set('q', q);
    if (artist) params.set('artist', artist);
    if (catno) params.set('catno', catno);
    if (title) params.set('release_title', title);

    const url = `https://api.discogs.com/database/search?${params.toString()}`;
    const dRes = await fetch(url, { headers: { 'User-Agent': DISCOGS_USER_AGENT } });
    const data = await dRes.json();
    if (!dRes.ok) return res.status(502).json({ error: 'Discogs search error', detail: data });

    const results = (data.results || []).slice(0, 10).map(r => ({
      id: r.id,
      title: r.title,
      year: r.year,
      catno: r.catno,
      format: r.format,
      label: r.label,
      thumb: r.thumb,
      discogs_url: `https://www.discogs.com${r.uri || ''}`
    }));

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error searching Discogs' });
  }
});

// ---------- Full release info by id (kept for flexibility) ----------
app.get('/api/discogs-release/:id', async (req, res) => {
  try {
    const details = await getReleaseDetails(req.params.id);
    res.json(details);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error fetching release details', detail: err.detail });
  }
});

// Run one Discogs search attempt. Uses a single free-text "q" param (not strict
// field filters like artist=/release_title=/catno= combined, which Discogs ANDs
// together — one imperfectly-read field then zeroes out the whole search).
async function tryDiscogsSearch(query) {
  const params = new URLSearchParams({ type: 'release', format: 'Vinyl', token: DISCOGS_TOKEN, q: query });
  const searchUrl = `https://api.discogs.com/database/search?${params.toString()}`;
  const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': DISCOGS_USER_AGENT } });
  const searchData = await searchRes.json();
  if (!searchRes.ok) {
    const err = new Error('Discogs search error');
    err.detail = searchData;
    err.status = 502;
    throw err;
  }
  return searchData.results || [];
}

// Score a raw Discogs search result against what we read off the label, so that
// once a search attempt returns candidates, we pick the BEST one rather than
// just the first one Discogs happened to rank highest for that query alone.
function scoreCandidate(c, { artist, year, formatGuess }) {
  let score = 0;
  if (year && String(c.year) === String(year)) score += 3;
  if (artist && c.title && c.title.toLowerCase().includes(String(artist).toLowerCase())) score += 2;
  if (formatGuess && Array.isArray(c.format)) {
    const fmtStr = c.format.join(' ').toLowerCase();
    if (formatGuess === 'single' && /7"|single|45 ?rpm/.test(fmtStr)) score += 2;
    if (formatGuess === 'album' && /\blp\b|album|12"/.test(fmtStr)) score += 2;
  }
  return score;
}

// ---------- One-shot: search (priority-ordered fallbacks), pick best match, return full details ----------
app.get('/api/auto-lookup', async (req, res) => {
  try {
    const { artist, title, catno, year, format } = req.query; // format: "single" | "album" | ""
    if (!artist && !title && !catno) {
      return res.status(400).json({ error: 'No search terms provided' });
    }

    // Priority order: catalog number first (most unique identifier), then
    // catalog+artist together (catalog numbers do get reused across reissues/
    // countries, so pairing helps land on the right one), then artist+title,
    // then artist alone, then title alone. Each is one free-text query — not
    // strict separate field filters, which Discogs ANDs together and can zero
    // out a search over one imperfectly-read field.
    const attempts = [];
    if (catno) attempts.push(catno);
    if (catno && artist) attempts.push(`${catno} ${artist}`);
    if (artist && title) attempts.push(`${artist} ${title}`);
    if (artist) attempts.push(artist);
    if (title) attempts.push(title);

    let results = [];
    for (const q of attempts) {
      try {
        results = await tryDiscogsSearch(q);
      } catch (e) {
        results = [];
      }
      if (results.length) break;
    }

    if (!results.length) {
      return res.status(404).json({ error: 'No matching release found on Discogs', stage: 'lookup' });
    }

    // Re-rank whatever this attempt returned using year/artist/format as
    // tie-breakers — never reduces the candidate pool, so a result is still
    // guaranteed whenever `results` is non-empty.
    const ranked = [...results].sort(
      (a, b) => scoreCandidate(b, { artist, year, formatGuess: format }) - scoreCandidate(a, { artist, year, formatGuess: format })
    );
    const topMatch = ranked[0];

    const details = await getReleaseDetails(topMatch.id);
    res.json(details);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error during lookup', detail: err.detail });
  }
});

app.listen(PORT, () => console.log(`Vinyl ID app running on port ${PORT}`));
