# CSRF Token Implementation Guide

## For Admin Panel Developers

The backend now implements CSRF (Cross-Site Request Forgery) protection for enhanced security. Here's how to use it in the admin panel.

---

## What is CSRF?

CSRF protection prevents attackers from tricking authenticated users into performing unwanted actions. Without CSRF protection, an attacker could create a malicious website that sends requests to your API using the victim's credentials.

---

## Backend Implementation

CSRF protection is **automatically active** for all state-changing operations (POST, PUT, DELETE, PATCH) on admin routes.

### CSRF Token Endpoint

```http
GET /api/auth/csrf-token
Authorization: Bearer <your-jwt-token>
```

**Response:**
```json
{
  "csrfToken": "a1b2c3d4e5f6g7h8i9j0..."
}
```

---

## Frontend Integration (Admin Panel)

### Step 1: Fetch CSRF Token on Login

When a user logs in successfully, immediately fetch the CSRF token:

```javascript
// After successful login
const loginUser = async (credentials) => {
  try {
    // 1. Login first
    const loginResponse = await axios.post('/api/admin/auth/login', credentials);
    const { token } = loginResponse.data.data;
    
    // 2. Store JWT token
    localStorage.setItem('adminToken', token);
    
    // 3. Fetch CSRF token
    const csrfResponse = await axios.get('/api/auth/csrf-token', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    // 4. Store CSRF token
    localStorage.setItem('csrfToken', csrfResponse.data.csrfToken);
    
    return token;
  } catch (error) {
    console.error('Login failed:', error);
    throw error;
  }
};
```

### Step 2: Include CSRF Token in Requests

For all state-changing requests (POST, PUT, DELETE), include the CSRF token:

#### Option A: Axios Interceptor (Recommended)

```javascript
// Set up axios interceptor once in your app
import axios from 'axios';

axios.interceptors.request.use((config) => {
  // Add JWT token
  const token = localStorage.getItem('adminToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  
  // Add CSRF token for state-changing requests
  if (['post', 'put', 'delete', 'patch'].includes(config.method)) {
    const csrfToken = localStorage.getItem('csrfToken');
    if (csrfToken) {
      config.headers['X-CSRF-Token'] = csrfToken;
    }
  }
  
  return config;
}, (error) => {
  return Promise.reject(error);
});
```

#### Option B: Manual Header Addition

```javascript
const updateOrderStatus = async (orderId, status) => {
  const token = localStorage.getItem('adminToken');
  const csrfToken = localStorage.getItem('csrfToken');
  
  const response = await axios.put(
    `/api/admin/product-orders/${orderId}/status`,
    { status },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-CSRF-Token': csrfToken
      }
    }
  );
  
  return response.data;
};
```

### Step 3: Handle CSRF Token Expiry

CSRF tokens expire after 1 hour. If you get a 403 error, refresh the token:

```javascript
axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 403 && 
        error.response?.data?.message === 'Invalid CSRF token') {
      
      // Refresh CSRF token
      try {
        const token = localStorage.getItem('adminToken');
        const csrfResponse = await axios.get('/api/auth/csrf-token', {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        localStorage.setItem('csrfToken', csrfResponse.data.csrfToken);
        
        // Retry original request
        const originalRequest = error.config;
        originalRequest.headers['X-CSRF-Token'] = csrfResponse.data.csrfToken;
        return axios(originalRequest);
      } catch (refreshError) {
        // If refresh fails, logout user
        localStorage.removeItem('adminToken');
        localStorage.removeItem('csrfToken');
        window.location.href = '/login';
      }
    }
    
    return Promise.reject(error);
  }
);
```

---

## Complete React Example

