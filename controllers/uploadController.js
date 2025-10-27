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
      
      console.log('Uploading to Cloudinary as:', resourceType);
      const result = await uploadToCloudinary(file.buffer, resourceType);
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

// @desc    Delete media from cloudinary
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
    
    console.log('🗑️ Deleting image from Cloudinary');
    console.log('   Public ID:', publicId);

    // Determine resource type from publicId or request
    const resourceType = req.query.resourceType || 'image';
    
    // Delete from Cloudinary
    const result = await cloudinary.uploader.destroy(publicId, { 
      resource_type: resourceType,
      invalidate: true // Invalidate CDN cache
    });

    console.log('   Cloudinary result:', result);

    // Check if deletion was successful
    if (result.result === 'ok') {
      console.log('   ✅ Successfully deleted from Cloudinary');
      return res.json({
        success: true,
        message: 'Media deleted successfully',
        result: result.result
      });
    } else if (result.result === 'not found') {
      console.log('   ⚠️ Image not found in Cloudinary (may already be deleted)');
      return res.json({
        success: true,
        message: 'Media not found (may already be deleted)',
        result: result.result
      });
    } else {
      console.log('   ⚠️ Unexpected result:', result.result);
      return res.json({
        success: false,
        message: 'Unexpected deletion result',
        result: result.result
      });
    }
  } catch (error) {
    console.error('❌ Delete error:', error);
    console.error('   Error message:', error.message);
    console.error('   Error stack:', error.stack);
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

// @desc    Get all uploaded media from Cloudinary
// @route   GET /api/upload/media
// @access  Private/Admin
exports.getAllMedia = async (req, res) => {
  try {
    const { resourceType = 'image', maxResults = 500 } = req.query;
    
    // Get resources from Cloudinary
    const result = await cloudinary.api.resources({
      type: 'upload',
      prefix: 'zennara/',
      resource_type: resourceType,
      max_results: maxResults
    });

    // Transform to match frontend format
    const media = result.resources.map(resource => ({
      publicId: resource.public_id,
      url: resource.secure_url,
      type: resource.resource_type,
      format: resource.format,
      width: resource.width,
      height: resource.height,
      bytes: resource.bytes,
      createdAt: resource.created_at,
      folder: resource.folder
    }));

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

// @desc    Get Cloudinary storage stats
// @route   GET /api/upload/stats
// @access  Private/Admin
exports.getStorageStats = async (req, res) => {
  try {
    // Get fresh usage stats from Cloudinary (no caching)
    const usage = await cloudinary.api.usage({ force: true });
    
    console.log('🔍 Cloudinary Stats Fetched at:', new Date().toISOString());
    console.log('📊 Storage Usage:', usage.storage);
    console.log('📈 Bandwidth Usage:', usage.bandwidth);
    console.log('🔄 Transformations:', usage.transformations);
    console.log('📁 Resources Count:', usage.resources);

    // Parse the actual Cloudinary response structure
    // { plan: "...", last_updated: "...", transformations: {...}, objects: {...}, bandwidth: {...}, storage: {...}, requests: ..., resources: ..., derived_resources: ... }
    
    const plan = usage.plan || 'Free';
    
    // Storage limits by plan (in bytes)
    const PLAN_LIMITS = {
      'Free': 25 * 1024 * 1024 * 1024, // 25GB
      'free': 25 * 1024 * 1024 * 1024,
      'Plus': 100 * 1024 * 1024 * 1024, // 100GB
      'plus': 100 * 1024 * 1024 * 1024,
      'Advanced': 500 * 1024 * 1024 * 1024, // 500GB
      'advanced': 500 * 1024 * 1024 * 1024
    };
    
    const storageUsed = usage.storage?.usage || 0;
    const storageLimit = usage.storage?.limit || PLAN_LIMITS[plan] || PLAN_LIMITS['Free'];
    const storagePercentage = storageLimit > 0 ? ((storageUsed / storageLimit) * 100).toFixed(2) : 0;
    
    const bandwidthUsed = usage.bandwidth?.usage || 0;
    const bandwidthLimit = usage.bandwidth?.limit || (plan.toLowerCase() === 'free' ? 50 * 1024 * 1024 * 1024 : 0); // 50GB for free
    
    const creditsUsed = usage.credits?.usage || 0;
    const creditsLimit = usage.credits?.limit || (plan.toLowerCase() === 'free' ? 25000 : 0);
    
    const transformationsUsed = usage.transformations?.usage || 0;
    const transformationsLimit = usage.transformations?.limit || (plan.toLowerCase() === 'free' ? 25000 : 0);
    
    const resourcesCount = usage.resources || 0;
    const derivedResourcesCount = usage.derived_resources || 0;
    const totalRequests = usage.requests || 0;

    res.json({
      success: true,
      data: {
        // Storage
        used: storageUsed,
        limit: storageLimit,
        percentage: storagePercentage,
        
        // Bandwidth
        bandwidth: bandwidthUsed,
        bandwidthLimit: bandwidthLimit,
        
        // Credits
        credits: creditsUsed,
        creditsLimit: creditsLimit,
        
        // Transformations
        transformations: transformationsUsed,
        transformationsLimit: transformationsLimit,
        
        // Resources
        resourcesCount: resourcesCount,
        derivedResourcesCount: derivedResourcesCount,
        totalRequests: totalRequests,
        
        // Plan info
        plan: usage.plan || 'Free',
        lastUpdated: usage.last_updated
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
