const mongoose = require('mongoose');

const serviceRecordSchema = new mongoose.Schema({
  serialNumber: {
    type: Number,
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  service: {
    type: String,
    required: true,
    trim: true
  },
  grading: {
    type: String,
    default: null,
    trim: true
  },
  doctorSign: {
    type: String, // base64 or URL
    default: null
  },
  doctorName: {
    type: String,
    default: null,
    trim: true
  },
  therapist: {
    type: String,
    default: null,
    trim: true
  },
  notes: {
    type: String,
    default: null
  }
}, { _id: true });

const serviceCardSchema = new mongoose.Schema({
  // User Reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Client Information
  clientName: {
    type: String,
    required: true,
    trim: true
  },
  clientId: {
    type: String,
    required: true,
    index: true
  },

  // Primary Doctor and Manager
  primaryDoctor: {
    type: String,
    required: true,
    trim: true
  },
  manager: {
    type: String,
    default: null,
    trim: true
  },

  // Service Records
  services: [serviceRecordSchema],

  // Treatment Summary
  totalSessions: {
    type: Number,
    default: 0
  },
  completedSessions: {
    type: Number,
    default: 0
  },

  // Status
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  // Card Creation Date
  cardCreatedAt: {
    type: Date,
    default: Date.now
  },

  // Last Service Date
  lastServiceDate: {
    type: Date,
    default: null
  }

}, {
  timestamps: true
});

// Indexes for efficient queries
serviceCardSchema.index({ userId: 1, isActive: 1 });
serviceCardSchema.index({ clientId: 1 });
serviceCardSchema.index({ 'services.date': -1 });

// Virtual for next serial number
serviceCardSchema.virtual('nextSerialNumber').get(function() {
  return this.services.length + 1;
});

// Method to add a service record
serviceCardSchema.methods.addService = function(serviceData) {
  const newService = {
    serialNumber: this.services.length + 1,
    date: serviceData.date || new Date(),
    service: serviceData.service,
    grading: serviceData.grading || null,
    doctorSign: serviceData.doctorSign || null,
    doctorName: serviceData.doctorName || null,
    therapist: serviceData.therapist || null,
    notes: serviceData.notes || null
  };
  
  this.services.push(newService);
  this.lastServiceDate = newService.date;
  this.completedSessions = this.services.length;
  
  return newService;
};

// Method to update service record
serviceCardSchema.methods.updateService = function(serviceId, updateData) {
  const service = this.services.id(serviceId);
  if (!service) {
    throw new Error('Service record not found');
  }
  
  Object.keys(updateData).forEach(key => {
    if (key !== 'serialNumber') { // Don't allow changing serial number
      service[key] = updateData[key];
    }
  });
  
  return service;
};

// Method to get service history sorted by date
serviceCardSchema.methods.getServiceHistory = function() {
  return this.services.sort((a, b) => b.date - a.date);
};

module.exports = mongoose.model('ServiceCard', serviceCardSchema);
