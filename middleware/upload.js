const multer = require('multer');
const sharp = require('sharp');
const cloudinary = require('../config/cloudinary');
const path = require('path');

// Configure multer to use memory storage
const storage = multer.memoryStorage();

// File filter to accept only images
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed.'), false);
  }
};

// Multer upload configuration
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Process and upload image to Cloudinary
const uploadToCloudinary = async (buffer, folder = 'zennara/profiles') => {
  try {
    // Process image with sharp (resize, optimize)
    const processedImage = await sharp(buffer)
      .resize(400, 400, {
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Upload to Cloudinary
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: folder,
          resource_type: 'image',
          transformation: [
            { width: 400, height: 400, crop: 'fill' },
            { quality: 'auto' },
            { fetch_format: 'auto' }
          ]
        },
        (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        }
      );

      uploadStream.end(processedImage);
    });
  } catch (error) {
    throw new Error('Image processing failed');
  }
};

// Delete image from Cloudinary
const deleteFromCloudinary = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
  }
};

// Middleware to upload profile picture with Cloudinary
const uploadProfilePicture = async (req, res, next) => {
  // Use multer to handle file upload
  upload.single('profilePicture')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            message: 'File size too large. Maximum size is 5MB'
          });
        }
        return res.status(400).json({
          success: false,
          message: `Upload error: ${err.message}`
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message || 'Invalid file upload'
      });
    }

    // If there's a file, upload to Cloudinary
    if (req.file) {
      try {
        console.log('📤 Uploading file to Cloudinary...');
        const result = await uploadToCloudinary(req.file.buffer, 'zennara/profiles');
        
        // Attach Cloudinary result to request
        req.cloudinaryResult = {
          url: result.secure_url,
          publicId: result.public_id
        };
        
        console.log('✅ File uploaded to Cloudinary:', result.secure_url);
      } catch (uploadError) {
        console.error('❌ Cloudinary upload error:', uploadError);
        return res.status(500).json({
          success: false,
          message: 'Failed to upload image to cloud storage'
        });
      }
    }

    next();
  });
};

module.exports = {
  upload,
  uploadToCloudinary,
  deleteFromCloudinary,
  uploadProfilePicture
};