```javascript
import axios from 'axios';
import { useState, useEffect } from 'react';

// Configure axios base URL
axios.defaults.baseURL = 'https://api.sizid.com';

// Auth context/hook
export const useAuth = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  
  useEffect(() => {
    // Check if user is logged in
    const token = localStorage.getItem('adminToken');
    setIsAuthenticated(!!token);
    
    // Set up axios interceptors
    setupAxiosInterceptors();
  }, []);
  
  const login = async (username, password) => {
    try {
      // Login
      const loginRes = await axios.post('/api/admin/auth/login', {
        username,
        password
      });
      
      const { token } = loginRes.data.data;
      localStorage.setItem('adminToken', token);
      
      // Get CSRF token
      const csrfRes = await axios.get('/api/auth/csrf-token', {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      localStorage.setItem('csrfToken', csrfRes.data.csrfToken);
      setIsAuthenticated(true);
      
      return true;
    } catch (error) {
      console.error('Login failed:', error);
      return false;
    }
  };
  
  const logout = () => {
    localStorage.removeItem('adminToken');
    localStorage.removeItem('csrfToken');
    setIsAuthenticated(false);
  };
  
  return { isAuthenticated, login, logout };
};

// Axios interceptors setup
const setupAxiosInterceptors = () => {
  // Request interceptor
  axios.interceptors.request.use((config) => {
    const token = localStorage.getItem('adminToken');
    const csrfToken = localStorage.getItem('csrfToken');
    
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    
    if (['post', 'put', 'delete', 'patch'].includes(config.method) && csrfToken) {
      config.headers['X-CSRF-Token'] = csrfToken;
    }
    
    return config;
  });
  
  // Response interceptor
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response?.status === 403) {
        const token = localStorage.getItem('adminToken');
        
        if (token) {
          try {
            const csrfRes = await axios.get('/api/auth/csrf-token', {
              headers: { Authorization: `Bearer ${token}` }
            });
            
            localStorage.setItem('csrfToken', csrfRes.data.csrfToken);
            
            // Retry request
            error.config.headers['X-CSRF-Token'] = csrfRes.data.csrfToken;
            return axios(error.config);
          } catch {
            // Logout on failure
            localStorage.clear();
            window.location.href = '/login';
          }
        }
      }
      
      return Promise.reject(error);
    }
  );
};
```

---

## Testing CSRF Protection

### Test 1: Request Without CSRF Token (Should Fail)
```javascript
// This should return 403 Forbidden
const response = await axios.post('/api/admin/product-orders/123/status', 
  { status: 'Shipped' },
  {
    headers: {
      'Authorization': 'Bearer <token>'
      // No X-CSRF-Token header
    }
  }
);
```

### Test 2: Request With Valid CSRF Token (Should Succeed)
```javascript
// This should work
const response = await axios.post('/api/admin/product-orders/123/status', 
  { status: 'Shipped' },
  {
    headers: {
      'Authorization': 'Bearer <token>',
      'X-CSRF-Token': '<csrf-token>'
    }
  }
);
```

---

## Important Notes

1. **GET requests don't need CSRF tokens** - Only POST, PUT, DELETE, PATCH
2. **CSRF tokens expire after 1 hour** - Implement refresh logic
3. **One CSRF token per user** - Token is tied to user ID
4. **Store securely** - Don't expose CSRF token in URLs or logs
5. **Admin routes only** - Currently CSRF is enforced on admin routes

---

## Troubleshooting

### Error: "Invalid CSRF token"
- Check if token is being sent in `X-CSRF-Token` header
- Verify token hasn't expired (1 hour lifetime)
- Ensure user is authenticated first
- Refresh token and retry

### Error: "Authentication required"
- User is not logged in
- JWT token is missing or invalid
- Login again to get new tokens

### Error: 403 Forbidden
- CSRF token is invalid or expired
- Request is missing CSRF token
- Fetch new CSRF token from `/api/auth/csrf-token`

---

## Security Benefits

With CSRF protection:
- ✅ Attackers can't trick users into performing unwanted actions
- ✅ Malicious websites can't send requests using user's credentials
- ✅ State-changing operations require valid CSRF token
- ✅ Tokens expire automatically for security
- ✅ All security events are logged

---

## Support

For issues or questions:
1. Check browser console for errors
2. Verify token is being sent in headers
3. Check backend logs: `logs/security.log`
4. Contact backend team

---

**Last Updated**: November 25, 2024  
**Version**: 1.0
