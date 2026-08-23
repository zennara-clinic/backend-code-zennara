const express = require('express');
const router = express.Router();
const ConsultationReview = require('../../models/ConsultationReview');
const Consultation = require('../../models/Consultation');

/** Recompute a treatment's rating/count from its approved reviews. */
async function syncConsultationRating(consultationId) {
  if (!consultationId) return;
  const rows = await ConsultationReview.find({ consultationId, isApproved: true }).select('rating').lean();
  const count = rows.length;
  const avg = count ? rows.reduce((sum, r) => sum + (r.rating || 0), 0) / count : 0;
  await Consultation.findByIdAndUpdate(consultationId, { rating: Math.round(avg * 10) / 10, reviews: count });
}
const { protectAdmin } = require('../../middleware/auth');

// Admin authentication middleware
router.use(protectAdmin);

// @desc    Get all consultation reviews
// @route   GET /api/admin/consultation-reviews
// @access  Private/Admin
router.get('/', async (req, res) => {
  try {
    const { isApproved, limit, page = 1, search } = req.query;
    const q = {};
    if (isApproved === 'true') q.isApproved = true;
    if (isApproved === 'false') q.isApproved = false;
    if (search) q.comment = { $regex: String(search).trim(), $options: 'i' };
    const perPage = Math.min(500, parseInt(limit, 10) || 200);
    const pageNo = Math.max(1, parseInt(page, 10) || 1);
    const [reviews, total] = await Promise.all([
      ConsultationReview.find(q)
        .populate('userId', 'fullName email phone profilePicture')
        .populate('consultationId', 'name title description')
        .populate('bookingId', 'date time')
        .sort({ createdAt: -1 })
        .skip((pageNo - 1) * perPage)
        .limit(perPage),
      ConsultationReview.countDocuments(q),
    ]);

    res.json({
      success: true,
      total,
      pagination: { currentPage: pageNo, totalPages: Math.ceil(total / perPage), total },
      data: reviews
    });
  } catch (error) {
    console.error('Get all consultation reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consultation reviews',
      error: error.message
    });
  }
});

// @desc    Update consultation review approval status
// @route   PUT /api/admin/consultation-reviews/:id/approval
// @access  Private/Admin
router.put('/:id/approval', async (req, res) => {
  try {
    const { isApproved } = req.body;
    const review = await ConsultationReview.findByIdAndUpdate(
      req.params.id,
      { isApproved },
      { new: true }
    ).populate('userId', 'fullName email phone profilePicture')
     .populate('consultationId', 'name title description');

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    await syncConsultationRating(review.consultationId?._id || review.consultationId);

    res.json({
      success: true,
      message: `Review ${isApproved ? 'approved' : 'unapproved'} successfully`,
      data: review
    });
  } catch (error) {
    console.error('Update consultation review approval error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update review approval',
      error: error.message
    });
  }
});

// @desc    Delete a consultation review
// @route   DELETE /api/admin/consultation-reviews/:id
// @access  Private/Admin
router.delete('/:id', async (req, res) => {
  try {
    const review = await ConsultationReview.findByIdAndDelete(req.params.id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    await syncConsultationRating(review.consultationId);

    res.json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    console.error('Delete consultation review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete review',
      error: error.message
    });
  }
});

module.exports = router;
