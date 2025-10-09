# Mobile App Integration Guide

This guide shows how to connect your Zennara mobile app to the backend API.

## Prerequisites

1. ✅ Backend server running on `http://localhost:5000`
2. ✅ MongoDB Atlas connected
3. ✅ Email service configured

## Files Created

I've created two service files in your mobile app:

```
Zennara App/
└── services/
    ├── api.ts          # API calls to backend
    └── storage.ts      # AsyncStorage management
```

## Integration Steps

### Step 1: Install Required Packages

Your app should already have these, but verify:

```bash
cd "Zennara App"
npm install @react-native-async-storage/async-storage
```

### Step 2: Update Signup Screen

Replace the mock API call in `app/signup.tsx`:

**Before (line 86-92):**
```typescript
// Mock registration - replace with your backend API
// After successful registration, redirect to login for OTP verification
setTimeout(() => {
  setLoading(false);
  // Account created successfully, now user needs to login via OTP
  router.push('/login');
}, 1000);
```

**After:**
```typescript
import { authApi } from '../services/api';

// Inside handleRegister function:
try {
  const response = await authApi.signup({
    email,
    fullName,
    phone,
    location,
    dateOfBirth: dob,
    gender
  });

  setLoading(false);
  
  if (response.success) {
    // Show success message
    alert('Registration successful! Please login to continue.');
    router.push('/login');
  }
} catch (error: any) {
  setLoading(false);
  setError(error.message || 'Registration failed. Please try again.');
}
```

### Step 3: Update Login Screen

Replace the mock API call in `app/login.tsx`:

**Before (line 29-34):**
```typescript
// Mock API call - replace with your backend
setTimeout(() => {
  setLoading(false);
  // Navigate to OTP screen
  router.push('/otp');
}, 1000);
```

**After:**
```typescript
import { authApi } from '../services/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Inside handleLogin function:
try {
  const response = await authApi.login(email);

  setLoading(false);
  
  if (response.success) {
    // Store email for OTP verification
    await AsyncStorage.setItem('@zennara_temp_email', email);
    
    // Show success message
    alert('OTP sent to your email!');
    router.push('/otp');
  }
} catch (error: any) {
  setLoading(false);
  setError(error.message || 'Failed to send OTP. Please try again.');
}
```

### Step 4: Update OTP Screen

Replace the mock verification in `app/otp.tsx`:

**Before (line 54-59):**
```typescript
// Mock API call - replace with your backend
setTimeout(() => {
  setLoading(false);
  // Navigate to main app
  router.replace('/(tabs)');
}, 1000);
```

**After:**
```typescript
import { authApi } from '../services/api';
import { storageService } from '../services/storage';
import AsyncStorage from '@react-native-async-storage/async-storage';

// At the top, get email:
const [email, setEmail] = useState('');

useEffect(() => {
  // Get email from previous screen
  AsyncStorage.getItem('@zennara_temp_email').then((storedEmail) => {
    if (storedEmail) {
      setEmail(storedEmail);
    }
  });
}, []);

// Inside handleVerify function:
try {
  const otpValue = otp.join('');
  const response = await authApi.verifyOTP(email, otpValue);

  if (response.success && response.data) {
    // Save auth token and user data
    await storageService.saveAuthToken(response.data.token);
    await storageService.saveUserData(response.data.user);
    
    // Clear temporary email
    await AsyncStorage.removeItem('@zennara_temp_email');
    
    setLoading(false);
    
    // Navigate to main app
    router.replace('/(tabs)');
  }
} catch (error: any) {
  setLoading(false);
  setError(error.message || 'Invalid OTP. Please try again.');
}
```

**Also update handleResendOTP:**
```typescript
const handleResendOTP = async () => {
  try {
    setOtp(['', '', '', '']);
    setError(null);
    
    const response = await authApi.resendOTP(email);
    
    if (response.success) {
      alert('OTP resent to your email!');
      inputRefs[0].current?.focus();
    }
  } catch (error: any) {
    setError(error.message || 'Failed to resend OTP.');
  }
};
```

### Step 5: Update API URL for Android Testing

If testing on Android device/emulator, update the API base URL in `services/api.ts`:

**For Android Emulator:**
```typescript
const API_BASE_URL = 'http://10.0.2.2:5000/api';
```

**For Physical Android Device (same network):**
```typescript
// Find your computer's local IP address
// Windows: ipconfig (look for IPv4 Address)
// Mac: ifconfig (look for inet)
const API_BASE_URL = 'http://192.168.1.XXX:5000/api';
```

**For iOS Simulator:**
```typescript
const API_BASE_URL = 'http://localhost:5000/api';
```

## Complete Integration Example

Here's a complete example of the updated `login.tsx`:

```typescript
import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { authApi } from '../services/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function Login() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const insets = useSafeAreaInsets();

  const handleLogin = async () => {
    if (!email) {
      setError('Please enter your email');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await authApi.login(email);

      if (response.success) {
        // Store email for OTP verification
        await AsyncStorage.setItem('@zennara_temp_email', email);
        
        setLoading(false);
        router.push('/otp');
      }
    } catch (error: any) {
      setLoading(false);
      setError(error.message || 'Failed to send OTP. Please try again.');
    }
  };

  // ... rest of the component (UI code remains the same)
}
```

## Testing the Integration

### Test Flow:

1. **Start Backend:**
   ```bash
   cd Backend
   npm run dev
   ```

2. **Start Mobile App:**
   ```bash
   cd "Zennara App"
   npx expo start
   ```

3. **Test Signup:**
   - Fill all 3 steps
   - Submit registration
   - Check backend logs for user creation
   - Check email for welcome email (optional)

4. **Test Login:**
   - Enter registered email
   - Check email for OTP (4 digits)
   - Check backend logs for OTP generation

5. **Test OTP Verification:**
   - Enter OTP from email
   - Should navigate to main app
   - Check AsyncStorage for saved token

### Debugging Tips:

**Check if backend is running:**
```bash
curl http://localhost:5000
```

**Check mobile app logs:**
```bash
npx expo start
# Press 'j' to open debugger
# Check console for API errors
```

**Check AsyncStorage (React Native Debugger):**
```javascript
import AsyncStorage from '@react-native-async-storage/async-storage';

// Get all keys
AsyncStorage.getAllKeys().then(keys => console.log(keys));

// Get token
AsyncStorage.getItem('@zennara_auth_token').then(token => console.log(token));
```

## Common Issues & Solutions

### Issue 1: Network Request Failed
**Solution:** Update API URL for your platform (see Step 5)

### Issue 2: CORS Error
**Solution:** Already handled in backend with `cors()` middleware

### Issue 3: OTP Not Receiving
**Solution:** 
- Check backend logs for email sending errors
- Verify EMAIL_USER and EMAIL_PASSWORD in .env
- Check spam folder

### Issue 4: Token Not Saving
**Solution:**
- Check if AsyncStorage is installed
- Verify storageService is imported correctly
- Check console for AsyncStorage errors

## Next Steps

After successful integration:

1. ✅ Add profile screen to display user data
2. ✅ Add logout functionality
3. ✅ Add token refresh logic
4. ✅ Add protected route handling
5. ✅ Build appointment booking APIs
6. ✅ Build treatment booking APIs
7. ✅ Build pharmacy APIs

## Support

If you encounter any issues:
1. Check backend logs: `npm run dev`
2. Check mobile app logs: React Native Debugger
3. Verify .env configuration
4. Test API endpoints with Postman first

---

Happy integrating! 🚀
