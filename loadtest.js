const axios = require('axios');
const { performance } = require('perf_hooks');

// Configuration
const BASE_URL = 'http://localhost:5000';
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

// Test Configuration - EXTREME LOAD TEST
const TEST_CONFIG = {
  // EXTREME load test parameters
  CONCURRENT_USERS: 500,        // Number of simultaneous users (5x increase!)
  REQUESTS_PER_USER: 100,       // Requests each user will make (2x increase!)
  TEST_DURATION: 90,            // Duration in seconds (increased to 90s)
  RAMP_UP_TIME: 15,             // Time to reach max users (seconds)
  
  // Endpoints to test (more diverse)
  ENDPOINTS: {
    health: { weight: 3, method: 'GET', path: '/' },
    products: { weight: 25, method: 'GET', path: '/api/products' },
    productDetail: { weight: 20, method: 'GET', path: '/api/products/:id' },
    categories: { weight: 12, method: 'GET', path: '/api/categories' },
    branches: { weight: 10, method: 'GET', path: '/api/branches' },
    packages: { weight: 10, method: 'GET', path: '/api/packages' },
    reviews: { weight: 8, method: 'GET', path: '/api/reviews' },
    coupons: { weight: 7, method: 'GET', path: '/api/coupons' },
    vendors: { weight: 5, method: 'GET', path: '/api/vendors' },
  }
};

// Statistics
const stats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  totalResponseTime: 0,
  minResponseTime: Infinity,
  maxResponseTime: 0,
  statusCodes: {},
  errors: {},
  requestsPerSecond: [],
  activeUsers: 0,
  startTime: null,
  endTime: null
};

// Sample product IDs (you can add real ones from your database)
const SAMPLE_PRODUCT_IDS = [
  '507f1f77bcf86cd799439011',
  '507f1f77bcf86cd799439012',
  '507f1f77bcf86cd799439013',
  '507f1f77bcf86cd799439014',
  '507f1f77bcf86cd799439015'
];

// Utility functions
function log(message, color = 'white') {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function getRandomEndpoint() {
  const endpoints = Object.entries(TEST_CONFIG.ENDPOINTS);
  const totalWeight = endpoints.reduce((sum, [, config]) => sum + config.weight, 0);
  let random = Math.random() * totalWeight;
  
  for (const [name, config] of endpoints) {
    random -= config.weight;
    if (random <= 0) {
      let path = config.path;
      // Replace dynamic parameters
      if (path.includes(':id')) {
        const randomId = SAMPLE_PRODUCT_IDS[Math.floor(Math.random() * SAMPLE_PRODUCT_IDS.length)];
        path = path.replace(':id', randomId);
      }
      return { name, method: config.method, path };
    }
  }
  
  return endpoints[0];
}

async function makeRequest(endpoint) {
  const startTime = performance.now();
  
  try {
    stats.totalRequests++;
    
    const response = await axios({
      method: endpoint.method,
      url: `${BASE_URL}${endpoint.path}`,
      timeout: 10000,
      validateStatus: () => true // Accept any status code
    });
    
    const endTime = performance.now();
    const responseTime = endTime - startTime;
    
    // Update statistics
    stats.successfulRequests++;
    stats.totalResponseTime += responseTime;
    stats.minResponseTime = Math.min(stats.minResponseTime, responseTime);
    stats.maxResponseTime = Math.max(stats.maxResponseTime, responseTime);
    
    // Track status codes
    const statusCode = response.status;
    stats.statusCodes[statusCode] = (stats.statusCodes[statusCode] || 0) + 1;
    
    return {
      success: true,
      statusCode,
      responseTime,
      endpoint: endpoint.name
    };
    
  } catch (error) {
    const endTime = performance.now();
    const responseTime = endTime - startTime;
    
    stats.failedRequests++;
    
    // Track errors
    const errorType = error.code || error.message || 'Unknown';
    stats.errors[errorType] = (stats.errors[errorType] || 0) + 1;
    
    return {
      success: false,
      error: errorType,
      responseTime,
      endpoint: endpoint.name
    };
  }
}

async function virtualUser(userId, requestCount) {
  stats.activeUsers++;
  
  const results = [];
  
  for (let i = 0; i < requestCount; i++) {
    const endpoint = getRandomEndpoint();
    const result = await makeRequest(endpoint);
    results.push(result);
    
    // Small delay between requests (50-200ms)
    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 150));
    
    // Check if test duration exceeded
    if (TEST_CONFIG.TEST_DURATION > 0) {
      const elapsed = (Date.now() - stats.startTime) / 1000;
      if (elapsed >= TEST_CONFIG.TEST_DURATION) {
        break;
      }
    }
  }
  
  stats.activeUsers--;
  return results;
}

