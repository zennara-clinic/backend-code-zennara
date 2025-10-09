# Zennara V2 Backend API

Backend API for Zennara mobile application built with Node.js, Express, and MongoDB Atlas.

## Features

- ✅ User Registration (3-step signup flow)
- ✅ Email-based OTP Authentication
- ✅ JWT Token Management
- ✅ MongoDB Atlas Integration
- ✅ Email Service (OTP & Welcome emails)
- ✅ Protected Routes with Middleware

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB Atlas
- **Authentication**: JWT (JSON Web Tokens)
- **Email Service**: Nodemailer
- **Security**: bcryptjs for password hashing

## Prerequisites

- Node.js (v14 or higher)
- MongoDB Atlas account
- Email service credentials (Gmail/SMTP)

## Installation

1. **Install dependencies**
```bash
npm install
```

2. **Configure environment variables**

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# MongoDB Atlas Connection
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/zennara?retryWrites=true&w=majority

# JWT Secret
JWT_SECRET=your_super_secret_jwt_key_here
JWT_EXPIRE=7d

# Email Configuration (Gmail example)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=Zennara <noreply@zennara.com>
```

### Setting up MongoDB Atlas

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Create a free cluster
3. Create a database user
4. Whitelist your IP address (or use 0.0.0.0/0 for development)
5. Get your connection string and replace `MONGODB_URI` in `.env`

### Setting up Email Service (Gmail)

1. Enable 2-Factor Authentication on your Gmail account
2. Generate an App Password:
   - Go to Google Account Settings
   - Security → 2-Step Verification → App Passwords
   - Generate a new app password
3. Use this app password in `EMAIL_PASSWORD` field

## Running the Server

### Development Mode (with auto-restart)
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

Server will run on `http://localhost:5000`

## API Endpoints

### Authentication Routes

#### 1. User Registration
```http
POST /api/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "fullName": "John Doe",
  "phone": "9876543210",
  "location": "Jubilee Hills",
  "dateOfBirth": "15/08/1990",
  "gender": "Male"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Registration successful! Please login to continue.",
  "data": {
    "userId": "60d5f4e3c8b3a123456789",
    "email": "user@example.com",
    "fullName": "John Doe"
  }
}
```

#### 2. Login (Send OTP)
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP sent successfully to your email",
  "data": {
    "email": "user@example.com",
    "expiresIn": "10 minutes"
  }
}
```

#### 3. Verify OTP
```http
POST /api/auth/verify-otp
Content-Type: application/json

{
  "email": "user@example.com",
  "otp": "1234"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "60d5f4e3c8b3a123456789",
      "email": "user@example.com",
      "fullName": "John Doe",
      "phone": "9876543210",
      "location": "Jubilee Hills",
      "dateOfBirth": "15/08/1990",
      "gender": "Male",
      "isVerified": true
    }
  }
}
```

#### 4. Resend OTP
```http
POST /api/auth/resend-otp
Content-Type: application/json

{
  "email": "user@example.com"
}
```

#### 5. Get Current User Profile (Protected)
```http
GET /api/auth/me
Authorization: Bearer <your-jwt-token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "60d5f4e3c8b3a123456789",
    "email": "user@example.com",
    "fullName": "John Doe",
    "phone": "9876543210",
    "location": "Jubilee Hills",
    "dateOfBirth": "15/08/1990",
    "gender": "Male",
    "isVerified": true,
    "createdAt": "2024-01-15T10:30:00.000Z"
  }
}
```

## Authentication Flow

### Signup Flow (Matches UI 3-step process):
1. **Step 1**: User selects location (Jubilee Hills, Financial District, Kondapur)
2. **Step 2**: User enters personal info (email, full name, phone)
3. **Step 3**: User enters additional details (date of birth, gender)
4. **Result**: Account created → Redirected to login

### Login Flow:
1. User enters email
2. Backend sends 4-digit OTP to email
3. User enters OTP in app
4. Backend verifies OTP
5. Returns JWT token + user data
6. User is authenticated and can access the app

## Project Structure

```
Backend/
├── config/
│   └── db.js                 # MongoDB connection
├── controllers/
│   └── authController.js     # Auth logic
├── middleware/
│   └── auth.js               # JWT authentication middleware
├── models/
│   └── User.js               # User schema
├── routes/
│   └── auth.js               # Auth routes
├── utils/
│   └── emailService.js       # Email sending service
├── .env                      # Environment variables (create this)
├── .env.example              # Environment variables template
├── .gitignore               
├── package.json              
├── README.md                 
└── server.js                 # Main server file
```

## Error Handling

All endpoints return consistent error responses:

```json
{
  "success": false,
  "message": "Error description here"
}
```

Common error codes:
- `400` - Bad Request (validation errors)
- `401` - Unauthorized (invalid/expired token)
- `404` - Not Found (user/resource not found)
- `500` - Server Error

## Security Features

- ✅ JWT token-based authentication
- ✅ OTP expires after 10 minutes
- ✅ Email validation
- ✅ Phone number validation (10 digits)
- ✅ Protected routes with middleware
- ✅ MongoDB injection prevention
- ✅ CORS enabled

## Testing with Postman/Thunder Client

1. Import the API endpoints
2. Set base URL: `http://localhost:5000`
3. Test signup → login → verify-otp flow
4. Use returned token in Authorization header for protected routes

## Development Notes

- OTP is 4 digits (matches UI)
- OTP valid for 10 minutes
- JWT tokens expire in 7 days (configurable)
- Email templates use Zennara branding (#20594e green color)
- All timestamps use ISO format
- User locations limited to 3 Zennara clinic locations

## Future Enhancements

- [ ] Phone OTP (SMS) integration
- [ ] Password reset functionality
- [ ] Social media authentication
- [ ] Rate limiting for OTP requests
- [ ] User profile update endpoints
- [ ] Appointment booking APIs
- [ ] Treatment booking APIs
- [ ] Pharmacy/Medicine APIs

## Support

For issues or questions, please contact the development team.

---

**Version**: 1.0.0  
**Last Updated**: January 2025
