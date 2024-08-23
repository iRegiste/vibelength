/**
 * ---------------------------------------------------------------------------
 * VibeLength — server.js
 * LLM-driven Spotify playlist builder (seeds -> AI -> Spotify)
 * ---------------------------------------------------------------------------
 *
 * What this server does:
 * 1) Serves the static UI from /public.
 * 2) Implements Spotify OAuth (PKCE) and stores tokens in HTTP-only cookies.
 * 3) Exposes endpoints to search tracks, manage seed tracks, and build playlists.
 * 4) Uses an LLM to propose similar songs, then looks them up on Spotify,
 *    de-dupes, sorts (by popularity), and greedily packs to a target runtime.
 * 5) The final playlist now **starts with the seed songs**, then the AI picks.
 *
 * Notes:
 * - This file intentionally prefers readability + comments over brevity.
 * - Functionality mirrors your “simplified” model that worked for you.
 * - Requires env vars: SPOTIFY_CLIENT_ID, SPOTIFY_REDIRECT_URI, AI_API_KEY (and optional AI_MODEL).
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';

dotenv.config();

/* ===========================================================================
 *  CONFIG
 * ======================================================================== */

const CLIENT_ID    = (process.env.SPOTIFY_CLIENT_ID    ?? '').trim();
const REDIRECT_URI = (process.env.SPOTIFY_REDIRECT_URI ?? '').trim();
const PORT         = Number(process.env.PORT) || 5173;

console.log('[BOOT] CLIENT_ID length:', CLIENT_ID.length);
if (!CLIENT_ID)    console.error('[BOOT] Missing SPOTIFY_CLIENT_ID');
if (!REDIRECT_URI) console.error('[BOOT] Missing SPOTIFY_REDIRECT_URI');

/* ===========================================================================
 *  EXPRESS APP
 * ======================================================================== */

const app = express();
app.use(cookieParser()); // read/write cookies (access & refresh tokens, sessionId)
app.use(express.json()); // parse JSON request bodies

// Resolve __dirname in ESM:
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Serve the frontend app from /public
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ===========================================================================
 *  SPOTIFY AUTH HELPERS (PKCE)
 *  - We use Proof Key for Code Exchange to avoid storing a client secret.
 *  - Store the one-time "code_verifier" in memory keyed by a state value.
 * ======================================================================== */

const verifierStore = new Map(); // state -> code_verifier

/** Convert random bytes to URL-safe base64 (no padding). */
const base64url = (buf) =>
  buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

/** Generate a PKCE verifier/challenge pair (S256). */
function generatePKCE() {
  const codeVerifier  = base64url(crypto.randomBytes(64));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/** Random URL-safe state for CSRF protection. */
const randomState = () => base64url(crypto.randomBytes(16));

/* ===========================================================================
 *  ACCESS TOKEN REFRESH
 *  - Refresh Spotify access token using the refresh token in cookies.
 *  - Re-sets cookies with updated access token (and refresh if rotated).
 * ======================================================================== */

async function refreshAccessToken(req, res) {
  const rt = req.cookies?.refresh_token;
  if (!rt) throw new Error('No refresh_token cookie');

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: rt
  });

  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Refresh failed: ${text}`);
  }

  const json    = await resp.json();
  const access  = json.access_token;
  const maxAge  = Math.max(1, json.expires_in || 3600);    // seconds
  const newRT   = json.refresh_token;

  // Secure, HttpOnly cookies so they aren't accessible to JS in the browser.
  const cookies = [
    `access_token=${access}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
  ];
  if (newRT) cookies.push(`refresh_token=${newRT}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
  res.setHeader('Set-Cookie', cookies);

  return access;
}

/* ===========================================================================
 *  SPOTIFY FETCH WRAPPER (JSON + auto refresh)
 *  - Uses access_token cookie; if 401, refresh once and retry.
 *  - Throws an Error with status + body if Spotify returns non-2xx.
 * ======================================================================== */

async function spotifyFetchJSON(req, res, endpoint, init = {}) {
  init.headers = init.headers || {};
  let accessToken = req.cookies?.access_token;
  if (!accessToken) {
    const err = new Error('Not authenticated'); err.status = 401; throw err;
  }

  const run = async (token) => {
    const url = endpoint.startsWith('http') ? endpoint : `https://api.spotify.com${endpoint}`;
    return fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  };

  let resp = await run(accessToken);

  // If access token expired → refresh once → retry.
  if (resp.status === 401) {
    accessToken = await refreshAccessToken(req, res);
    resp = await run(accessToken);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(()=> '');
    const err = new Error(`Spotify error ${resp.status}`);
    err.status = resp.status;
    err.body   = text;
    throw err;
  }

  return resp.json();
}

