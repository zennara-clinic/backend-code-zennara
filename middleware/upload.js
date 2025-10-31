const multer = require('multer');
const sharp = require('sharp');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, S3_BUCKET } = require('../config/s3');
const path = require('path');
const crypto = require('crypto');

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

// Process and upload image to S3
const uploadToS3 = async (buffer, folder = 'profiles') => {
  try {
    // Process image with sharp (resize, optimize)
    const processedImage = await sharp(buffer)
      .resize(400, 400, {
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Generate unique filename
    const fileKey = `zennara/${folder}/${crypto.randomBytes(16).toString('hex')}.jpg`;

    // Upload to S3
    const uploadParams = {
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: processedImage,
      ContentType: 'image/jpeg'
    };

    await s3Client.send(new PutObjectCommand(uploadParams));

    // Return S3 URL and key
    const url = `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileKey}`;
    
    return {
      secure_url: url,
      url: url,
      public_id: fileKey,
      publicId: fileKey
    };
  } catch (error) {
    console.error('S3 upload error:', error);
    throw new Error('Image processing failed');
  }
};

// Delete image from S3
const deleteFromS3 = async (fileKey) => {
  try {
    if (!fileKey) return;
    
    const deleteParams = {
      Bucket: S3_BUCKET,
      Key: fileKey
    };

    await s3Client.send(new DeleteObjectCommand(deleteParams));
  } catch (error) {
    console.error('Error deleting from S3:', error);
  }
};

// Middleware to upload profile picture with S3
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

    // If there's a file, upload to S3
    if (req.file) {
      try {
        console.log('📤 Uploading file to S3...');
        const result = await uploadToS3(req.file.buffer, 'profiles');
        
        // Attach S3 result to request (keeping same structure for backwards compatibility)
        req.cloudinaryResult = {
          url: result.url,
          publicId: result.publicId
        };
        
        console.log('✅ File uploaded to S3:', result.url);
      } catch (uploadError) {
        console.error('❌ S3 upload error:', uploadError);
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
  uploadToS3,
  deleteFromS3,
  uploadProfilePicture,
  // Keep old names for backwards compatibility
  uploadToCloudinary: uploadToS3,
  deleteFromCloudinary: deleteFromS3
};
