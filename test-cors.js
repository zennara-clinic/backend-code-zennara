/**
 * Standalone CORS Test Server
 * Run this to verify CORS is working before deploying to AWS
 */

const express = require('express');
const cors = require('cors');

const app = express();

// Simple CORS configuration - allow everything
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// Handle preflight explicitly
app.options('*', cors());

app.use(express.json());

// Test endpoint
app.post('/api/admin/auth/login', (req, res) => {
  console.log('✅ Login endpoint hit!');
  console.log('Origin:', req.headers.origin);
  console.log('Method:', req.method);
  
  res.json({
    success: true,
    message: 'CORS is working! This is a test response.',
    requestedEmail: req.body.email
  });
});

// Health check
app.get('/', (req, res) => {
  res.send('CORS Test Server Running - Try POST to /api/admin/auth/login');
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🧪 CORS Test Server running on http://localhost:${PORT}`);
  console.log(`📝 Test it from your admin panel by temporarily changing API URL to http://localhost:${PORT}`);
});