const getMe = (req, res) => spotifyFetchJSON(req, res, '/v1/me');

/* ===========================================================================
 *  SEED STORAGE (in-memory by session cookie)
 *  - We store selected seed tracks per-session using a random sessionId cookie.
 *  - This is ephemeral; a proper app would persist to a DB keyed by user.
 * ======================================================================== */

const seedStore = new Map(); // sessionId -> [seeds]

/** Ensure a sessionId cookie exists; lazily initialize seed array. */
function getSessionId(req, res) {
  let sessionId = req.cookies?.sessionId;
  if (!sessionId) {
    sessionId = crypto.randomBytes(16).toString('hex');
    res.setHeader(
      'Set-Cookie',
      `sessionId=${sessionId}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
    );
  }
  if (!seedStore.has(sessionId)) seedStore.set(sessionId, []);
  return sessionId;
}

/** Normalize track fields we care about (for consistent payloads to the UI). */
function normalizeTrackFields(track) {
  return {
    id:          track.id,
    name:        track.name,
    artists:     Array.isArray(track.artists) ? track.artists.join(', ') : track.artists,
    duration_ms: track.duration_ms ?? null,
    image:       track.image ?? null,
    url:         track.url ?? null,
    popularity:  track.popularity ?? null
  };
}

/* ===========================================================================
 *  OPENAI (LLM) — simple chat wrapper
 *  - Returns model text, caller is responsible for parsing.
 * ======================================================================== */

if (!process.env.AI_API_KEY) {
  console.warn('[BOOT] AI_API_KEY is not set — /ai-build will fail until you add it.');
}

async function askLLM(systemPrompt, userPrompt) {
  const apiKey = process.env.AI_API_KEY;
  const model  = process.env.AI_MODEL || 'gpt-4o-mini';

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ],
      temperature: 0.4
    })
  });

  if (!resp.ok) throw new Error(`LLM error: ${await resp.text()}`);

  const json = await resp.json();
  return json.choices[0].message.content;
}

/* ===========================================================================
 *  RECOMMENDER HELPERS
 *  - Fuzzy best-match selection when searching candidate tracks on Spotify.
 *  - Greedy packing of tracks to match a target runtime within ±2 minutes.
 * ======================================================================== */

/** Lightweight string normalizer to improve title/artist matching. */
function simplify(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g,'')
    .trim();
}

/**
 * Pick the "best" search result by:
 * - exact or partial artist match (+2)
 * - exact or partial title match  (+2)
 * - small bonus for higher popularity
 */
function bestMatchFromSearchItems(items, wantTitle, wantArtist) {
  const t = simplify(wantTitle);
  const a = simplify(wantArtist);
  let best = null, bestScore = -1;

  for (const it of items) {
    const title   = simplify(it.name);
    const artists = (it.artists || []).map(x => simplify(x.name));

    const exactArtist = artists.includes(a);
    const titleHit    = title === t || title.includes(t) || t.includes(title);

    let score = 0;
    if (exactArtist) score += 2;
    if (titleHit)    score += 2;
    score += (it.popularity || 0) / 100; // tiny nudge toward well-known tracks

    if (score > bestScore) { best = it; bestScore = score; }
  }

  return best;
}

/**
 * Greedy packer to reach a target runtime within ±2 minutes.
 * - Skips ultra-short weird results (<15s).
 * - Preserves the original order provided by the candidates array.
 */
function packToTarget(tracks, targetMs) {
  const tolerance = 2 * 60 * 1000; // ± 2 min
  const minMs = targetMs - tolerance;
  const maxMs = targetMs + tolerance;

  const picked = [];
  let total = 0;

  for (const t of tracks) {
    const d = Number(t.duration_ms) || 0;
    if (d < 15000) continue;            // skip very short SFX/previews/etc
    if (total + d <= maxMs) {
      picked.push(t);
      total += d;
      if (total >= minMs) break;        // stop once we’re inside the window
    }
  }

  // Fallback: if nothing fit the window, at least return the first track.
  if (!picked.length && tracks.length) {
    picked.push(tracks[0]);
    total = Number(tracks[0].duration_ms) || 0;
  }

  return { tracks: picked, total_ms: total };
}

/* ===========================================================================
 *  ROUTES — AUTH
 * ======================================================================== */

/**
 * GET /login
 * 1) Generate PKCE verifier/challenge
 * 2) Redirect to Spotify authorize URL with S256 challenge + scopes
 */
app.get('/login', (req, res) => {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = randomState();
  verifierStore.set(state, codeVerifier); // keep verifier in memory for the callback

  const scopes = [
    'user-read-private', 'user-read-email',
    'playlist-modify-private', 'playlist-modify-public'
  ].join(' ');

  const params = new URLSearchParams({
    client_id:             CLIENT_ID,
    response_type:         'code',
    redirect_uri:          REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge:        codeChallenge,
    scope:                 scopes,
    state
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

/** POST /logout — Clear all auth/session cookies. */
app.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', [
    'access_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    'refresh_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    'sessionId=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
  ]);
  res.json({ ok: true });
});

/**
 * GET /callback
 * Spotify redirects here after user login.
 * Exchange the "code" for tokens using our saved PKCE verifier.
 */
app.get('/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) throw new Error(String(error));
    if (!code || !state) throw new Error('Missing code or state');

    const codeVerifier = verifierStore.get(state);
    if (!codeVerifier) throw new Error('Unknown or expired state');
    verifierStore.delete(state);

    const body = new URLSearchParams({
      client_id:     CLIENT_ID,
      grant_type:    'authorization_code',
      code:          String(code),
      redirect_uri:  REDIRECT_URI,
      code_verifier: codeVerifier
    });

    const tokenResp = await fetch('https://accounts.spotify.com/api/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!tokenResp.ok) throw new Error(await tokenResp.text());

    const tokens       = await tokenResp.json();
    const accessToken  = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const maxAge       = tokens.expires_in || 3600; // seconds

    // Write tokens to secure, httpOnly cookies
    res.setHeader('Set-Cookie', [
      `access_token=${accessToken}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
      refreshToken ? `refresh_token=${refreshToken}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` : ''
    ].filter(Boolean));

    res.redirect('/');
  } catch (e) {
    res.status(400).send(`Auth error: ${e.message || e}`);
  }
});

