const multer = require('multer');

const MAX_CHAT_FILE_SIZE = 15 * 1024 * 1024;

// SVG/HTML and executable/archive formats are intentionally excluded. They can
// execute active content or conceal unsafe payloads when opened from a chat.
const ALLOWED_CHAT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/rtf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const chatAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_CHAT_FILE_SIZE },
  fileFilter: (_req, file, done) => {
    if (!ALLOWED_CHAT_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
      return done(new Error('Unsupported file type. Upload an image, PDF, text, Word, Excel, or PowerPoint file.'));
    }
    done(null, true);
  },
});

const receiveChatAttachment = (req, res, next) => {
  chatAttachmentUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'File is too large. Maximum size is 15 MB.' });
    }
    return res.status(400).json({ success: false, message: error.message || 'Could not read this file.' });
  });
};

module.exports = {
  ALLOWED_CHAT_MIME_TYPES,
  MAX_CHAT_FILE_SIZE,
  receiveChatAttachment,
};
