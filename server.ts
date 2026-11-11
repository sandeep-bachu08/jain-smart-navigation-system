import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

function parseTimeToMinutes(t: string | undefined | null): number {
  if (!t) return 0;
  const str = t.trim();
  const match = str.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return 0;
  let h = parseInt(match[1], 10);
  const m = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = (match[3] || '').toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  if (!ampm && h >= 1 && h <= 6) {
    h += 12;
  }
  return h * 60 + m;
}

function minutesToTimeString(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const h24 = Math.floor(normalized / 60);
  const m = normalized % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  const hStr = h12 < 10 ? `0${h12}` : `${h12}`;
  const mStr = m < 10 ? `0${m}` : `${m}`;
  return `${hStr}:${mStr} ${ampm}`;
}

function parseLocalNaturalLanguageQuery(
  rawQuery: string,
  liveContext: { day: string; currentMinutes: number }
) {
  const q = rawQuery.toLowerCase().trim();

  let detectedLanguage = 'English';
  if (/ekkada|undi|unnayi|nunchi|varaku|ippudu|eroju|repu|cheppandi|undha/i.test(q)) {
    detectedLanguage = /khali|kahan|hai/i.test(q) ? 'Hindi' : 'Telugu';
  } else if (/kahan|hai|hain|abhi|aaj|kal|baje|tak|kaun|kaunse|dikhao|khali/i.test(q)) {
    detectedLanguage = 'Hindi';
  }

  let day: string = liveContext.day;
  if (/monday|somavaram|somwar/i.test(q)) day = 'Monday';
  else if (/tuesday|mangalavaram|mangalwar/i.test(q)) day = 'Tuesday';
  else if (/wednesday|budhavaram|budhwar/i.test(q)) day = 'Wednesday';
  else if (/thursday|guruvaram|brihaspatiwar|guruwar/i.test(q)) day = 'Thursday';
  else if (/friday|shukravaram|shukrawar/i.test(q)) day = 'Friday';
  else if (/saturday|shanivaram|shaniwar/i.test(q)) day = 'Saturday';
  else if (/tomorrow|repu|kal/i.test(q)) {
    const daysOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const idx = daysOrder.indexOf(liveContext.day);
    day = daysOrder[(idx + 1) % daysOrder.length];
  }

  let isNow = false;
  let startMinutes = liveContext.currentMinutes;
  let endMinutes = liveContext.currentMinutes + 60;

  if (/now|abhi|ippudu|currently|right now/i.test(q) && !/\d{1,2}\s*(to|nunchi|se|-)\s*\d{1,2}/i.test(q)) {
    isNow = true;
    startMinutes = liveContext.currentMinutes;
    endMinutes = Math.min(1439, liveContext.currentMinutes + 60);
  }

  const rangeMatch = q.match(
    /(?:from\s+)?(\d{1,2}(?::\d{2})?)\s*(?:am|pm)?\s*(?:to|nunchi|se|-|varaku|tak)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)?/i
  );

  if (rangeMatch) {
    const rawStart = rangeMatch[1];
    const rawEnd = rangeMatch[2];
    const globalAmpm = rangeMatch[3] ? rangeMatch[3].toUpperCase() : undefined;

    let sMin = parseTimeToMinutes(rawStart);
    let eMin = parseTimeToMinutes(rawEnd);

    if (globalAmpm === 'PM') {
      const sH = parseInt(rawStart.split(':')[0], 10);
      if (sH < 12) sMin = (sH + 12) * 60 + (rawStart.includes(':') ? parseInt(rawStart.split(':')[1], 10) : 0);
    }

    if (eMin > sMin) {
      startMinutes = sMin;
      endMinutes = eMin;
      isNow = false;
    }
  }

  let roomNumber: string | null = null;
  const roomMatch = q.match(/\b([A-Da-d]?-?\d{3}[A-Ca-c]?)\b/);
  if (roomMatch && !rangeMatch?.[0].includes(roomMatch[1])) {
    roomNumber = roomMatch[1].toUpperCase();
  }

  let floor: number | null = null;
  const floorMatch = q.match(/(?:floor|fl)\s*([0-4]|ground)/i);
  if (floorMatch) {
    if (floorMatch[1].toLowerCase() === 'ground') floor = 0;
    else floor = parseInt(floorMatch[1], 10);
  }

  let roomType: 'classroom' | 'lab' | 'all' = 'all';
  if (/lab|laboratory|laboratories|prayoga/i.test(q)) {
    roomType = 'lab';
  } else if (/classroom|classrooms|lecture hall|seminar hall/i.test(q)) {
    roomType = 'classroom';
  }

  let intent: string = 'free_classes';
  if (/library|pusthakalayam|lib/i.test(q)) {
    intent = 'library';
  } else if (
    roomNumber &&
    (q.includes('free') ||
      q.includes('available') ||
      q.includes('khali') ||
      q.includes('undha') ||
      q.includes('status') ||
      q.includes('undhi') ||
      q.includes('hai'))
  ) {
    intent = 'room_availability';
  } else if (/navigate|wayfinding|route|directions|daredi|rasta/i.test(q)) {
    intent = 'navigation';
  } else if (roomType === 'lab') {
    intent = 'free_labs';
  } else if (floor !== null || q.includes('floor-wise') || q.includes('floorwise')) {
    intent = 'floor_availability';
  } else if (/room|rooms|classroom|classrooms/i.test(q) && /free|available|khali/i.test(q)) {
    intent = 'free_rooms';
  }

  return {
    intent,
    day,
    startMinutes,
    endMinutes,
    startTimeFormatted: minutesToTimeString(startMinutes),
    endTimeFormatted: minutesToTimeString(endMinutes),
    isNow,
    floor,
    roomNumber,
    roomType,
    detectedLanguage,
    originalQuery: rawQuery,
  };
}