function displayProgress() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const avgResponseTime = (stats.totalResponseTime / stats.successfulRequests).toFixed(2);
  const successRate = ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2);
  const rps = (stats.totalRequests / elapsed).toFixed(2);
  
  process.stdout.write(`\r${COLORS.cyan}⚡ Active Users: ${stats.activeUsers} | ` +
    `Requests: ${stats.totalRequests} | ` +
    `Success: ${successRate}% | ` +
    `Avg Response: ${avgResponseTime}ms | ` +
    `RPS: ${rps} | ` +
    `Time: ${elapsed}s${COLORS.reset}`);
}

function displayResults() {
  const duration = (stats.endTime - stats.startTime) / 1000;
  const avgResponseTime = stats.totalResponseTime / stats.successfulRequests;
  const successRate = (stats.successfulRequests / stats.totalRequests) * 100;
  const rps = stats.totalRequests / duration;
  
  console.log('\n\n' + '='.repeat(80));
  log('📊 LOAD TEST RESULTS', 'cyan');
  console.log('='.repeat(80) + '\n');
  
  // Overall Statistics
  log('📈 OVERALL STATISTICS:', 'yellow');
  console.log(`   Total Requests:       ${stats.totalRequests}`);
  console.log(`   Successful:           ${COLORS.green}${stats.successfulRequests} (${successRate.toFixed(2)}%)${COLORS.reset}`);
  console.log(`   Failed:               ${COLORS.red}${stats.failedRequests} (${(100 - successRate).toFixed(2)}%)${COLORS.reset}`);
  console.log(`   Test Duration:        ${duration.toFixed(2)}s`);
  console.log(`   Requests/Second:      ${COLORS.cyan}${rps.toFixed(2)}${COLORS.reset}\n`);
  
  // Response Time Statistics
  log('⚡ RESPONSE TIME:', 'yellow');
  console.log(`   Average:              ${avgResponseTime.toFixed(2)}ms`);
  console.log(`   Minimum:              ${COLORS.green}${stats.minResponseTime.toFixed(2)}ms${COLORS.reset}`);
  console.log(`   Maximum:              ${COLORS.red}${stats.maxResponseTime.toFixed(2)}ms${COLORS.reset}\n`);
  
  // Status Codes
  log('📋 HTTP STATUS CODES:', 'yellow');
  const sortedCodes = Object.entries(stats.statusCodes).sort((a, b) => b[1] - a[1]);
  for (const [code, count] of sortedCodes) {
    const percentage = ((count / stats.totalRequests) * 100).toFixed(2);
    const color = code.startsWith('2') ? 'green' : code.startsWith('4') ? 'yellow' : 'red';
    console.log(`   ${COLORS[color]}${code}${COLORS.reset}: ${count} (${percentage}%)`);
  }
  
  // Errors (if any)
  if (Object.keys(stats.errors).length > 0) {
    console.log('\n');
    log('❌ ERRORS:', 'red');
    const sortedErrors = Object.entries(stats.errors).sort((a, b) => b[1] - a[1]);
    for (const [error, count] of sortedErrors) {
      const percentage = ((count / stats.failedRequests) * 100).toFixed(2);
      console.log(`   ${error}: ${count} (${percentage}%)`);
    }
  }
  
  // Performance Rating
  console.log('\n');
  log('🏆 PERFORMANCE RATING:', 'yellow');
  
  let rating = 'Excellent';
  let color = 'green';
  let score = 10;
  
  if (avgResponseTime > 1000) {
    rating = 'Poor';
    color = 'red';
    score = 4;
  } else if (avgResponseTime > 500) {
    rating = 'Fair';
    color = 'yellow';
    score = 6;
  } else if (avgResponseTime > 200) {
    rating = 'Good';
    color = 'cyan';
    score = 8;
  }
  
  if (successRate < 95) {
    rating = 'Poor';
    color = 'red';
    score = Math.min(score, 5);
  } else if (successRate < 99) {
    score -= 1;
  }
  
  console.log(`   Rating:               ${COLORS[color]}${rating} (${score}/10)${COLORS.reset}`);
  console.log(`   Success Rate:         ${successRate >= 99 ? COLORS.green : successRate >= 95 ? COLORS.yellow : COLORS.red}${successRate.toFixed(2)}%${COLORS.reset}`);
  console.log(`   Avg Response Time:    ${avgResponseTime < 200 ? COLORS.green : avgResponseTime < 500 ? COLORS.yellow : COLORS.red}${avgResponseTime.toFixed(2)}ms${COLORS.reset}`);
  console.log(`   Requests/Second:      ${rps >= 100 ? COLORS.green : rps >= 50 ? COLORS.yellow : COLORS.red}${rps.toFixed(2)}${COLORS.reset}`);
  
  console.log('\n' + '='.repeat(80) + '\n');
  
  // Recommendations
  log('💡 RECOMMENDATIONS:', 'magenta');
  if (avgResponseTime > 500) {
    console.log('   ⚠️  High average response time. Consider:');
    console.log('      - Adding database indexes');
    console.log('      - Implementing caching (Redis)');
    console.log('      - Optimizing database queries');
    console.log('      - Using CDN for static assets');
  }
  
  if (successRate < 99) {
    console.log('   ⚠️  Some requests failed. Check:');
    console.log('      - Server error logs');
    console.log('      - Rate limiting configuration');
    console.log('      - Database connection pool size');
  }
  
  if (rps < 50) {
    console.log('   ⚠️  Low throughput. Consider:');
    console.log('      - Increasing server resources');
    console.log('      - Implementing horizontal scaling');
    console.log('      - Using load balancer');
  }
  
  if (avgResponseTime < 200 && successRate >= 99 && rps >= 100) {
    console.log(`   ${COLORS.green}✅ Excellent performance! Your backend is production-ready.${COLORS.reset}`);
  }
  
  console.log('\n');
}

