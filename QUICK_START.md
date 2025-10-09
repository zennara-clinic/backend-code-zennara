# Quick Start Guide - Zennara Backend

Get your backend up and running in 5 minutes!

## Step 1: Install Dependencies

```bash
cd Backend
npm install
```

## Step 2: Setup MongoDB Atlas

1. Go to https://www.mongodb.com/cloud/atlas/register
2. Create a **FREE** M0 cluster (no credit card required)
3. Create a database user:
   - Username: `zennara_admin`
   - Password: `your_secure_password`
4. Network Access: Add IP Address
   - Click "Add IP Address"
   - Select "Allow Access from Anywhere" (0.0.0.0/0) for development
5. Get connection string:
   - Click "Connect" → "Connect your application"
   - Copy the connection string
   - Replace `<password>` with your actual password

## Step 3: Setup Gmail App Password

1. Go to your Google Account: https://myaccount.google.com/
2. Security → 2-Step Verification (enable if not enabled)
3. Security → App passwords
4. Select app: "Mail", Select device: "Other" (type "Zennara")
5. Click "Generate"
6. Copy the 16-character password

## Step 4: Create .env File

Create a file named `.env` in the Backend folder:

```env
PORT=5000
NODE_ENV=development

# Replace with your MongoDB connection string
MONGODB_URI=mongodb+srv://zennara_admin:YOUR_PASSWORD@cluster0.xxxxx.mongodb.net/zennara?retryWrites=true&w=majority

# Generate a random secret (or use any long random string)
JWT_SECRET=zennara_super_secret_key_2025_xyz123abc456
JWT_EXPIRE=7d

# Replace with your Gmail credentials
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-16-char-app-password
EMAIL_FROM=Zennara <noreply@zennara.com>
```

## Step 5: Start the Server

```bash
npm run dev
```

You should see:
```
✅ MongoDB Connected: cluster0-shard-xxx.mongodb.net
🚀 Server running on port 5000 in development mode
```

## Step 6: Test the API

Open your browser and go to:
```
http://localhost:5000
```

You should see:
```json
{
  "message": "Zennara API is running",
  "version": "1.0.0",
  "status": "healthy"
}
```

## Testing with Postman

### Test 1: Signup
```
POST http://localhost:5000/api/auth/signup
Content-Type: application/json

{
  "email": "test@example.com",
  "fullName": "Test User",
  "phone": "9876543210",
  "location": "Jubilee Hills",
  "dateOfBirth": "15/08/1990",
  "gender": "Male"
}
```

### Test 2: Login (Get OTP)
```
POST http://localhost:5000/api/auth/login
Content-Type: application/json

{
  "email": "test@example.com"
}
```

Check your email for the 4-digit OTP!

### Test 3: Verify OTP
```
POST http://localhost:5000/api/auth/verify-otp
Content-Type: application/json

{
  "email": "test@example.com",
  "otp": "1234"
}
```

You'll get a JWT token in response!

## Troubleshooting

### MongoDB Connection Failed
- Check if your IP is whitelisted in MongoDB Atlas
- Verify username and password in connection string
- Ensure network access is configured

### Email Not Sending
- Verify Gmail App Password is correct (no spaces)
- Ensure 2-Factor Authentication is enabled on Gmail
- Check if EMAIL_USER and EMAIL_PASSWORD are correct in .env

### Port Already in Use
- Change PORT in .env to 5001 or any available port
- Kill the process using port 5000: `npx kill-port 5000`

## Next Steps

1. ✅ Backend is running
2. Update your mobile app to use `http://localhost:5000/api/auth/*` endpoints
3. Test the complete flow: Signup → Login → OTP → Access App
4. Build additional features (appointments, treatments, pharmacy)

## Quick Commands Reference

```bash
# Install dependencies
npm install

# Run in development (auto-restart)
npm run dev

# Run in production
npm start

# Check logs
# Server logs will appear in terminal
```

## Need Help?

- MongoDB Atlas Docs: https://docs.atlas.mongodb.com/
- Nodemailer Docs: https://nodemailer.com/
- Express.js Docs: https://expressjs.com/

---

Happy coding! 🚀
