const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protectAdmin, requirePermission } = require('../middleware/auth');
const bulk = require('../controllers/bulkController');

/**
 * Spreadsheets, not images — the shared config/multer.js filters to image
 * mimetypes, so bulk uploads need their own instance.
 *
 * 8 MB is generous for a catalogue: the largest realistic export here is a few
 * thousand rows, and a cap keeps a mis-drag of a video from being parsed.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const ok = /\.(csv|xlsx|xls)$/.test(name)
      || ['text/csv', 'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(file.mimetype);
    cb(ok ? null : new Error('Upload a CSV or XLSX file'), ok);
  },
});

router.use(protectAdmin);

// Exporting is the safe half; importing writes to the catalogue, so it carries
// the sensitive permission and is separately grantable.
router.get('/:entity/template', requirePermission('bulk.export', 'bulk.import'), bulk.template);
router.get('/:entity/export', requirePermission('bulk.export'), bulk.exportEntity);

router.post('/:entity/preview', requirePermission('bulk.import'), upload.single('file'), bulk.preview);
router.post('/:entity/commit', requirePermission('bulk.import'), upload.single('file'), bulk.commit);

module.exports = router;