const CAMPUS_INFO = {
  name: 'JAIN University',
  campus: 'School of Engineering and Technology (SET)',
  building: 'Main Academic & Research Complex',
  location: 'Jain Global Campus, Kanakapura Road, Bengaluru, Karnataka 562112',
  centerCoords: { lat: 12.6508, lng: 77.4412 },
  status: 'System Online',
  emergencyPhone: '+91-80-4646-1234',
  securityOffice: 'Main Gate Control & Ground Floor Security Desk',
};

const CAMPUS_STATS = {
  totalRooms: 139,
  totalFloors: 5,
  totalAreaSqm: 42000,
  walkableCorridorsMeters: 3800,
  activeSensors: 48,
  liveOccupancy: 'Optimal',
};

const FLOORS_SUMMARY = [
  { level: 0, name: 'Ground Floor', code: 'GF', roomsCount: 28 },
  { level: 1, name: 'First Floor', code: '1F', roomsCount: 32 },
  { level: 2, name: 'Second Floor', code: '2F', roomsCount: 30 },
  { level: 3, name: 'Third Floor', code: '3F', roomsCount: 26 },
  { level: 4, name: 'Fourth Floor', code: '4F', roomsCount: 23 },
];

// Simple sliding-window per-IP rate limiter for API endpoints
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
function checkRateLimit(ip: string, maxRequests: number = 60, windowMs: number = 60_000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= maxRequests;
}

