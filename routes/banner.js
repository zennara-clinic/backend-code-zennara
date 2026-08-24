const express = require('express');
const router = express.Router();
const upload = require('../config/multer');
const { protect, protectAdmin, requireRole } = require('../middleware/auth');
const {
  createBanner,
  getAllBanners,
  getActiveBanners,
  getBanner,
  updateBanner,
  deleteBanner,
  toggleBannerStatus,
  reorderBanners
} = require('../controllers/bannerController');

router.get('/active', getActiveBanners);

// Admin-only routes — App Studio is the super admin's, not floor/clinical staff's.
router.use(protectAdmin);
router.use(requireRole('super_admin'));

router.post('/', upload.single('image'), createBanner);
router.get('/', getAllBanners);
router.get('/:id', getBanner);
router.put('/:id', upload.single('image'), updateBanner);
router.delete('/:id', deleteBanner);
router.patch('/:id/toggle', toggleBannerStatus);
router.post('/reorder', reorderBanners);

module.exports = router;
