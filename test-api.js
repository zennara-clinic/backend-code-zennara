/**
 * Simple API Test Script
 * Run this to test your backend without the mobile app
 * 
 * Usage: node test-api.js
 */

const baseURL = 'http://localhost:5000/api';

// Test data
const testUser = {
  email: `test${Date.now()}@example.com`,
  fullName: 'Test User',
  phone: '9876543210',
  location: 'Jubilee Hills',
  dateOfBirth: '15/08/1990',
  gender: 'Male',
};

// Helper function for API calls
async function apiCall(endpoint, method = 'GET', body = null) {
  try {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${baseURL}${endpoint}`, options);
    const data = await response.json();

    return { status: response.status, data };
  } catch (error) {
    return { status: 500, error: error.message };
  }
}

// Test functions
async function testHealthCheck() {
  console.log('\n=== Testing Health Check ===');
  const response = await fetch('http://localhost:5000/');
  const data = await response.json();
  
  if (data.status === 'healthy') {
    console.log('✅ Health check passed');
    console.log(data);
    return true;
  } else {
    console.log('❌ Health check failed');
    return false;
  }
}

async function testSignup() {
  console.log('\n=== Testing Signup ===');
  console.log('Email:', testUser.email);
  
  const result = await apiCall('/auth/signup', 'POST', testUser);
  
  if (result.status === 201 && result.data.success) {
    console.log('✅ Signup successful');
    console.log(result.data);
    return true;
  } else {
    console.log('❌ Signup failed');
    console.log(result.data || result.error);
    return false;
  }
}

async function testLogin() {
  console.log('\n=== Testing Login (Send OTP) ===');
  
  const result = await apiCall('/auth/login', 'POST', { email: testUser.email });
  
  if (result.status === 200 && result.data.success) {
    console.log('✅ OTP sent successfully');
    console.log('⚠️  Check your email for OTP or check backend logs');
    console.log(result.data);
    return true;
  } else {
    console.log('❌ Login failed');
    console.log(result.data || result.error);
    return false;
  }
}

// Run all tests
async function runTests() {
  console.log('🚀 Starting API Tests...\n');
  
  try {
    // Test 1: Health Check
    const healthCheck = await testHealthCheck();
    if (!healthCheck) {
      console.log('\n❌ Health check failed. Make sure backend is running on port 5000');
      return;
    }
    
    // Test 2: Signup
    const signupSuccess = await testSignup();
    if (!signupSuccess) {
      console.log('\n❌ Signup failed. Check MongoDB connection and backend logs');
      return;
    }
    
    // Test 3: Login
    const loginSuccess = await testLogin();
    if (!loginSuccess) {
      console.log('\n❌ Login failed. Check email service configuration');
      return;
    }
    
    console.log('\n✅ All basic tests passed!');
    console.log('\n📧 Next Steps:');
    console.log('1. Check your email for the OTP');
    console.log('2. Use Postman to test OTP verification with actual OTP');
    console.log('3. Test email:', testUser.email);
    
  } catch (error) {
    console.error('\n❌ Test failed with error:', error.message);
  }
}

runTests();
