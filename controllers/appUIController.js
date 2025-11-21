const AppUI = require('../models/AppUI');
const { uploadToS3, deleteFromS3 } = require('../config/s3');

// Get UI settings for a specific page
exports.getPageUI = async (req, res) => {
  try {
    const { page } = req.params;
    
    let appUI = await AppUI.findOne({ page, isActive: true });
    
    // If no settings exist, create default ones
    if (!appUI) {
      appUI = await createDefaultUI(page);
    }
    
    res.status(200).json({
      success: true,
      data: appUI
    });
  } catch (error) {
    console.error('Error fetching page UI:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch page UI settings',
      error: error.message
    });
  }
};

// Get all UI settings
exports.getAllPageUIs = async (req, res) => {
  try {
    const appUIs = await AppUI.find({ isActive: true }).sort({ page: 1 });
    
    res.status(200).json({
      success: true,
      data: appUIs
    });
  } catch (error) {
    console.error('Error fetching all page UIs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch page UI settings',
      error: error.message
    });
  }
};

// Update UI settings for a page
exports.updatePageUI = async (req, res) => {
  try {
    const { page } = req.params;
    const updateData = req.body;
    
    let appUI = await AppUI.findOne({ page });
    
    if (!appUI) {
      // Create new if doesn't exist
      appUI = new AppUI({
        page,
        ...updateData
      });
    } else {
      // Update existing
      Object.assign(appUI, updateData);
    }
    
    await appUI.save();
    
    res.status(200).json({
      success: true,
      message: 'Page UI updated successfully',
      data: appUI
    });
  } catch (error) {
    console.error('Error updating page UI:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update page UI',
      error: error.message
    });
  }
};

// Upload image for UI element
exports.uploadUIImage = async (req, res) => {
  try {
    const { page, type } = req.params; // type: 'hero', 'bottom', 'section'
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }
    
    // Upload to S3
    const imageUrl = await uploadToS3(req.file, 'app-ui');
    
    // Update the UI settings
    const appUI = await AppUI.findOne({ page });
    
    if (appUI) {
      // Delete old image from S3 if exists
      let oldImageUrl;
      
      if (type === 'hero' && appUI.heroBanner?.image) {
        oldImageUrl = appUI.heroBanner.image;
        appUI.heroBanner.image = imageUrl;
      } else if (type === 'bottom' && appUI.bottomBanner?.image) {
        oldImageUrl = appUI.bottomBanner.image;
        appUI.bottomBanner.image = imageUrl;
      }
      
      // Delete old image
      if (oldImageUrl) {
        await deleteFromS3(oldImageUrl);
      }
      
      await appUI.save();
    }
    
    res.status(200).json({
      success: true,
      message: 'Image uploaded successfully',
      imageUrl
    });
  } catch (error) {
    console.error('Error uploading UI image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload image',
      error: error.message
    });
  }
};

// Delete UI image
exports.deleteUIImage = async (req, res) => {
  try {
    const { page, type } = req.params;
    const { imageUrl } = req.body;
    
    // Delete from S3
    await deleteFromS3(imageUrl);
    
    // Update UI settings
    const appUI = await AppUI.findOne({ page });
    
    if (appUI) {
      if (type === 'hero') {
        appUI.heroBanner.image = '';
      } else if (type === 'bottom') {
        appUI.bottomBanner.image = '';
      }
      
      await appUI.save();
    }
    
    res.status(200).json({
      success: true,
      message: 'Image deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting UI image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete image',
      error: error.message
    });
  }
};

// Helper function to create default UI settings
async function createDefaultUI(page) {
  const defaults = {
    home: {
      page: 'home',
      header: {
        title: 'Welcome',
        subtitle: 'Zennara'
      },
      heroBanner: {
        enabled: true,
        title: 'TRANSFORM YOUR WELLNESS',
        subtitle: 'Experience personalized care that transforms lives',
        buttonText: 'Learn More'
      },
      sections: [
        { name: 'consultations', title: 'Consultations', enabled: true, order: 1 },
        { name: 'popularConsultations', title: 'Popular Consultations', enabled: true, order: 2 },
        { name: 'popularProducts', title: 'Popular Products', enabled: true, order: 3 }
      ],
      bottomBanner: {
        enabled: true,
        title: 'JOIN THE ZENNARA FAMILY',
        buttonText: 'Sign Up Today'
      },
      searchBar: {
        enabled: false,
        placeholder: 'Search...'
      }
    },
    consultations: {
      page: 'consultations',
      header: {
        title: 'Consultations',
        subtitle: 'Find your perfect wellness consultation'
      },
      searchBar: {
        enabled: true,
        placeholder: 'Search consultations...'
      },
      sections: []
    },
    appointment: {
      page: 'appointment',
      header: {
        title: 'Appointments',
        subtitle: 'View and manage your appointments'
      },
      searchBar: {
        enabled: false
      },
      sections: []
    },
    products: {
      page: 'products',
      header: {
        title: 'Products',
        subtitle: 'Your health, our priority'
      },
      searchBar: {
        enabled: true,
        placeholder: 'Search products...'
      },
      sections: []
    },
    profile: {
      page: 'profile',
      header: {
        title: 'Profile',
        subtitle: 'Manage your account'
      },
      searchBar: {
        enabled: false
      },
      sections: []
    }
  };
  
  const defaultData = defaults[page] || { page };
  const appUI = new AppUI(defaultData);
  await appUI.save();
  
  return appUI;
}

// Initialize default UI settings for all pages
exports.initializeDefaults = async (req, res) => {
  try {
    const pages = ['home', 'consultations', 'appointment', 'products', 'profile'];
    const results = [];
    
    for (const page of pages) {
      let appUI = await AppUI.findOne({ page });
      if (!appUI) {
        appUI = await createDefaultUI(page);
        results.push(appUI);
      }
    }
    
    res.status(200).json({
      success: true,
      message: 'Default UI settings initialized',
      data: results
    });
  } catch (error) {
    console.error('Error initializing defaults:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initialize defaults',
      error: error.message
    });
  }
};
