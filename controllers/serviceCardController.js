const ServiceCard = require('../models/ServiceCard');
const User = require('../models/User');

// @desc    Create service card for user
// @route   POST /api/service-cards
// @access  Private/Admin
exports.createServiceCard = async (req, res) => {
  try {
    const { userId, clientName, clientId, primaryDoctor, manager } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const existingCard = await ServiceCard.findOne({ userId, isActive: true });
    if (existingCard) {
      return res.status(400).json({ success: false, message: 'Active service card already exists' });
    }

    const serviceCard = new ServiceCard({
      userId,
      clientName: clientName || user.fullName,
      clientId: clientId || user.patientId,
      primaryDoctor,
      manager,
      services: []
    });

    await serviceCard.save();
    res.status(201).json({ success: true, message: 'Service card created successfully', data: serviceCard });
  } catch (error) {
    console.error('Error creating service card:', error);
    res.status(500).json({ success: false, message: 'Failed to create service card', error: error.message });
  }
};

// @desc    Get user's service card
// @route   GET /api/service-cards/my-card
// @access  Private
exports.getMyServiceCard = async (req, res) => {
  try {
    const serviceCard = await ServiceCard.findOne({ userId: req.user._id, isActive: true });
    if (!serviceCard) {
      return res.status(404).json({ success: false, message: 'No active service card found' });
    }
    res.status(200).json({ success: true, data: serviceCard });
  } catch (error) {
    console.error('Error fetching service card:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch service card', error: error.message });
  }
};

// @desc    Get service card by ID
// @route   GET /api/service-cards/:id
// @access  Private
exports.getServiceCardById = async (req, res) => {
  try {
    const serviceCard = await ServiceCard.findOne({ _id: req.params.id, userId: req.user._id });
    if (!serviceCard) {
      return res.status(404).json({ success: false, message: 'Service card not found' });
    }
    res.status(200).json({ success: true, data: serviceCard });
  } catch (error) {
    console.error('Error fetching service card:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch service card', error: error.message });
  }
};

// @desc    Add service to card
// @route   POST /api/service-cards/:id/services
// @access  Private/Admin
exports.addServiceToCard = async (req, res) => {
  try {
    const serviceCard = await ServiceCard.findById(req.params.id);
    if (!serviceCard) {
      return res.status(404).json({ success: false, message: 'Service card not found' });
    }

    const newService = serviceCard.addService(req.body);
    await serviceCard.save();
    res.status(201).json({ success: true, message: 'Service added successfully', data: { serviceCard, addedService: newService } });
  } catch (error) {
    console.error('Error adding service:', error);
    res.status(500).json({ success: false, message: 'Failed to add service', error: error.message });
  }
};

// @desc    Update service in card
// @route   PUT /api/service-cards/:cardId/services/:serviceId
// @access  Private/Admin
exports.updateService = async (req, res) => {
  try {
    const serviceCard = await ServiceCard.findById(req.params.cardId);
    if (!serviceCard) {
      return res.status(404).json({ success: false, message: 'Service card not found' });
    }

    const updatedService = serviceCard.updateService(req.params.serviceId, req.body);
    await serviceCard.save();
    res.status(200).json({ success: true, message: 'Service updated successfully', data: { serviceCard, updatedService } });
  } catch (error) {
    console.error('Error updating service:', error);
    res.status(500).json({ success: false, message: error.message, error: error.message });
  }
};

// @desc    Delete service from card
// @route   DELETE /api/service-cards/:cardId/services/:serviceId
// @access  Private/Admin
exports.deleteService = async (req, res) => {
  try {
    const serviceCard = await ServiceCard.findById(req.params.cardId);
    if (!serviceCard) {
      return res.status(404).json({ success: false, message: 'Service card not found' });
    }

    const service = serviceCard.services.id(req.params.serviceId);
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    service.deleteOne();
    serviceCard.completedSessions = serviceCard.services.length;
    
    if (serviceCard.services.length > 0) {
      const sortedServices = serviceCard.services.sort((a, b) => b.date - a.date);
      serviceCard.lastServiceDate = sortedServices[0].date;
    } else {
      serviceCard.lastServiceDate = null;
    }

    await serviceCard.save();
    res.status(200).json({ success: true, message: 'Service deleted successfully', data: serviceCard });
  } catch (error) {
    console.error('Error deleting service:', error);
    res.status(500).json({ success: false, message: 'Failed to delete service', error: error.message });
  }
};

// @desc    Get service history for card
// @route   GET /api/service-cards/:id/history
// @access  Private
exports.getServiceHistory = async (req, res) => {
  try {
    const serviceCard = await ServiceCard.findOne({ _id: req.params.id, userId: req.user._id });
    if (!serviceCard) {
      return res.status(404).json({ success: false, message: 'Service card not found' });
    }
    const history = serviceCard.getServiceHistory();
    res.status(200).json({ success: true, count: history.length, data: history });
  } catch (error) {
    console.error('Error fetching service history:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch service history', error: error.message });
  }
};

// ADMIN ENDPOINTS
exports.getAllServiceCards = async (req, res) => {
  try {
    const { isActive, clientId, page = 1, limit = 20 } = req.query;
    const query = {};
    if (isActive !== undefined) query.isActive = isActive === 'true';
    if (clientId) query.clientId = clientId;

    const cards = await ServiceCard.find(query)
      .populate('userId', 'fullName email phone patientId')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const count = await ServiceCard.countDocuments(query);
    res.status(200).json({ success: true, count: cards.length, totalPages: Math.ceil(count / limit), currentPage: page, data: cards });
  } catch (error) {
    console.error('Error fetching all service cards:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch service cards', error: error.message });
  }
};

exports.updateServiceCard = async (req, res) => {
  try {
    const updateData = { ...req.body };
    delete updateData.services;

    const serviceCard = await ServiceCard.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    if (!serviceCard) {
      return res.status(404).json({ success: false, message: 'Service card not found' });
    }
    res.status(200).json({ success: true, message: 'Service card updated successfully', data: serviceCard });
  } catch (error) {
    console.error('Error updating service card:', error);
    res.status(500).json({ success: false, message: 'Failed to update service card', error: error.message });
  }
};

exports.deactivateServiceCard = async (req, res) => {
  try {
    const serviceCard = await ServiceCard.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!serviceCard) {
      return res.status(404).json({ success: false, message: 'Service card not found' });
    }
    res.status(200).json({ success: true, message: 'Service card deactivated successfully', data: serviceCard });
  } catch (error) {
    console.error('Error deactivating service card:', error);
    res.status(500).json({ success: false, message: 'Failed to deactivate service card', error: error.message });
  }
};
