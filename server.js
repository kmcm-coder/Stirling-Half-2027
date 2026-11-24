import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Maps configuration endpoint (reads API key from environment; never hardcoded)
app.get('/api/maps-config', (req, res) => {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    process.env.MAPS_API_KEY ||
    '';
  res.setHeader('Cache-Control', 'no-store');
  res.json({ apiKey, configured: Boolean(apiKey) });
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
