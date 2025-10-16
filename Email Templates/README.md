# Zennara Email Templates

Complete email template system for Zennara Clinic appointment management.

## 📧 Available Templates

### Authentication Templates
1. **OTP Email** (`otpEmailTemplate.js`)
   - Sent when user requests login OTP
   - Parameters: `fullName`, `otp`, `branch`

2. **Welcome Email** (`welcomeEmailTemplate.js`)
   - Sent after successful registration
   - Parameters: `fullName`, `branch`

### Appointment Flow Templates
3. **Appointment Booking Confirmation** (`appointmentBookingConfirmation.js`)
   - Status: "Awaiting Confirmation"
   - Sent immediately after user books appointment
   - Parameters: `fullName`, `bookingData`, `branch`

4. **Appointment Confirmed** (`appointmentConfirmed.js`)
   - Status: "Confirmed"
   - Sent when admin confirms the appointment
   - Parameters: `fullName`, `appointmentData`, `branch`

5. **Appointment Reminder** (`appointmentReminder.js`)
   - Sent 24 hours before appointment
   - Parameters: `fullName`, `appointmentData`, `branch`

6. **Appointment Rescheduled** (`appointmentRescheduled.js`)
   - Status: "Rescheduled"
   - Sent when appointment date/time changes
   - Parameters: `fullName`, `appointmentData`, `branch`

7. **Appointment Cancelled** (`appointmentCancelled.js`)
   - Status: "Cancelled"
   - Sent when appointment is cancelled
   - Parameters: `fullName`, `appointmentData`, `branch`

8. **Appointment Completed** (`appointmentCompleted.js`)
   - Status: "Completed"
   - Sent after appointment completion
   - Parameters: `fullName`, `appointmentData`, `branch`

### Feedback & Follow-up Templates
9. **Rating Request** (`ratingRequest.js`)
   - Sent 24 hours after completed appointment
   - Directs users to rate via app only
   - Parameters: `fullName`, `appointmentData`, `branch`

10. **No-Show Notification** (`noShowNotification.js`)
    - Status: "No Show"
    - Sent when patient misses appointment
    - Parameters: `fullName`, `appointmentData`, `branch`

11. **Check-in Successful** (`checkInSuccessful.js`)
    - Sent when patient checks in at clinic
    - Parameters: `fullName`, `appointmentData`, `branch`

## 🎨 Design Features

- **Font**: Poppins (Google Fonts)
- **Color Scheme**: 
  - Green Gradient Header: `#47d77d` to `#0a6049`
  - Text Colors: Dark green (`#0a6049`), Gray (`#555555`)
- **Logo**: White Zennara logo from Cloudinary
- **Responsive**: Mobile-optimized with breakpoints
- **Clean Design**: Minimalistic, no unnecessary colored boxes

## 📝 Usage Example

```javascript
const { getAppointmentConfirmedTemplate } = require('./Email Templates');

const emailHTML = getAppointmentConfirmedTemplate(
  'John Doe',
  {
    referenceNumber: 'ZEN2025001234',
    treatment: 'Chemical Peel',
    confirmedDate: 'Friday, October 10, 2025',
    confirmedTime: '3:00 PM',
    location: 'Jubilee Hills',
    address: 'House no 8-2-293/82/A/454/A, Road no 19'
  },
  'Jubilee Hills'
);
```

## 🏢 Branch Information

Default branch is "Jubilee Hills". Available branches:
- Jubilee Hills
- Financial District
- Kondapur

## ✨ Key Design Principles

1. **No pricing information** - Templates focus on appointment details only
2. **App-only ratings** - Users directed to app for feedback, no external forms
3. **Minimalistic design** - Clean, to-the-point content
4. **Mobile responsive** - Optimized for all screen sizes
5. **Brand consistency** - Zennara Clinic branding throughout

## 📱 Integration Notes

- All rating/feedback requests direct users to the Zennara mobile app
- No external forms or links for ratings
- Templates are designed to work with the appointment booking flow
- Each template supports custom branch information

## 🔄 Template Workflow

```
Registration → Welcome Email
Login → OTP Email
Book Appointment → Booking Confirmation
Confirm Appointment → Appointment Confirmed
24hrs Before → Appointment Reminder
Reschedule → Appointment Rescheduled
Cancel → Appointment Cancelled
Complete → Appointment Completed → Rating Request (24hrs later)
No Show → No-Show Notification
Check-in → Check-in Successful
```

## 📦 Export

All templates are exported from `index.js` for easy importing:

```javascript
const emailTemplates = require('./Email Templates');
```
