const express = require('express');
const router = express.Router();
const appUIController = require('../controllers/appUIController');
const { protect, admin } = require('../middleware/auth');
const upload = require('../config/multer');

// Public routes (for mobile app to fetch UI settings)
router.get('/pages', appUIController.getAllPageUIs);
router.get('/pages/:page', appUIController.getPageUI);

// Admin routes (protected)
router.put('/pages/:page', protect, admin, appUIController.updatePageUI);
router.post('/pages/:page/upload/:type', protect, admin, upload.single('image'), appUIController.uploadUIImage);
router.delete('/pages/:page/image/:type', protect, admin, appUIController.deleteUIImage);
router.post('/initialize', protect, admin, appUIController.initializeDefaults);

module.exports = router;
