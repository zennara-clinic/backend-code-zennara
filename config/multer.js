const multer = require('multer');
const path = require('path');

// Configure multer for memory storage (we'll upload to cloudinary directly)
const storage = multer.memoryStorage();

// File filter for images and videos
const fileFilter = (req, file, cb) => {
  // Allowed file types
  const allowedImageTypes = /jpeg|jpg|png|gif|webp/;
  const allowedVideoTypes = /mp4|mov|avi|wmv|flv|webm/;
  
  const extname = path.extname(file.originalname).toLowerCase();
  const mimetype = file.mimetype;

  // Check if image
  if (mimetype.startsWith('image/') && allowedImageTypes.test(extname.slice(1))) {
    return cb(null, true);
  }
  
  // Check if video
  if (mimetype.startsWith('video/') && allowedVideoTypes.test(extname.slice(1))) {
    return cb(null, true);
  }

  cb(new Error('Invalid file type. Only images (JPEG, JPG, PNG, GIF, WebP) and videos (MP4, MOV, AVI, WMV, FLV, WebM) are allowed.'));
};

// Multer configuration
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

module.exports = upload;
