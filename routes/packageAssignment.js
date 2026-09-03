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

// Service consent routes (user submits before service)
router.post('/:assignmentId/service-consent', protect, packageAssignmentController.submitServiceConsent);
router.get('/:assignmentId/service-consent/:serviceId', protect, packageAssignmentController.getServiceConsentStatus);

// ADMIN ROUTES
// Get all assignments with filters
router.get('/', protectAdmin, packageAssignmentController.getAllAssignments);

// Get assignment statistics
router.get('/stats', protectAdmin, packageAssignmentController.getAssignmentStats);

// Get single assignment
router.get('/:id', protectAdmin, packageAssignmentController.getAssignmentById);

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

module.exports = router;
