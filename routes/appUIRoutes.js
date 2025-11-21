const express = require('express');
const router = express.Router();
const appUIController = require('../controllers/appUIController');
const { protectAdmin } = require('../middleware/auth');
const upload = require('../config/multer');

// Public routes (for mobile app to fetch UI settings)
router.get('/pages', appUIController.getAllPageUIs);
router.get('/pages/:page', appUIController.getPageUI);

// Admin routes (protected)
router.put('/pages/:page', protectAdmin, appUIController.updatePageUI);
router.post('/pages/:page/upload/:type', protectAdmin, upload.single('image'), appUIController.uploadUIImage);
router.delete('/pages/:page/image/:type', protectAdmin, appUIController.deleteUIImage);
router.post('/initialize', protectAdmin, appUIController.initializeDefaults);

module.exports = router;
