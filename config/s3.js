const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

// Configure AWS S3
const s3Client = new S3Client({
  region: process.env.AWS_S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY
  }
});

const S3_BUCKET = process.env.AWS_S3_BUCKET_NAME;

/**
 * Upload file to S3
 * @param {Object} file - Multer file object
 * @param {String} folder - Folder name in S3 bucket
 * @returns {String} - S3 file URL
 */
const uploadToS3 = async (file, folder = 'uploads') => {
  try {
    const fileExtension = file.originalname.split('.').pop();
    const fileName = `${folder}/${uuidv4()}.${fileExtension}`;
    
    const uploadParams = {
      Bucket: S3_BUCKET,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
      ACL: 'public-read'
    };

    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);

    // Return the public URL
    const fileUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileName}`;
    console.log('✅ File uploaded to S3:', fileUrl);
    return fileUrl;
  } catch (error) {
    console.error('❌ S3 upload error:', error);
    throw new Error(`Failed to upload file to S3: ${error.message}`);
  }
};

/**
 * Delete file from S3
 * @param {String} fileUrl - Full S3 file URL
 */
const deleteFromS3 = async (fileUrl) => {
  try {
    if (!fileUrl) return;

    // Extract key from URL
    // URL format: https://bucket-name.s3.region.amazonaws.com/folder/filename.ext
    const urlParts = fileUrl.split('.amazonaws.com/');
    if (urlParts.length < 2) {
      console.log('⚠️ Invalid S3 URL format:', fileUrl);
      return;
    }

    const key = urlParts[1];
    
    const deleteParams = {
      Bucket: S3_BUCKET,
      Key: key
    };

    const command = new DeleteObjectCommand(deleteParams);
    await s3Client.send(command);
    
    console.log('✅ File deleted from S3:', key);
  } catch (error) {
    console.error('❌ S3 delete error:', error);
    // Don't throw error, just log it (deletion failures shouldn't break the flow)
  }
};

module.exports = { s3Client, S3_BUCKET, uploadToS3, deleteFromS3 };
