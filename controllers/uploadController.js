const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');

// Helper function to upload buffer to cloudinary
const uploadToCloudinary = (buffer, resourceType = 'image') => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'zennara/consultations',
        resource_type: resourceType,
        transformation: resourceType === 'image' ? [
          { width: 1200, height: 800, crop: 'limit', quality: 'auto:good' }
        ] : undefined
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

// @desc    Upload media files to cloudinary
// @route   POST /api/upload/media
// @access  Private/Admin
exports.uploadMedia = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded'
      });
    }

    const uploadPromises = req.files.map(async (file) => {
      const resourceType = file.mimetype.startsWith('video/') ? 'video' : 'image';
      
      const result = await uploadToCloudinary(file.buffer, resourceType);

      return {
        type: resourceType,
        url: result.secure_url,
        thumbnail: resourceType === 'video' ? result.secure_url.replace(/\.[^.]+$/, '.jpg') : result.secure_url,
        publicId: result.public_id
      };
    });

    const uploadedMedia = await Promise.all(uploadPromises);

    res.json({
      success: true,
      message: 'Media uploaded successfully',
      data: uploadedMedia
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload media',
      error: error.message
    });
  }
};

// @desc    Delete media from cloudinary
// @route   DELETE /api/upload/media/:publicId
// @access  Private/Admin
exports.deleteMedia = async (req, res) => {
  try {
    const { publicId } = req.params;
    
    if (!publicId) {
      return res.status(400).json({
        success: false,
        message: 'Public ID is required'
      });
    }

    // Determine resource type from publicId or request
    const resourceType = req.query.resourceType || 'image';
    
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });

    res.json({
      success: true,
      message: 'Media deleted successfully'
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete media',
      error: error.message
    });
  }
};

// @desc    Validate and process media URL
// @route   POST /api/upload/media-url
// @access  Private/Admin
exports.addMediaUrl = async (req, res) => {
  try {
    const { url, type } = req.body;

    if (!url || !type) {
      return res.status(400).json({
        success: false,
        message: 'URL and type are required'
      });
    }

    if (!['image', 'video'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Type must be either "image" or "video"'
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: 'Invalid URL format'
      });
    }

    res.json({
      success: true,
      message: 'Media URL validated successfully',
      data: {
        type,
        url,
        thumbnail: type === 'video' ? url : url,
        publicId: ''
      }
    });
  } catch (error) {
    console.error('URL validation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to validate media URL',
      error: error.message
    });
  }
};