/**
 * GET /whoami
 * Returns minimal profile for UI header (display name + image).
 * If not authenticated, returns { ok: false }.
 */
app.get('/whoami', async (req, res) => {
  try {
    const me = await getMe(req, res);
    res.json({
      ok: true,
      id: me.id,
      display_name: me.display_name || me.id,
      image: Array.isArray(me.images) && me.images.length ? me.images[0].url : null
    });
  } catch {
    res.json({ ok: false });
  }
});

/* ===========================================================================
 *  ROUTES — SEARCH + SEEDS
 * ======================================================================== */

/**
 * GET /search-tracks?q=...
 * Thin wrapper over Spotify search (type=track, limit=5).
 * Requires user to be authenticated (uses their market from token).
 */
app.get('/search-tracks', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query parameter "q"' });

    const params = new URLSearchParams({ q, type: 'track', limit: '5', market: 'from_token' });
    const json   = await spotifyFetchJSON(req, res, `/v1/search?${params}`);

    const tracks = (json.tracks?.items || []).map(t => normalizeTrackFields({
      id:          t.id,
      name:        t.name,
      artists:     t.artists.map(a => a.name),
      duration_ms: t.duration_ms,
      image:       t.album?.images?.[0]?.url || null,
      url:         t.external_urls?.spotify || null,
      popularity:  t.popularity
    }));

    res.json({ tracks });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message || 'Internal error' });
  }
});