async function runLoadTest() {
  log('🚀 Starting Heavy Load Test...', 'cyan');
  console.log(`   Concurrent Users: ${TEST_CONFIG.CONCURRENT_USERS}`);
  console.log(`   Requests per User: ${TEST_CONFIG.REQUESTS_PER_USER}`);
  console.log(`   Ramp-up Time: ${TEST_CONFIG.RAMP_UP_TIME}s`);
  console.log(`   Total Expected Requests: ${TEST_CONFIG.CONCURRENT_USERS * TEST_CONFIG.REQUESTS_PER_USER}`);
  console.log('\n');
  
  // Check if server is running
  try {
    await axios.get(BASE_URL);
    log('✅ Server is reachable', 'green');
  } catch (error) {
    log('❌ Cannot connect to server. Make sure it\'s running on ' + BASE_URL, 'red');
    return;
  }
  
  console.log('\n');
  log('⏳ Starting test in 3 seconds...', 'yellow');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  stats.startTime = Date.now();
  
  // Progress display interval
  const progressInterval = setInterval(displayProgress, 500);
  
  // Gradually ramp up users
  const users = [];
  const delayBetweenUsers = (TEST_CONFIG.RAMP_UP_TIME * 1000) / TEST_CONFIG.CONCURRENT_USERS;
  
  for (let i = 0; i < TEST_CONFIG.CONCURRENT_USERS; i++) {
    users.push(virtualUser(i, TEST_CONFIG.REQUESTS_PER_USER));
    
    // Add delay for ramp-up
    if (i < TEST_CONFIG.CONCURRENT_USERS - 1) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenUsers));
    }
  }
  
  // Wait for all users to complete
  await Promise.all(users);
  
  clearInterval(progressInterval);
  stats.endTime = Date.now();
  
  // Display final results
  displayResults();
}

// Run the test
log('\n🔥 HEAVY LOAD TEST INITIALIZED\n', 'magenta');
runLoadTest().catch(error => {
  console.error('\n❌ Load test failed:', error.message);
  process.exit(1);
});
