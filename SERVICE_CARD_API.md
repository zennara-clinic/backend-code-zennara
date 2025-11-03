# Service Card API Documentation

## Overview
Service cards are filled by admin staff before completing a service in a package assignment. They track service delivery details including doctor, therapist, manager, and patient relief grading.

## Flow
1. Admin fills service card form (doctor, therapist, manager, grading)
2. Service card is saved temporarily
3. Admin sends OTP to user
4. User verifies OTP
5. Service is marked complete with service card data attached
6. User can view service cards in mobile app

## Admin Endpoints

### 1. Save Service Card
**POST** `/api/package-assignments/service-card`
**Auth:** Admin only

**Body:**
```json
{
  "assignmentId": "67085d960f01e5344fe10fbf",
  "serviceId": "service-123",
  "doctor": "Dr. Spoorthy",
  "therapist": "John Doe",  // Optional
  "manager": "Irans",
  "grading": 8,  // 0-10 scale
  "notes": "Patient showed significant improvement"  // Optional
}
```

**Response:**
```json
{
  "success": true,
  "message": "Service card saved successfully. You can now send OTP to complete the service.",
  "data": {
    "serviceId": "service-123",
    "serviceName": "Laser Hair Removal"
  }
}
```

### 2. Send Service OTP (Updated)
**POST** `/api/package-assignments/send-otp`
**Auth:** Admin only

**Requirements:**
- Service card MUST be saved before sending OTP
- Will return error if service card doesn't exist

**Body:**
```json
{
  "assignmentId": "67085d960f01e5344fe10fbf",
  "serviceId": "service-123",
  "userId": "user-id-here"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP sent successfully to user email"
}
```

**Error (if service card not filled):**
```json
{
  "success": false,
  "message": "Please fill the service card before sending OTP"
}
```

### 3. Verify OTP (Updated)
**POST** `/api/package-assignments/verify-otp`
**Auth:** Admin only

**Body:**
```json
{
  "assignmentId": "67085d960f01e5344fe10fbf",
  "serviceId": "service-123",
  "otp": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Service marked as completed",
  "isPackageCompleted": false,
  "completionPercentage": 50
}
```

**Note:** Service card data is automatically attached to the completed service.

## User Endpoints

### 4. Get Service Cards
**GET** `/api/package-assignments/user/my-packages/:assignmentId/service-cards`
**Auth:** User only

**Response:**
```json
{
  "success": true,
  "data": {
    "assignmentId": "PKG12345678",
    "packageName": "Complete Skin Care Package",
    "serviceCards": [
      {
        "serviceId": "service-123",
        "serviceName": "Laser Hair Removal in Hyderabad",
        "completedAt": "2024-11-03T10:30:00.000Z",
        "serviceCard": {
          "clientName": "Tahnavi",
          "clientId": "11062",
          "doctor": "Dr. Spoorthy",
          "therapist": "John Doe",
          "manager": "Irans",
          "grading": 8,
          "notes": "Patient showed significant improvement",
          "date": "2024-11-03T10:30:00.000Z"
        }
      }
    ]
  }
}
```

## Database Schema Updates

### PackageAssignment Model

**New Field: `pendingServiceCards`**
```javascript
pendingServiceCards: {
  type: Map,
  of: {
    doctor: String,
    therapist: String,
    manager: String,
    grading: Number,  // 0-10
    notes: String,
    createdAt: Date
  }
}
```

**Updated Field: `completedServices`**
```javascript
completedServices: [{
  serviceId: String,
  completedAt: Date,
  prescriptions: [String],
  serviceCard: {
    doctor: String,
    therapist: String,
    manager: String,
    grading: {
      type: Number,
      min: 0,
      max: 10
    },
    notes: String,
    createdAt: Date
  }
}]
```

## Validation Rules

1. **Doctor**: Required, string
2. **Manager**: Required, string
3. **Therapist**: Optional, string
4. **Grading**: Required, number between 0-10
5. **Notes**: Optional, string
6. **Service card must be saved before sending OTP**
7. **Service card must exist when verifying OTP**

## Error Handling

- **400**: Invalid input, missing fields, out of range grading
- **404**: Assignment not found, service not found, user not found
- **500**: Server errors (database, email sending, etc.)

## Admin Panel UI (To be implemented)

The admin panel should show a form when clicking "Complete Service" button:

```
┌─────────────────────────────────────┐
│     ZENNARA SERVICE CARD           │
├─────────────────────────────────────┤
│ Client Name: [Auto-filled]          │
│ Client ID: [Auto-filled]            │
│ Doctor: [___________] *Required     │
│ Therapist: [___________] Optional   │
│ Manager: [___________] *Required    │
│ Date: [Auto-filled]                 │
│ Relief Grading (0-10): [___] *Req   │
│ Notes: [_____________________]      │
│                                     │
│ [Save & Send OTP]    [Cancel]      │
└─────────────────────────────────────┘
```

## Mobile App UI (To be implemented)

Display service cards in a card format showing:
- Service name
- Completion date
- Doctor name
- Therapist name (if available)
- Manager name
- Relief grading (0-10 scale visualization)
- Notes

## Testing

1. **Save Service Card**: Test with valid/invalid data
2. **Send OTP without card**: Should fail with error
3. **Send OTP with card**: Should succeed
4. **Verify OTP**: Should complete service with card data
5. **View service cards**: Users should see their cards

## Next Steps

1. ✅ Backend API implemented
2. ⏳ Admin panel form UI
3. ⏳ Mobile app service card display
4. ⏳ Testing & QA
