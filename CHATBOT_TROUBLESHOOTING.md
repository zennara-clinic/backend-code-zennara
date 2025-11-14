# Chatbot Troubleshooting Guide

## 🔍 How to Check if Everything is Working

### 1. **Check if Murf AI is Configured**

Open your terminal and run:
```bash
node -e "console.log('MURF_AI_API_KEY:', process.env.MURF_AI_API_KEY ? 'Configured ✓' : 'Missing ✗')"
```

Or check your `.env` file:
```bash
# In Backend/.env file, you should have:
MURF_AI_API_KEY=your_actual_api_key_here
```

### 2. **Check Server Logs**

When a user asks a question, you should see these logs in your server console:

```
🎯 User query: "when can i get the delivery" → Detected intent: ORDER_STATUS
🎙️ Generating voice response with Murf AI...
✅ Murf AI voice generated successfully
```

Or if Murf AI is not configured:
```
🎯 User query: "when can i get the delivery" → Detected intent: ORDER_STATUS
🎙️ Generating voice response with Murf AI...
❌ Murf AI failed: Murf AI API key not configured
```

### 3. **Test Intent Detection**

The chatbot should now correctly understand these types of questions:

**Delivery Questions:**
- "when can i get the delivery"
- "when will my order arrive"
- "how long until delivery"
- "delivery time"

**Should return:** `ORDER_STATUS` intent

**Order Questions:**
- "what's my order status"
- "where is my package"
- "track my order"

**Should return:** `ORDER_STATUS` intent

**Appointment Questions:**
- "what are my upcoming appointments"
- "when is my next consultation"
- "show my bookings"

**Should return:** `UPCOMING_BOOKINGS` intent

### 4. **What Was Fixed**

#### Problem 1: Wrong Intent Detection
❌ **Before:** "when can i get the delivery" → Returned SERVICES_INFO (wrong!)
✅ **After:** "when can i get the delivery" → Returns ORDER_STATUS (correct!)

#### Problem 2: No Murf AI Logging
❌ **Before:** Silent failures, couldn't tell if Murf AI was working
✅ **After:** Clear logs showing if Murf AI succeeds or fails

### 5. **How to Get Murf AI API Key**

1. Go to https://murf.ai
2. Sign up / Log in
3. Go to Settings → API Keys
4. Generate a new API key
5. Copy and paste into `.env` file:
   ```
   MURF_AI_API_KEY=your_key_here
   ```
6. Restart your server

### 6. **Test the Chatbot**

Try these questions in order:

1. **"what's the status of my first order"**
   - Should show order count and details
   - Intent: ORDER_INFO or ORDER_STATUS

2. **"when can i get the delivery"**
   - Should talk about active orders and delivery status
   - Intent: ORDER_STATUS
   - Should NOT talk about services!

3. **"show my appointments"**
   - Should show booking information
   - Intent: BOOKING_INFO or UPCOMING_BOOKINGS

4. **"what services do you offer"**
   - Should list consultation services
   - Intent: SERVICES_INFO

### 7. **Expected Behavior**

✅ **Text Responses:** Always work (even without Murf AI)
✅ **Voice Responses:** Only work if Murf AI API key is configured
✅ **Mobile App:** Text chat works, voice input disabled (by design)
✅ **Web Browser:** Full voice features available

### 8. **Common Issues**

#### Issue: "Your browser does not support voice"
**Solution:** This is normal on mobile apps. Voice input only works in web browsers.

#### Issue: Responses are wrong/irrelevant
**Solution:** Check server logs to see which intent was detected. The fix should resolve delivery question issues.

#### Issue: No audio responses
**Solution:** 
1. Check if `MURF_AI_API_KEY` is in `.env`
2. Check server logs for Murf AI errors
3. Verify API key is valid

#### Issue: Getting services info for delivery questions
**Solution:** This is now fixed! Restart your server to apply the changes.

### 9. **Restart Server**

After making changes:
```bash
# Stop server (Ctrl + C)
# Then restart
npm run dev
```

### 10. **Success Indicators**

You know it's working when:
- ✅ Server logs show correct intent detection
- ✅ Responses match the question asked
- ✅ Murf AI logs show success (if configured)
- ✅ Mobile app shows text responses
- ✅ Users can type and get intelligent answers

---

## 📊 Monitoring

Watch your server console for these patterns:

**Good:**
```
🎯 User query: "when can i get the delivery" → Detected intent: ORDER_STATUS
✅ Murf AI voice generated successfully
```

**Needs Attention:**
```
🎯 User query: "when can i get the delivery" → Detected intent: SERVICES_INFO
❌ Wrong intent! Should be ORDER_STATUS
```

**Murf AI Not Configured (OK for text-only):**
```
❌ Murf AI failed: Murf AI API key not configured
(Users still get text responses)
```
