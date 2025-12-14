const Banner = require('../models/Banner');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, S3_BUCKET } = require('../config/s3');
const sharp = require('sharp');
const crypto = require('crypto');

exports.createBanner = async (req, res) => {
  try {
    const { title, mediaType, videoUrl, linkType, internalScreen, externalUrl, order } = req.body;

    if (mediaType === 'video') {
      if (!videoUrl && !req.file) {
        return res.status(400).json({
          success: false,
          message: 'Video URL or video file is required for video banners'
        });
      }

      let videoFileUrl = '';
      if (req.file) {
        const fileKey = `banners/videos/${crypto.randomBytes(16).toString('hex')}-${Date.now()}.${req.file.mimetype.split('/')[1]}`;
        
        const uploadParams = {
          Bucket: S3_BUCKET,
          Key: fileKey,
          Body: req.file.buffer,
          ContentType: req.file.mimetype
        };
        
        await s3Client.send(new PutObjectCommand(uploadParams));
        videoFileUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileKey}`;
      }

      const banner = await Banner.create({
        title,
        mediaType: 'video',
        videoFile: videoFileUrl,
        videoUrl: videoUrl || '',
        linkType: linkType || 'none',
        internalScreen: linkType === 'internal' ? internalScreen : '',
        externalUrl: linkType === 'external' ? externalUrl : '',
        order: order || 0,
        isActive: true
      });

      return res.status(201).json({
        success: true,
        message: 'Video banner created successfully',
        data: banner
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Banner image is required'
      });
    }

    const fileKey = `banners/images/${crypto.randomBytes(16).toString('hex')}-${Date.now()}.${req.file.mimetype.split('/')[1]}`;
    
    const uploadParams = {
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    };
    
    await s3Client.send(new PutObjectCommand(uploadParams));
    const imageUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileKey}`;

    const banner = await Banner.create({
      title,
      mediaType: 'image',
      image: imageUrl,
      linkType: linkType || 'none',
      internalScreen: linkType === 'internal' ? internalScreen : '',
      externalUrl: linkType === 'external' ? externalUrl : '',
      order: order || 0,
      isActive: true
    });

    res.status(201).json({
      success: true,
      message: 'Banner created successfully',
      data: banner
    });
  } catch (error) {
    console.error('Create banner error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create banner',
      error: error.message
    });
  }
};

exports.getAllBanners = async (req, res) => {
  try {
    const banners = await Banner.find().sort({ order: 1, createdAt: -1 });

    res.status(200).json({
      success: true,
      data: banners
    });
  } catch (error) {
    console.error('Get all banners error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch banners',
      error: error.message
    });
  }
};

exports.getActiveBanners = async (req, res) => {
  try {
    const banners = await Banner.find({ isActive: true })
      .sort({ order: 1, createdAt: -1 })
      .limit(5);

    res.status(200).json({
      success: true,
      data: banners
    });
  } catch (error) {
    console.error('Get active banners error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch active banners',
      error: error.message
    });
  }
};

exports.getBanner = async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    res.status(200).json({
      success: true,
      data: banner
    });
  } catch (error) {
    console.error('Get banner error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch banner',
      error: error.message
    });
  }
};

exports.updateBanner = async (req, res) => {
  try {
    const { title, mediaType, videoUrl, linkType, internalScreen, externalUrl, order, isActive } = req.body;

    const banner = await Banner.findById(req.params.id);

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    if (mediaType && mediaType !== banner.mediaType) {
      if (banner.mediaType === 'image' && banner.image) {
        const oldKey = banner.image.split('.amazonaws.com/')[1];
        await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: oldKey }));
        banner.image = '';
      } else if (banner.mediaType === 'video' && banner.videoFile) {
        const oldKey = banner.videoFile.split('.amazonaws.com/')[1];
        await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: oldKey }));
        banner.videoFile = '';
      }
      banner.mediaType = mediaType;
    }

    if (req.file) {
      if (banner.mediaType === 'image') {
        if (banner.image) {
          const oldKey = banner.image.split('.amazonaws.com/')[1];
          await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: oldKey }));
        }
        const fileKey = `banners/images/${crypto.randomBytes(16).toString('hex')}-${Date.now()}.${req.file.mimetype.split('/')[1]}`;
        const uploadParams = {
          Bucket: S3_BUCKET,
          Key: fileKey,
          Body: req.file.buffer,
          ContentType: req.file.mimetype
        };
        await s3Client.send(new PutObjectCommand(uploadParams));
        banner.image = `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileKey}`;
      } else if (banner.mediaType === 'video') {
        if (banner.videoFile) {
          const oldKey = banner.videoFile.split('.amazonaws.com/')[1];
          await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: oldKey }));
        }
        const fileKey = `banners/videos/${crypto.randomBytes(16).toString('hex')}-${Date.now()}.${req.file.mimetype.split('/')[1]}`;
        const uploadParams = {
          Bucket: S3_BUCKET,
          Key: fileKey,
          Body: req.file.buffer,
          ContentType: req.file.mimetype
        };
        await s3Client.send(new PutObjectCommand(uploadParams));
        banner.videoFile = `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileKey}`;
      }
    }

    if (banner.mediaType === 'video' && videoUrl !== undefined) {
      banner.videoUrl = videoUrl;
    }

    banner.title = title || banner.title;
    banner.linkType = linkType || banner.linkType;
    banner.internalScreen = linkType === 'internal' ? internalScreen : '';
    banner.externalUrl = linkType === 'external' ? externalUrl : '';
    banner.order = order !== undefined ? order : banner.order;
    banner.isActive = isActive !== undefined ? isActive : banner.isActive;

    await banner.save();

    res.status(200).json({
      success: true,
      message: 'Banner updated successfully',
      data: banner
    });
  } catch (error) {
    console.error('Update banner error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update banner',
      error: error.message
    });
  }
};

exports.deleteBanner = async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    if (banner.image) {
      try {
        const imageKey = banner.image.split('.amazonaws.com/')[1];
        await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: imageKey }));
      } catch (error) {
        console.error('Error deleting image from S3:', error);
      }
    }

    if (banner.videoFile) {
      try {
        const videoKey = banner.videoFile.split('.amazonaws.com/')[1];
        await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: videoKey }));
      } catch (error) {
        console.error('Error deleting video from S3:', error);
      }
    }

    await Banner.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Banner deleted successfully'
    });
  } catch (error) {
    console.error('Delete banner error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete banner',
      error: error.message
    });
  }
};

exports.toggleBannerStatus = async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    banner.isActive = !banner.isActive;
    await banner.save();

    res.status(200).json({
      success: true,
      message: `Banner ${banner.isActive ? 'activated' : 'deactivated'} successfully`,
      data: banner
    });
  } catch (error) {
    console.error('Toggle banner status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle banner status',
      error: error.message
    });
  }
};

exports.reorderBanners = async (req, res) => {
  try {
    const { banners } = req.body;

    if (!Array.isArray(banners)) {
      return res.status(400).json({
        success: false,
        message: 'Banners array is required'
      });
    }

    const updatePromises = banners.map(({ id, order }) =>
      Banner.findByIdAndUpdate(id, { order }, { new: true })
    );

    await Promise.all(updatePromises);

    res.status(200).json({
      success: true,
      message: 'Banners reordered successfully'
    });
  } catch (error) {
    console.error('Reorder banners error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reorder banners',
      error: error.message
    });
  }
};