/** GET /seeds — return current session’s seed list. */
app.get('/seeds', (req, res) => {
  const sessionId = getSessionId(req, res);
  res.json({ seeds: seedStore.get(sessionId) || [] });
});

/**
 * POST /seeds
 * Body: { track: { id, name, artists, image?, url?, duration_ms?, popularity? } }
 * Adds a new seed (max 5, ignore duplicates).
 */
app.post('/seeds', (req, res) => {
  const sessionId = getSessionId(req, res);
  const list      = seedStore.get(sessionId);
  const { track } = req.body || {};

  if (!track || !track.id || !track.name || !track.artists) {
    return res.status(400).json({ error: 'Invalid track object' });
  }
  if (list.length >= 5) {
    return res.status(400).json({ error: 'Seed limit reached (5)' });
  }
  if (list.some(t => t.id === track.id)) {
    return res.json({ seeds: list }); // already present
  }

  list.push(normalizeTrackFields(track));
  res.json({ seeds: list });
});

/** DELETE /seeds/:id — remove one seed by track ID. */
app.delete('/seeds/:id', (req, res) => {
  const sessionId = getSessionId(req, res);
  const list  = seedStore.get(sessionId) || [];
  const after = list.filter(t => t.id !== req.params.id);

  seedStore.set(sessionId, after);
  res.json({ removed: list.length - after.length, seeds: after });
});

/** POST /seeds/clear — remove all seeds for this session. */
app.post('/seeds/clear', (req, res) => {
  const sessionId = getSessionId(req, res);
  seedStore.set(sessionId, []);
  res.json({ seeds: [] });
});

/* ===========================================================================
 *  ROUTE — AI BUILD
 *  High-level:
 *    1) Ask the LLM for similar tracks (title + artist) based on seeds + vibe.
 *    2) For each suggestion, search Spotify and pick the best match.
 *    3) De-dupe results, sort by popularity, and pack to target runtime.
 *    4) Prepend the seed songs to the final result the UI receives.
 * ======================================================================== */

