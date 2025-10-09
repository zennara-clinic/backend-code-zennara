const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./config/db');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Debug middleware to log all requests
app.use((req, res, next) => {
  if (req.method === 'PUT' || req.method === 'POST') {
    console.log('🔍 DEBUG Request:', {
      method: req.method,
      url: req.url,
      contentType: req.get('Content-Type'),
      bodyKeys: Object.keys(req.body || {}),
      body: req.body
    });
  }
  next();
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/addresses', require('./routes/address'));

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'Zennara API is running',
    version: '1.0.0',
    status: 'healthy'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server error occurred');
  res.status(err.status || 500).json({
    success: false,
    message: 'Server error. Please try again.'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
});
