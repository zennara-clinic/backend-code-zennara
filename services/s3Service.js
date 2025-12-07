const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, S3_BUCKET } = require('../config/s3');
const sharp = require('sharp');
const crypto = require('crypto');

/**
 * Upload a file to S3
 * @param {Object} file - Multer file object with buffer
 * @param {String} folder - Folder name in S3 bucket (e.g., 'app-customization', 'products')
 * @returns {Promise<String>} - URL of uploaded file
 */
exports.uploadToS3 = async (file, folder = 'uploads') => {
  try {
    // Get image metadata to detect format and transparency
    const metadata = await sharp(file.buffer).metadata();
    const isPng = metadata.format === 'png';
    const hasAlpha = metadata.hasAlpha;

    let optimizedBuffer;
    let fileExtension;
    let contentType;

    // If PNG with transparency, preserve it as PNG
    if (isPng && hasAlpha) {
      optimizedBuffer = await sharp(file.buffer)
        .resize(2000, 2000, { 
          fit: 'inside',
          withoutEnlargement: true 
        })
        .png({ 
          quality: 85,
          compressionLevel: 9
        })
        .toBuffer();
      fileExtension = 'png';
      contentType = 'image/png';
    } else {
      // Convert to JPEG for other formats or PNG without transparency
      optimizedBuffer = await sharp(file.buffer)
        .resize(2000, 2000, { 
          fit: 'inside',
          withoutEnlargement: true 
        })
        .jpeg({ 
          quality: 85,
          progressive: true 
        })
        .toBuffer();
      fileExtension = 'jpg';
      contentType = 'image/jpeg';
    }

    // Generate unique filename with correct extension
    const fileKey = `${folder}/${crypto.randomBytes(16).toString('hex')}-${Date.now()}.${fileExtension}`;

    // Upload parameters
    const uploadParams = {
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: optimizedBuffer,
      ContentType: contentType,
      CacheControl: 'max-age=31536000' // Cache for 1 year
    };

    // Upload to S3
    await s3Client.send(new PutObjectCommand(uploadParams));

    // Return S3 URL
    const url = `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileKey}`;
    console.log(`✅ File uploaded to S3 as ${fileExtension.toUpperCase()}:`, url);
    
    return url;
  } catch (error) {
    console.error('❌ S3 upload error:', error);
    throw new Error('Failed to upload file to S3');
  }
};

/**
 * Delete a file from S3 using its URL
 * @param {String} fileUrl - Full S3 URL of the file
 * @returns {Promise<void>}
 */
exports.deleteFromS3 = async (fileUrl) => {
  try {
    if (!fileUrl || !fileUrl.includes(S3_BUCKET)) {
      console.log('⚠️ Invalid S3 URL or not from our bucket, skipping delete');
      return;
    }

    // Extract the file key from URL
    const urlParts = fileUrl.split(`${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/`);
    if (urlParts.length < 2) {
      console.log('⚠️ Could not extract file key from URL');
      return;
    }
    
    const fileKey = urlParts[1];

    // Delete parameters
    const deleteParams = {
      Bucket: S3_BUCKET,
      Key: fileKey
    };

    // Delete from S3
    await s3Client.send(new DeleteObjectCommand(deleteParams));
    console.log('✅ File deleted from S3:', fileKey);
  } catch (error) {
    console.error('❌ S3 delete error:', error);
    // Don't throw error - just log it, as delete failures shouldn't break the flow
  }
};

/**
 * Upload raw buffer to S3 (without image optimization)
 * @param {Buffer} buffer - File buffer
 * @param {String} folder - Folder name in S3 bucket
 * @param {String} contentType - MIME type of the file
 * @param {String} filename - Optional custom filename
 * @returns {Promise<String>} - URL of uploaded file
 */
exports.uploadBufferToS3 = async (buffer, folder = 'uploads', contentType = 'application/octet-stream', filename = null) => {
  try {
    // Generate unique filename if not provided
    const fileKey = filename || `${folder}/${crypto.randomBytes(16).toString('hex')}-${Date.now()}`;

    // Upload parameters
    const uploadParams = {
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: buffer,
      ContentType: contentType
    };

    // Upload to S3
    await s3Client.send(new PutObjectCommand(uploadParams));

    // Return S3 URL
    const url = `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileKey}`;
    console.log('✅ Buffer uploaded to S3:', url);
    
    return url;
  } catch (error) {
    console.error('❌ S3 buffer upload error:', error);
    throw new Error('Failed to upload buffer to S3');
  }
};

module.exports = exports;