// Validate JPEG / PNG / WebP magic bytes
function isValidImageBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 12) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return true;
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Production HTTP Security Headers & Content Security Policy
  app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(self), camera=(), microphone=(), payment=(), usb=()'
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    // Strict CSP permitting self, Google Fonts, and embedding inside AI Studio preview iframe
    const isProd = process.env.NODE_ENV === 'production';
    const scriptSrc = isProd
      ? "'self'"
      : "'self' 'unsafe-inline' 'unsafe-eval'";
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src ${scriptSrc}`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.run.app",
      ].join('; ')
    );
    next();
  });

  // Restrict JSON body size to 5MB (prevent memory DoS)
  app.use(express.json({ limit: '5mb' }));

  // Global API rate limiting
  app.use('/api', (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(ip, 100, 60_000)) {
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  });

  // ================= API ROUTES =================

  // Upload/Set exact university campus photo (protected administrative action with strict validation)
  app.post('/api/upload-campus-photo', (req, res) => {
    try {
      // Enforce administrative authorization if ADMIN_API_TOKEN is configured in environment
      const configuredAdminToken = process.env.ADMIN_API_TOKEN;
      if (configuredAdminToken) {
        const authHeader = req.headers.authorization || '';
        if (authHeader !== `Bearer ${configuredAdminToken}`) {
          return res.status(403).json({ error: 'Unauthorized administrative operation' });
        }
      }

      const { imageBase64 } = req.body || {};
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid imageBase64 string' });
      }

      const mimeMatch = imageBase64.match(/^data:image\/(jpeg|jpg|png|webp);base64,/i);
      if (!mimeMatch && imageBase64.startsWith('data:')) {
        return res.status(400).json({ error: 'Unsupported image MIME type. Allowed: jpeg, png, webp.' });
      }

      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      // Enforce maximum 4MB file size and verify binary magic bytes
      if (buffer.length > 4 * 1024 * 1024 || !isValidImageBuffer(buffer)) {
        return res.status(400).json({ error: 'Invalid image payload or file exceeds 4MB limit' });
      }

      const publicDir = path.resolve(process.cwd(), 'public');
      const targetPaths = [
        path.join(publicDir, 'jain-campus-main-building.jpg'),
        path.join(publicDir, 'campus-aerial.jpg'),
        path.join(publicDir, 'jain-university-engineering.jpg'),
        path.join(publicDir, 'assets', 'jain-campus-main-building.jpg'),
      ];

      const distDir = path.resolve(process.cwd(), 'dist');
      if (fs.existsSync(distDir)) {
        targetPaths.push(path.join(distDir, 'jain-campus-main-building.jpg'));
        targetPaths.push(path.join(distDir, 'campus-aerial.jpg'));
      }

      for (const targetPath of targetPaths) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, buffer);
      }

      const timestamp = Date.now();
      return res.json({
        success: true,
        message: 'Campus photo successfully saved with exact original quality and zero modifications',
        url: `/jain-campus-main-building.jpg?v=${timestamp}`,
      });
    } catch {
      return res.status(500).json({ error: 'Failed to process campus photo upload' });
    }
  });

  // Serve campus hero image directly if requested as a public path
  app.use((req, res, next) => {
    if (
      req.path.startsWith('/jain-campus-hero') ||
      req.path.startsWith('/official-jain-campus-hero') ||
      req.path.startsWith('/WhatsApp') ||
      req.path.startsWith('/whatsapp') ||
      req.path === '/api/hero-image'
    ) {
      try {
        const candidates = [
          path.join(process.cwd(), 'src', 'assets', 'images', 'jain-campus-hero.jpg'),
          path.join(process.cwd(), 'public', 'jain-campus-hero.jpg'),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('Content-Type', 'image/jpeg');
            return res.sendFile(p);
          }
        }
      } catch {
        // Fallback to next middleware safely without leaking paths
      }
    }
    next();
  });

  // 1. Campus info
  app.get('/api/campus', (req, res) => {
    res.json({
      name: CAMPUS_INFO.name,
      campus: CAMPUS_INFO.campus,
      location: CAMPUS_INFO.location,
      centerCoords: CAMPUS_INFO.centerCoords,
      status: CAMPUS_INFO.status,
      timestamp: Date.now(),
    });
  });

  // 2. Campus Statistics
  app.get('/api/stats', (req, res) => {
    res.json(CAMPUS_STATS);
  });

  // 3. Buildings
  app.get('/api/buildings', (req, res) => {
    res.json([
      {
        id: 'bld_eng',
        name: 'School of Engineering and Technology',
        shortName: 'Engineering Block',
        floorsCount: 5,
        wings: ['North Wing', 'South Wing', 'East Wing', 'West Wing', 'Central Atrium'],
        totalAreaSqm: CAMPUS_STATS.totalAreaSqm,
      },
    ]);
  });

  // 4. Floors list
  app.get('/api/floors', (req, res) => {
    res.json(FLOORS_SUMMARY);
  });

  // 10. Emergency routes & contacts
  app.get('/api/emergency', (req, res) => {
    res.json({
      emergencyNumbers: [
        { label: 'Campus Security', number: '+91 80 4646 9500', available: '24/7' },
        { label: 'Campus Medical Health Center', number: '+91 80 4646 9555', available: '24/7' },
        { label: 'Fire Emergency Dispatch', number: '101', available: 'Immediate' },
        { label: 'Ambulance Helpline', number: '108', available: 'Immediate' },
      ],
      exits: [
        { name: 'Main Ground Floor Portico Exit', floor: 0, position: { x: 480, y: 700 } },
        { name: 'North Amphitheatre Garden Exit', floor: 0, position: { x: 530, y: 320 } },
        { name: 'West Parking Lot Exit', floor: 0, position: { x: 210, y: 550 } },
      ],
      stairwells: [
        { id: 'shaft_stairs_west', name: 'West Wing Staircase', type: 'stairs', floorSpan: [0, 4] },
        { id: 'shaft_stairs_east', name: 'East Wing Staircase', type: 'stairs', floorSpan: [0, 4] },
      ],
    });
  });

  // Bounded in-memory Wi-Fi fingerprint store for calibration (capped at 200 items)
  const MAX_FINGERPRINTS = 200;
  const fingerprintStore: Array<{
    id: string;
    floor: number;
    x?: number;
    y?: number;
    recordedAt: string;
  }> = [];

  app.get('/api/fingerprints', (req, res) => {
    res.json({ count: fingerprintStore.length, items: fingerprintStore });
  });

  app.post('/api/fingerprints', (req, res) => {
    const sample = req.body;
    if (
      !sample ||
      typeof sample !== 'object' ||
      typeof sample.floor !== 'number' ||
      sample.floor < 0 ||
      sample.floor > 4
    ) {
      return res.status(400).json({ error: 'Invalid fingerprint payload. Floor must be 0..4.' });
    }
    const sanitizedSample = {
      id: `fp_${Date.now()}`,
      floor: Math.floor(sample.floor),
      x: typeof sample.x === 'number' ? Math.max(0, Math.min(1000, sample.x)) : undefined,
      y: typeof sample.y === 'number' ? Math.max(0, Math.min(1000, sample.y)) : undefined,
      recordedAt: new Date().toISOString(),
    };
    if (fingerprintStore.length >= MAX_FINGERPRINTS) {
      fingerprintStore.shift();
    }
    fingerprintStore.push(sanitizedSample);
    res.status(201).json({ success: true, count: fingerprintStore.length });
  });

  // Natural language query parser using Gemini 3.8 Flash with structured JSON output
  app.post('/api/assistant/parse-query', async (req, res) => {
    try {
      const { query, context } = req.body || {};
      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Missing query string' });
      }
      // Bound input length to prevent prompt abuse
      const safeQuery = query.trim().slice(0, 400);
      const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const safeDay =
        context?.day && validDays.includes(context.day) ? context.day : 'Tuesday';
      const safeMinutes =
        typeof context?.currentMinutes === 'number' &&
        context.currentMinutes >= 0 &&
        context.currentMinutes <= 1439
          ? Math.floor(context.currentMinutes)
          : 660;
      const safeTimeFormatted =
        typeof context?.currentTimeFormatted === 'string'
          ? context.currentTimeFormatted.slice(0, 20)
          : '11:00 AM';

      const prompt = `You are the intent parser for JAIN University Smart Campus Assistant.
