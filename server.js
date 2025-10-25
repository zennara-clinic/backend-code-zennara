const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const cors = require('cors');

const connectDB = require('./config/db');
const { startBookingScheduler } = require('./utils/bookingScheduler');
const BookingStatusService = require('./services/bookingStatusService');
const { checkBookingStatus } = require('./middleware/bookingStatusMiddleware');

const app = express();

/* ----------------------------- CORS (Production-Ready) ----------------------------- */
const allowedOrigins = [
  'https://admin.sizid.com',
  'https://api.zennara.in',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:4173'
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, postman, curl, etc.)
    if (!origin) return callback(null, true);
    
    // Allow all origins in development
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    // In production, check if origin is in allowed list
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      console.log('🚫 CORS blocked origin:', origin);
      callback(null, true); // Still allow but log for debugging
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept',
    'Origin',
    'X-Requested-With',
    'Content-Length',
    'Accept-Encoding',
    'X-CSRF-Token',
    'Accept-Language',
    'X-Forwarded-For',
    'X-Real-IP'
  ],
  exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Disposition'],
  credentials: false,
  maxAge: 86400,
  optionsSuccessStatus: 204,
  preflightContinue: false
};

// Apply CORS globally first
app.use(cors(corsOptions));

// Explicitly handle ALL OPTIONS requests before any other middleware
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS,HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,Origin,X-Requested-With');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(204);
});

/*
  If you later NEED cookies/session:
  - Replace the block above with this dynamic reflection:
  
  const reflectOriginCors = {
    origin: (origin, cb) => cb(null, true), // reflect any origin (sets ACAO to request origin)
    methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS','HEAD'],
    allowedHeaders: ['Content-Type','Authorization','Accept','Origin','X-Requested-With','Content-Length','Accept-Encoding','X-CSRF-Token','Accept-Language'],
    exposedHeaders: ['Content-Length','Content-Type','Content-Disposition'],
    credentials: true,           // cookies allowed
    maxAge: 86400,
    optionsSuccessStatus: 204
  };
  app.use(cors(reflectOriginCors));
  app.options('*', cors(reflectOriginCors));
*/

/* ------------------------------ Core Middleware ------------------------------ */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* --------------------------- Connect services/jobs --------------------------- */
connectDB();
startBookingScheduler();
BookingStatusService.startAutoChecker();

/* ----------------------------- Debug (optional) ------------------------------ */
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    console.log('🔍 CORS Preflight:', {
      origin: req.get('Origin'),
      method: req.get('Access-Control-Request-Method'),
      headers: req.get('Access-Control-Request-Headers')
    });
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    console.log('🔍 DEBUG Request:', {
      method: req.method,
      url: req.url,
      origin: req.get('Origin'),
      contentType: req.get('Content-Type'),
      bodyKeys: Object.keys(req.body || {})
      // body: req.body // uncomment if you need full body logs
    });
  }
  next();
});

/* ------------------------------- Route guards ------------------------------- */
app.use('/api/bookings', checkBookingStatus);

/* --------------------------------- Routes ---------------------------------- */
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin/auth', require('./routes/adminAuth'));
app.use('/api/admin/users', require('./routes/user'));
app.use('/api/admin/products', require('./routes/adminProducts'));
app.use('/api/admin/product-orders', require('./routes/adminOrders'));
app.use('/api/admin/brands', require('./routes/brand'));
app.use('/api/admin/formulations', require('./routes/formulation'));
app.use('/api/admin/coupons', require('./routes/coupon'));
app.use('/api/addresses', require('./routes/address'));
app.use('/api/consultations', require('./routes/consultation'));
app.use('/api/bookings', require('./routes/booking'));
app.use('/api/branches', require('./routes/branch'));
app.use('/api/support', require('./routes/support'));
app.use('/api/categories', require('./routes/category'));
app.use('/api/packages', require('./routes/package'));
app.use('/api/package-assignments', require('./routes/packageAssignment'));
app.use('/api/products', require('./routes/product'));
app.use('/api/product-orders', require('./routes/productOrder'));
app.use('/api/reviews', require('./routes/review'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/coupons', require('./routes/coupon'));
app.use('/api/vendors', require('./routes/vendor'));
app.use('/api/admin/inventory', require('./routes/inventory'));

/* ------------------------------ Health Check -------------------------------- */
app.get('/', (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Zennara API - Server Status</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: linear-gradient(135deg, #10b981 0%, #059669 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .container { background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 50px; max-width: 600px; width: 100%; text-align: center; }
        .logo { font-size: 48px; font-weight: 800; background: linear-gradient(135deg, #10b981 0%, #059669 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 10px; letter-spacing: -1px; }
        .tagline { color: #6b7280; font-size: 16px; margin-bottom: 40px; }
        .status-badge { display: inline-flex; align-items: center; gap: 8px; background: #d1fae5; color: #065f46; padding: 10px 24px; border-radius: 50px; font-weight: 600; font-size: 14px; margin-bottom: 30px; animation: pulse 2s ease-in-out infinite; }
        .status-dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; animation: blink 2s ease-in-out infinite; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
        @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.05)} }
        .footer { margin-top: 30px; color: #9ca3af; font-size: 13px; }
        .version { display: inline-block; background: #e5e7eb; color: #4b5563; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-top: 10px; }
        @media (max-width: 640px) { .container { padding: 30px 20px; } .logo { font-size: 36px; } }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">Zennara</div>
        <div class="tagline">Celebrity Doctors and Aestheticians</div>
        <div class="status-badge">
          <div class="status-dot"></div>
          <span>Server Running</span>
        </div>
        <div class="footer">
          <div>Zennara API Server</div>
          <div class="version">v1.0.0</div>
          <div style="margin-top:8px;color:#065f46;font-weight:600;">Uptime: ${hours}h ${minutes}m ${seconds}s</div>
        </div>
      </div>
    </body>
    </html>
  `);
});

/* ------------------------------- Error handler ------------------------------- */
/*
  Ensure even error responses aren’t blocked by CORS.
  Because we apply app.use(cors(...)) first, errors will already have ACAO,
  but this keeps responses consistent.
*/
app.use((err, req, res, next) => {
  console.error('❌ Server error occurred:', err?.message || err);
  res.status(err.status || 500).json({
    success: false,
    message: 'Server error. Please try again.'
  });
});

/* --------------------------------- 404 -------------------------------------- */
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

/* --------------------------------- Listen ----------------------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
  console.log(`📅 Automatic booking cleanup enabled`);
});
