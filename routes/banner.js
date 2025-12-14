const express = require('express');
const router = express.Router();
const upload = require('../config/multer');
const { protect, protectAdmin } = require('../middleware/auth');
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

router.use(protect);
router.use(protectAdmin);

router.post('/', upload.single('image'), createBanner);
router.get('/', getAllBanners);
router.get('/:id', getBanner);
router.put('/:id', upload.single('image'), updateBanner);
router.delete('/:id', deleteBanner);
router.patch('/:id/toggle', toggleBannerStatus);
router.post('/reorder', reorderBanners);

module.exports = router;