app.post('/ai-build', async (req, res) => {
  try {
    const { minutes = 30, vibe = '' } = req.body || {};

    // Pull seeds from session.
    const sessionId = getSessionId(req, res);
    const seeds     = seedStore.get(sessionId) || [];
    if (!seeds.length) {
      return res.status(400).json({ error: 'Add at least one seed track first.' });
    }

    const targetMs = Math.max(5, Number(minutes)) * 60 * 1000;

    // (1) Ask the LLM for "similar songs" suggestions (JSON-only contract).
    const sys = `You are a music assistant. Return ONLY compact JSON:
{
  "suggestions": [
    { "title": "Song Title", "artist": "Artist Name" }
  ]
}
Max 30 suggestions. Prefer mainstream availability. No commentary.`;

    const seedText = seeds.map(s => `${s.name} — ${s.artists}`).join('; ');
    const user = `Seeds: ${seedText}
Vibe hint: ${vibe || '(none)'}
Return up to 30 song suggestions (title + artist) that fit the vibe and relate to the seeds. JSON only.`;

    const llmRaw = await askLLM(sys, user);

    // Parse defensively: try JSON first; if it fails, salvage "Title - Artist" lines.
    let suggestions = [];
    try {
      const parsed = JSON.parse(llmRaw);
      if (Array.isArray(parsed?.suggestions)) {
        suggestions = parsed.suggestions.slice(0, 30);
      }
    } catch {
      const lines = (llmRaw || '').split('\n').map(x => x.trim()).filter(Boolean);
      for (const line of lines) {
        const m = line.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (m) suggestions.push({ title: m[1].trim(), artist: m[2].trim() });
        if (suggestions.length >= 20) break; // stop early if we salvaged enough
      }
    }

    if (!suggestions.length) {
      return res.status(500).json({ error: 'AI returned no suggestions.' });
    }

    // (2) For each suggestion, search Spotify → pick best match.
    const found = [];
    for (const s of suggestions) {
      const q = `${s.title} ${s.artist}`.trim();
      const params = new URLSearchParams({ q, type: 'track', limit: '5', market: 'from_token' });

      try {
        const resp  = await spotifyFetchJSON(req, res, `/v1/search?${params}`);
        const items = resp.tracks?.items || [];
        const best  = bestMatchFromSearchItems(items, s.title, s.artist);

        if (best) {
          found.push(normalizeTrackFields({
            id:          best.id,
            name:        best.name,
            artists:     best.artists.map(a => a.name),
            duration_ms: best.duration_ms,
            image:       best.album?.images?.[0]?.url || null,
            url:         best.external_urls?.spotify || null,
            popularity:  best.popularity
          }));
        }
      } catch {
        // Ignore a single search error and try the next suggestion.
      }
    }

    // (3) De-dupe and remove any seed duplicates; sort by popularity DESC.
    const seen       = new Set();
    const seedIdSet  = new Set(seeds.map(s => s.id));
    const candidates = [];
    for (const t of found) {
      if (!t?.id) continue;
      if (seen.has(t.id)) continue;
      if (seedIdSet.has(t.id)) continue; // don't re-add seed tracks
      seen.add(t.id);
      candidates.push(t);
    }
    candidates.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    if (!candidates.length) {
      return res.status(500).json({ error: 'No Spotify matches for AI suggestions.' });
    }

    // Greedily pack tracks to reach the target runtime within ±2min.
    const pack = packToTarget(candidates, targetMs);

    // Prepend seeds to the front of the playlist for the UI.
    const finalTracks = [...seeds, ...pack.tracks];

    // Compute totals including seeds’ durations for accurate UI display.
    const seedMs = seeds.reduce((sum, s) => sum + (Number(s.duration_ms) || 0), 0);
    const totalMs = seedMs + pack.total_ms;

    // Respond with everything the UI needs to render/save.
    res.json({
      ok: true,
      vibe_used:       vibe,
      target_minutes:  Math.round(targetMs / 60000),
      total_ms:        totalMs,
      total_minutes:   Math.round(totalMs / 60000),
      seeds,
      tracks:          finalTracks
    });
  } catch (e) {
    console.error('[AI BUILD] Failed:', e);
    res.status(500).json({ error: 'AI build failed', detail: String(e.message || e) });
  }
});

/* ===========================================================================
 *  ROUTE — SAVE PLAYLIST
 *  Creates a new playlist in the user’s account and adds the chosen tracks.
 * ======================================================================== */

app.post('/save-playlist', async (req, res) => {
  try {
    const {
      name = 'VibeLength Playlist',
      tracks = [],              // array of track IDs (can be plain IDs or spotify:track: URIs)
      is_public = false,
      description = ''
    } = req.body || {};

    if (!Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ error: 'No tracks provided' });
    }

    // Identify the user (owner of the new playlist).
    const me     = await getMe(req, res);
    const userId = me.id;

    // (1) Create an empty playlist.
    const created = await spotifyFetchJSON(req, res, `/v1/users/${encodeURIComponent(userId)}/playlists`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name,
        public: !!is_public,
        description: description || 'Built with VibeLength'
      })
    });

    const playlistId = created.id;

    // (2) Add tracks in batches (Spotify API max 100 per request).
    const uris = tracks.map(id => id.startsWith('spotify:track:') ? id : `spotify:track:${id}`);
    for (let i = 0; i < uris.length; i += 100) {
      const slice = uris.slice(i, i + 100);
      await spotifyFetchJSON(req, res, `/v1/playlists/${playlistId}/tracks`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uris: slice })
      });
    }

    res.json({
      ok:   true,
      id:   playlistId,
      url:  created?.external_urls?.spotify || null,
      name: created?.name || name
    });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message || 'Failed to save playlist' });
  }
});

/* ===========================================================================
 *  START SERVER
 * ======================================================================== */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] Server running on port ${PORT}`);
});
