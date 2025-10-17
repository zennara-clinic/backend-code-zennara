const express = require('express');
const router = express.Router();
const multer = require('multer');
const packageAssignmentController = require('../controllers/packageAssignmentController');
const { protectAdmin } = require('../middleware/auth');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Get all assignments with filters
router.get('/', protectAdmin, packageAssignmentController.getAllAssignments);

// Get assignment statistics
router.get('/stats', protectAdmin, packageAssignmentController.getAssignmentStats);

// Get single assignment
router.get('/:id', protectAdmin, packageAssignmentController.getAssignmentById);

// Create new assignment
router.post('/', protectAdmin, packageAssignmentController.createAssignment);

// Upload payment proof
router.post('/:id/payment-proof', protectAdmin, upload.single('proof'), packageAssignmentController.uploadPaymentProof);

// Send OTP for service completion
router.post('/send-otp', protectAdmin, packageAssignmentController.sendServiceOtp);

// Verify OTP and complete service
router.post('/verify-otp', protectAdmin, packageAssignmentController.verifyServiceOtp);

// Upload prescription for completed service
router.post('/:id/prescription', protectAdmin, packageAssignmentController.uploadPrescription);

// Send OTP for package cancellation
router.post('/:id/cancel/send-otp', protectAdmin, packageAssignmentController.sendCancellationOtp);

// Verify OTP and cancel package
router.post('/:id/cancel/verify-otp', protectAdmin, packageAssignmentController.verifyCancellationOtp);

// Update assignment
router.put('/:id', protectAdmin, packageAssignmentController.updateAssignment);

// Delete assignment
router.delete('/:id', protectAdmin, packageAssignmentController.deleteAssignment);

module.exports = router;
