const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const {
  ALLOWED_CHAT_MIME_TYPES,
  MAX_CHAT_FILE_SIZE,
} = require('../middleware/chatAttachmentUpload');

const base = () => ({
  chatId: new mongoose.Types.ObjectId(),
  senderId: new mongoose.Types.ObjectId(),
  senderModel: 'User',
  senderName: 'Guest',
});

test('text messages still require actual content', async () => {
  await assert.rejects(
    new Message({ ...base(), messageType: 'text', content: '   ' }).validate(),
    /text or an attachment/
  );
});

test('image and document messages preserve safe attachment metadata', async () => {
  const image = new Message({
    ...base(),
    messageType: 'image',
    attachment: {
      url: 'https://bucket.example/zennara/chat/photo.jpg',
      key: 'zennara/chat/photo.jpg',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      kind: 'image',
    },
  });
  await image.validate();
  assert.equal(image.attachment.kind, 'image');

  const document = new Message({
    ...base(),
    messageType: 'file',
    content: 'Your invoice',
    attachment: {
      url: 'https://bucket.example/zennara/chat/invoice.pdf',
      key: 'zennara/chat/invoice.pdf',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      size: 4096,
      kind: 'file',
    },
  });
  await document.validate();
  assert.equal(document.content, 'Your invoice');
});

test('file messages cannot be saved without an uploaded attachment', async () => {
  await assert.rejects(
    new Message({ ...base(), messageType: 'file', content: 'pretend file' }).validate(),
    /Attachment metadata is required/
  );
});

test('chat upload policy accepts common care documents but blocks active web content', () => {
  assert.equal(MAX_CHAT_FILE_SIZE, 15 * 1024 * 1024);
  assert(ALLOWED_CHAT_MIME_TYPES.has('image/jpeg'));
  assert(ALLOWED_CHAT_MIME_TYPES.has('application/pdf'));
  assert(ALLOWED_CHAT_MIME_TYPES.has('application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  assert.equal(ALLOWED_CHAT_MIME_TYPES.has('image/svg+xml'), false);
  assert.equal(ALLOWED_CHAT_MIME_TYPES.has('text/html'), false);
  assert.equal(ALLOWED_CHAT_MIME_TYPES.has('application/x-msdownload'), false);
});
