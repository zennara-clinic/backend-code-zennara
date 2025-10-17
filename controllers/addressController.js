const Address = require('../models/Address');

// @desc    Get all addresses for current user
// @route   GET /api/addresses
// @access  Private
exports.getAddresses = async (req, res) => {
  try {
    const addresses = await Address.find({ userId: req.user._id })
      .sort({ isDefault: -1, createdAt: -1 });

    res.status(200).json({
      success: true,
      data: addresses
    });
  } catch (error) {
    console.error('❌ Get addresses failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch addresses. Please try again.'
    });
  }
};

// @desc    Get single address by ID
// @route   GET /api/addresses/:id
// @access  Private
exports.getAddressById = async (req, res) => {
  try {
    const address = await Address.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found'
      });
    }

    res.status(200).json({
      success: true,
      data: address
    });
  } catch (error) {
    console.error('❌ Get address failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch address. Please try again.'
    });
  }
};

// @desc    Create new address
// @route   POST /api/addresses
// @access  Private
exports.createAddress = async (req, res) => {
  try {
    const {
      label,
      fullName,
      phone,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      latitude,
      longitude,
      isDefault
    } = req.body;

    // Validate required fields
    if (!label || !fullName || !phone || !addressLine1 || !city || !state || !postalCode) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Create address object
    const addressData = {
      userId: req.user._id,
      label,
      fullName,
      phone,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country: country || 'India',
      isDefault: isDefault || false
    };

    // Add location if BOTH coordinates are valid numbers
    if (latitude != null && longitude != null && 
        !isNaN(latitude) && !isNaN(longitude) &&
        typeof latitude === 'number' && typeof longitude === 'number') {
      addressData.location = {
        type: 'Point',
        coordinates: [longitude, latitude]
      };
    }

    const address = await Address.create(addressData);

    res.status(201).json({
      success: true,
      message: 'Address added successfully',
      data: address
    });
  } catch (error) {
    console.error('❌ Create address error:', error.message);
    
    // Check for validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error: ' + errors.join(', ')
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create address. Please try again.',
      error: error.message
    });
  }
};

// @desc    Update address
// @route   PUT /api/addresses/:id
// @access  Private
exports.updateAddress = async (req, res) => {
  try {
    const {
      label,
      fullName,
      phone,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      latitude,
      longitude,
      isDefault
    } = req.body;

    // Find address and verify ownership
    const address = await Address.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found'
      });
    }

    // Update fields
    if (label !== undefined) address.label = label;
    if (fullName !== undefined) address.fullName = fullName;
    if (phone !== undefined) address.phone = phone;
    if (addressLine1 !== undefined) address.addressLine1 = addressLine1;
    if (addressLine2 !== undefined) address.addressLine2 = addressLine2;
    if (city !== undefined) address.city = city;
    if (state !== undefined) address.state = state;
    if (postalCode !== undefined) address.postalCode = postalCode;
    if (country !== undefined) address.country = country;
    if (isDefault !== undefined) address.isDefault = isDefault;

    // Update location if BOTH coordinates are valid numbers
    if (latitude != null && longitude != null && 
        !isNaN(latitude) && !isNaN(longitude) &&
        typeof latitude === 'number' && typeof longitude === 'number') {
      address.location = {
        type: 'Point',
        coordinates: [longitude, latitude]
      };
    }

    await address.save();

    console.log('✅ Address updated successfully');

    res.status(200).json({
      success: true,
      message: 'Address updated successfully',
      data: address
    });
  } catch (error) {
    console.error('❌ Update address failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update address. Please try again.'
    });
  }
};

// @desc    Delete address
// @route   DELETE /api/addresses/:id
// @access  Private
exports.deleteAddress = async (req, res) => {
  try {
    const address = await Address.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found'
      });
    }

    await address.deleteOne();

    console.log('✅ Address deleted successfully');

    res.status(200).json({
      success: true,
      message: 'Address deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete address failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete address. Please try again.'
    });
  }
};

// @desc    Set default address
// @route   PUT /api/addresses/:id/default
// @access  Private
exports.setDefaultAddress = async (req, res) => {
  try {
    const address = await Address.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found'
      });
    }

    // Remove default from all other addresses
    await Address.updateMany(
      { userId: req.user._id, _id: { $ne: req.params.id } },
      { isDefault: false }
    );

    // Set this address as default
    address.isDefault = true;
    await address.save();

    console.log('✅ Default address updated');

    res.status(200).json({
      success: true,
      message: 'Default address updated successfully',
      data: address
    });
  } catch (error) {
    console.error('❌ Set default address failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update default address. Please try again.'
    });
  }
};
