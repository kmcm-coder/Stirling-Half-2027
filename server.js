import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

function getMapsApiKey() {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    process.env.MAPS_API_KEY ||
    ''
  );
}

// Ephemeral in-memory loop polyline cache (max 24h TTL, well within ToS limits)
const LOOP_ROUTE_CACHE = new Map();
const LOOP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCachedLoop(key) {
  const entry = LOOP_ROUTE_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > LOOP_CACHE_TTL_MS) {
    LOOP_ROUTE_CACHE.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedLoop(key, data) {
  if (LOOP_ROUTE_CACHE.size >= 100) {
    const oldest = LOOP_ROUTE_CACHE.keys().next().value;
    LOOP_ROUTE_CACHE.delete(oldest);
  }
  LOOP_ROUTE_CACHE.set(key, { ts: Date.now(), data });
}

// Maps configuration endpoint (reads API key from environment; never hardcoded)
app.get('/api/maps-config', (req, res) => {
  const apiKey = getMapsApiKey();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ apiKey, configured: Boolean(apiKey) });
});

// Server-side Static Loop Map image endpoint (Routes API + Maps Static API)
app.get('/api/static-map', async (req, res) => {
  const apiKey = getMapsApiKey();
  if (!apiKey) {
    return res.status(503).json({ error: 'NO_API_KEY_CONFIGURED' });
  }

  let stops = [];
  try {
    const rawStops = String(req.query.stops || '');
    stops = rawStops
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 180)
      .slice(0, 8);
  } catch {
    return res.status(400).json({ error: 'INVALID_STOPS' });
  }

  if (stops.length < 2) {
    return res.status(400).json({ error: 'MIN_TWO_STOPS_REQUIRED' });
  }

  const maptype = req.query.maptype === 'terrain' ? 'terrain' : 'roadmap';
  const cacheKey = stops.join('|');
  let loopData = getCachedLoop(cacheKey);
  let quotaHit = false;

  if (!loopData) {
    try {
      const rtRes = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline'
        },
        body: JSON.stringify({
          origin: { address: stops[0] },
          destination: { address: stops[stops.length - 1] },
          intermediates: stops.slice(1, -1).map((address) => ({ address })),
          travelMode: 'WALK',
          languageCode: 'en-GB',
          regionCode: 'GB'
        })
      });

      if (rtRes.status === 429) {
        quotaHit = true;
      } else if (rtRes.ok) {
        const rtJson = await rtRes.json();
        const route = rtJson?.routes?.[0];
        if (route?.polyline?.encodedPolyline) {
          loopData = {
            encodedPolyline: route.polyline.encodedPolyline,
            distanceMeters: Number(route.distanceMeters || 0),
            duration: String(route.duration || '')
          };
          setCachedLoop(cacheKey, loopData);
        }
      }
    } catch {
      // Fall back to direct waypoint path on Static Map
    }
  }

  if (quotaHit) {
    return res.status(429).json({ error: 'QUOTA_EXCEEDED', quotaExceeded: true });
  }

  const params = new URLSearchParams({
    size: '640x360',
    scale: '2',
    maptype,
    key: apiKey,
    solution_id: 'gmp_mcp_codeassist_v1_aistudio'
  });

  if (loopData?.encodedPolyline) {
    params.append('path', `color:0x0B3B24FF|weight:5|enc:${loopData.encodedPolyline}`);
  } else {
    params.append('path', `color:0x0B3B24FF|weight:5|${stops.join('|')}`);
  }

  // Car Park Start/Finish pin (P) + mid-loop checkpoints (1, 2, 3...)
  params.append('markers', `color:0x0B3B24|label:P|${stops[0]}`);
  const midStops = stops[0].toLowerCase() === stops[stops.length - 1].toLowerCase()
    ? stops.slice(1, -1)
    : stops.slice(1);
  midStops.slice(0, 6).forEach((s, idx) => {
    params.append('markers', `size:mid|color:0xB87A14|label:${idx + 1}|${s}`);
  });

  try {
    const smRes = await fetch(`https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`);
    if (smRes.status === 429 || smRes.status === 403) {
      return res.status(429).json({ error: 'STATIC_MAP_QUOTA_OR_AUTH', quotaExceeded: true });
    }
    if (!smRes.ok) {
      return res.status(502).json({ error: 'STATIC_MAP_UNAVAILABLE' });
    }
    const contentType = smRes.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) {
      return res.status(502).json({ error: 'INVALID_STATIC_MAP_RESPONSE' });
    }
    const buf = Buffer.from(await smRes.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (loopData?.distanceMeters) {
      res.setHeader('X-Loop-Meters', String(loopData.distanceMeters));
    }
    if (loopData?.duration) {
      res.setHeader('X-Loop-Duration', loopData.duration);
    }
    return res.send(buf);
  } catch {
    return res.status(502).json({ error: 'STATIC_MAP_FETCH_FAILED' });
  }
});

// Serve static assets from project root
app.use(express.static(__dirname));

// Also route /icons to root so references like icons/favicon.png resolve properly
app.use('/icons', express.static(__dirname));

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
