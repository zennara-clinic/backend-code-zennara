const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const cors = require('cors');

const connectDB = require('./config/db');
const { startBookingScheduler } = require('./utils/bookingScheduler');
const BookingStatusService = require('./services/bookingStatusService');
const { checkBookingStatus } = require('./middleware/bookingStatusMiddleware');

const app = express();

// Allow ONLY your admin app (recommended)
app.use(cors({
  origin: 'https://admin.sizid.com',
  credentials: false, // don't use cookies with a single origin unless you need them
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'],
  allowedHeaders: [
    'Content-Type','Authorization','Accept','Origin','X-Requested-With',
    'Content-Length','Accept-Encoding','X-CSRF-Token','Accept-Language'
  ],
  exposedHeaders: ['Content-Length','Content-Type','Content-Disposition'],
  optionsSuccessStatus: 204,
  maxAge: 86400
}));
app.options('*', cors());

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