Parse the user's natural language question (which may be in English, Telugu, Hindi, or mixed languages) into structured timetable query parameters.

User Question: "${safeQuery}"
Context:
- Current Day: ${safeDay}
- Current IST Time: ${safeTimeFormatted} (${safeMinutes} minutes from midnight)
- Timezone: Asia/Kolkata

Available intents:
- "free_classes": user asks about free periods, free classes, or vacant time slots (e.g. "From 2 to 3 pm free classes", "2 nunchi 3 varaku free classes em unnayi?")
- "free_rooms": user asks about free classrooms or rooms
- "free_labs": user specifically asks about open or free laboratories (e.g. "Which labs are free now?", "Abhi kaun se labs free hain?")
- "room_availability": user asks whether a specific room is free (e.g. "Is room 221A free from 2 to 3 pm?", "Is room 111 free today?")
- "floor_availability": user asks about rooms on a specific floor (e.g. "Find rooms available on Floor 2", "Show free rooms floor-wise")
- "library": user asks about library location, hours, or status (e.g. "Library ekkada undi?", "Where is the library?")
- "navigation": user asks how to go to a room or building (e.g. "Navigate to room 102", "daredi")
- "help": greeting or general help

Rules:
- If a time range like "2 to 3 pm" or "2 nunchi 3 varaku" is mentioned, startMinutes=840, endMinutes=900.
- If relative time like "now", "abhi", "ippudu" is mentioned, isNow=true, startMinutes=currentMinutes, endMinutes=currentMinutes+60.
- Default day to current day unless user mentions another day.
- Extract any room number (e.g. "221A", "111", "304", "D-220").
- Extract any floor number (0 for Ground, 1, 2, 3, 4).
- Extract detectedLanguage ("English", "Telugu", "Hindi", etc.).

Output strictly JSON:
{
  "intent": "free_classes" | "free_rooms" | "free_labs" | "room_availability" | "floor_availability" | "library" | "navigation" | "help",
  "day": "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday",
  "startMinutes": number,
  "endMinutes": number,
  "startTimeFormatted": "HH:MM AM/PM",
  "endTimeFormatted": "HH:MM AM/PM",
  "isNow": boolean,
  "floor": number | null,
  "roomNumber": string | null,
  "roomType": "classroom" | "lab" | "all",
  "detectedLanguage": string
}`;

      let resultJson: any = null;
      if (process.env.GEMINI_API_KEY) {
        try {
          const ai = new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build',
              },
            },
          });
          const aiPromise = ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
            },
          });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Gemini timeout')), 3000)
          );

          const response = (await Promise.race([aiPromise, timeoutPromise])) as any;
          if (response?.text) {
            resultJson = JSON.parse(response.text.trim());
          }
        } catch {
          // Graceful fallback to local deterministic parser without leaking internal API details
        }
      }

      if (!resultJson) {
        resultJson = parseLocalNaturalLanguageQuery(safeQuery, {
          day: safeDay,
          currentMinutes: safeMinutes,
        });
      }

      return res.json({
        success: true,
        parsed: resultJson,
      });
    } catch {
      return res.status(500).json({ error: 'Unable to parse query' });
    }
  });

  // Healthcheck
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', serverTime: new Date().toISOString() });
  });

  // ================= VITE MIDDLEWARE SETUP =================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.use((req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`JAIN University Smart Campus Server running on port ${PORT}`);
  });
}

startServer();
