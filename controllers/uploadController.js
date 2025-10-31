const { PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { s3Client, S3_BUCKET } = require('../config/s3');
const sharp = require('sharp');
const crypto = require('crypto');

// Helper function to upload buffer to S3
const uploadToS3 = async (buffer, resourceType = 'image', folder = 'consultations') => {
  try {
    let processedBuffer = buffer;
    let contentType = 'application/octet-stream';
    let fileExtension = '';

    if (resourceType === 'image') {
      // Process image with sharp
      processedBuffer = await sharp(buffer)
        .resize(1200, 800, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();
      
      contentType = 'image/jpeg';
      fileExtension = '.jpg';
    } else if (resourceType === 'video') {
      contentType = 'video/mp4';
      fileExtension = '.mp4';
    }

    // Generate unique filename
    const fileKey = `zennara/${folder}/${crypto.randomBytes(16).toString('hex')}${fileExtension}`;

    // Upload to S3
    const uploadParams = {
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: processedBuffer,
      ContentType: contentType
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
    throw error;
  }
};

// @desc    Upload media files to S3
// @route   POST /api/upload/media
// @access  Private/Admin
exports.uploadMedia = async (req, res) => {
  try {
    console.log('📤 Upload request received');
    console.log('Files:', req.files);
    console.log('File count:', req.files?.length);
    
    if (!req.files || req.files.length === 0) {
      console.log('❌ No files in request');
      return res.status(400).json({
        success: false,
        message: 'No files uploaded'
      });
    }

    console.log('✅ Processing', req.files.length, 'file(s)');
    
    const uploadPromises = req.files.map(async (file) => {
      console.log('Processing file:', file.originalname, 'Type:', file.mimetype);
      const resourceType = file.mimetype.startsWith('video/') ? 'video' : 'image';
      
      console.log('Uploading to S3 as:', resourceType);
      const result = await uploadToS3(file.buffer, resourceType);
      console.log('✅ Uploaded:', result.secure_url);

      return {
        type: resourceType,
        url: result.secure_url,
        thumbnail: resourceType === 'video' ? result.secure_url.replace(/\.[^.]+$/, '.jpg') : result.secure_url,
        publicId: result.public_id
      };
    });

    const uploadedMedia = await Promise.all(uploadPromises);
    console.log('✅ All files uploaded successfully');

    res.json({
      success: true,
      message: 'Media uploaded successfully',
      data: uploadedMedia
    });
  } catch (error) {
    console.error('❌ Upload error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again.',
      error: error.message
    });
  }
};

// @desc    Delete media from S3
// @route   DELETE /api/upload/media/:publicId
// @access  Private/Admin
exports.deleteMedia = async (req, res) => {
  try {
    let { publicId } = req.params;
    
    if (!publicId) {
      return res.status(400).json({
        success: false,
        message: 'Public ID is required'
      });
    }

    // Decode the publicId (handles URL-encoded slashes %2F -> /)
    publicId = decodeURIComponent(publicId);
    
    console.log('🗑️ Deleting image from S3');
    console.log('   File Key:', publicId);

    // Delete from S3
    const deleteParams = {
      Bucket: S3_BUCKET,
      Key: publicId
    };

    await s3Client.send(new DeleteObjectCommand(deleteParams));

    console.log('   ✅ Successfully deleted from S3');
    return res.json({
      success: true,
      message: 'Media deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete error:', error);
    console.error('   Error message:', error.message);
    console.error('   Error stack:', error.stack);
    
    // If file not found in S3, still return success
    if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
      console.log('   ⚠️ File not found in S3 (may already be deleted)');
      return res.json({
        success: true,
        message: 'Media not found (may already be deleted)'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to delete media',
      error: error.message,
      details: error.toString()
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

// @desc    Get all uploaded media from S3
// @route   GET /api/upload/media
// @access  Private/Admin
exports.getAllMedia = async (req, res) => {
  try {
    const { maxResults = 500 } = req.query;
    
    // List objects from S3
    const listParams = {
      Bucket: S3_BUCKET,
      Prefix: 'zennara/',
      MaxKeys: parseInt(maxResults)
    };

    const result = await s3Client.send(new ListObjectsV2Command(listParams));

    if (!result.Contents) {
      return res.json({
        success: true,
        count: 0,
        data: []
      });
    }

    // Transform to match frontend format
    const media = result.Contents.map(object => {
      const url = `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${object.Key}`;
      const extension = object.Key.split('.').pop().toLowerCase();
      const isVideo = ['mp4', 'mov', 'avi', 'webm'].includes(extension);
      
      return {
        publicId: object.Key,
        url: url,
        type: isVideo ? 'video' : 'image',
        format: extension,
        bytes: object.Size,
        createdAt: object.LastModified,
        key: object.Key
      };
    });

    res.json({
      success: true,
      count: media.length,
      data: media
    });
  } catch (error) {
    console.error('Get media error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch media',
      error: error.message
    });
  }
};

// @desc    Get S3 storage stats
// @route   GET /api/upload/stats
// @access  Private/Admin
exports.getStorageStats = async (req, res) => {
  try {
    console.log('🔍 S3 Stats Fetched at:', new Date().toISOString());
    
    // List all objects in the bucket to calculate storage
    const listParams = {
      Bucket: S3_BUCKET,
      Prefix: 'zennara/'
    };

    let totalSize = 0;
    let objectCount = 0;
    let continuationToken = null;
    
    // Paginate through all objects
    do {
      if (continuationToken) {
        listParams.ContinuationToken = continuationToken;
      }
      
      const result = await s3Client.send(new ListObjectsV2Command(listParams));
      
      if (result.Contents) {
        result.Contents.forEach(object => {
          totalSize += object.Size || 0;
          objectCount++;
        });
      }
      
      continuationToken = result.IsTruncated ? result.NextContinuationToken : null;
    } while (continuationToken);

    console.log('📊 Storage Usage:', totalSize, 'bytes');
    console.log('📁 Object Count:', objectCount);

    // AWS Free Tier: 5GB storage
    // Assume standard usage limits
    const storageLimit = 5 * 1024 * 1024 * 1024; // 5GB in bytes
    const storagePercentage = storageLimit > 0 ? ((totalSize / storageLimit) * 100).toFixed(2) : 0;

    res.json({
      success: true,
      data: {
        // Storage
        used: totalSize,
        limit: storageLimit,
        percentage: storagePercentage,
        
        // Resources
        resourcesCount: objectCount,
        
        // Plan info
        plan: 'AWS S3',
        provider: 'Amazon S3',
        lastUpdated: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch storage stats',
      error: error.message
    });
  }
};
