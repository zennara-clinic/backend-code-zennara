const express = require('express');
const router = express.Router();
const multer = require('multer');
const packageAssignmentController = require('../controllers/packageAssignmentController');
const { protectAdmin, protect, requireRole, requirePermission } = require('../middleware/auth');
// Packages are a commercial decision — the clinic assigns, prices, cancels and
// refunds them. Clinical staff read them (a doctor sees a guest's course, a
// therapist redeems sessions) but never create or change them.
const MANAGE = requirePermission('packages.manage');

// Configure multer for file uploads (using memory storage for S3 upload)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    // Accept images only
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// USER-FACING ROUTES (must be before admin routes to avoid conflicts)
router.get('/user/my-packages', protect, packageAssignmentController.getUserPackages);
router.get('/user/my-packages/:id', protect, packageAssignmentController.getUserPackageById);
router.get('/user/my-packages/:id/service-cards', protect, packageAssignmentController.getUserServiceCards);
// The customer books one of their package sessions (arrives at the desk as Awaiting Confirmation).
// By treatment is the route the app uses — a package needs no pre-set dates for
// the customer to book. The by-session route stays for a clinic-suggested date.
router.post('/user/my-packages/:id/book', protect, packageAssignmentController.bookServiceAsUser);
router.post('/user/my-packages/:id/sessions/:sessionId/book', protect, packageAssignmentController.bookSessionAsUser);

// Service consent routes (user submits before service)
router.post('/:assignmentId/service-consent', protect, packageAssignmentController.submitServiceConsent);
router.get('/:assignmentId/service-consent/:serviceId', protect, packageAssignmentController.getServiceConsentStatus);

// ADMIN ROUTES
// A dermatologist reads the packages of their own guests only.
const scope = require('../utils/doctorGuestScope');
const OWN_ASSIGNMENT = scope.ownRecord(require('../models/PackageAssignment'));

// Get all assignments with filters
router.get('/', protectAdmin, scope.scopedList({ bookingKey: null }), packageAssignmentController.getAllAssignments);

// Get assignment statistics
router.get('/stats', protectAdmin, scope.notForDoctors, packageAssignmentController.getAssignmentStats);

// Get single assignment
router.get('/:id', protectAdmin, OWN_ASSIGNMENT, packageAssignmentController.getAssignmentById);

// Create new assignment
router.post('/', protectAdmin, MANAGE, packageAssignmentController.createAssignment);

// Upload payment proof
router.post('/:id/payment-proof', protectAdmin, MANAGE, upload.single('proof'), packageAssignmentController.uploadPaymentProof);

// Save service card before sending OTP
router.post('/service-card', protectAdmin, MANAGE, packageAssignmentController.saveServiceCard);

// Send OTP for service completion
router.post('/send-otp', protectAdmin, MANAGE, packageAssignmentController.sendServiceOtp);

// Verify OTP and complete service
router.post('/verify-otp', protectAdmin, MANAGE, packageAssignmentController.verifyServiceOtp);

// Upload prescription for completed service
router.post('/:id/prescription', protectAdmin, MANAGE, packageAssignmentController.uploadPrescription);

// Send OTP for package cancellation
router.post('/:id/cancel/send-otp', protectAdmin, MANAGE, packageAssignmentController.sendCancellationOtp);

// Verify OTP and cancel package
router.post('/:id/cancel/verify-otp', protectAdmin, MANAGE, packageAssignmentController.verifyCancellationOtp);

// Update assignment
router.put('/:id', protectAdmin, MANAGE, packageAssignmentController.updateAssignment);
router.post('/:id/zenoti-push', protectAdmin, MANAGE, packageAssignmentController.pushToZenoti);

// Delete assignment
router.delete('/:id', protectAdmin, MANAGE, packageAssignmentController.deleteAssignment);

// Zenoti package actions (2026-09-06): freeze / unfreeze / transfer / refund / ledger.
const REFUND = requirePermission('packages.refund');
router.get('/:id/ledger', protectAdmin, OWN_ASSIGNMENT, packageAssignmentController.assignmentLedger);
router.post('/:id/freeze', protectAdmin, MANAGE, packageAssignmentController.freezeAssignment);
router.post('/:id/unfreeze', protectAdmin, MANAGE, packageAssignmentController.unfreezeAssignment);
router.post('/:id/transfer', protectAdmin, REFUND, packageAssignmentController.transferAssignment);
router.get('/:id/refund-preview', protectAdmin, MANAGE, packageAssignmentController.refundPreview);
router.post('/:id/refund', protectAdmin, REFUND, packageAssignmentController.refundAssignment);
// Push the expiry out for a guest who still has sessions owed; mirrored to Zenoti.
router.post('/:id/extend-expiry', protectAdmin, MANAGE, packageAssignmentController.extendAssignmentExpiry);

module.exports = router;
