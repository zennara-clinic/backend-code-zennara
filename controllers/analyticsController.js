const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const PackageAssignment = require('../models/PackageAssignment');
const Consultation = require('../models/Consultation');
const Branch = require('../models/Branch');
const User = require('../models/User');
const Inventory = require('../models/Inventory');

// Get Financial Dashboard Analytics
exports.getFinancialAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, branchId } = req.query;
    
    // Default to last 30 days if no dates provided
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    // Build query filters
    const bookingFilter = {
      createdAt: { $gte: start, $lte: end },
      status: { $in: ['Confirmed', 'Completed', 'In Progress'] }
    };
    
    const orderFilter = {
      createdAt: { $gte: start, $lte: end },
      orderStatus: { $nin: ['Cancelled', 'Returned'] }
    };
    
    const packageFilter = {
      createdAt: { $gte: start, $lte: end },
      status: { $in: ['Active', 'Completed'] }
    };
    
    if (branchId) {
      bookingFilter.branchId = branchId;
    }
    
    // Fetch all bookings with consultation details
    const bookings = await Booking.find(bookingFilter)
      .populate('consultationId', 'name price category')
      .populate('branchId', 'name location');
    
    // Fetch all product orders
    const productOrders = await ProductOrder.find(orderFilter);
    
    // Fetch all package assignments
    const packageAssignments = await PackageAssignment.find(packageFilter)
      .populate('packageId', 'name price');
    
    // Calculate consultation revenue
    const consultationRevenue = bookings.reduce((total, booking) => {
      return total + (booking.consultationId?.price || 0);
    }, 0);
    
    // Calculate product revenue
    const productRevenue = productOrders.reduce((total, order) => {
      return total + (order.pricing?.total || 0);
    }, 0);
    
    // Calculate package revenue
    const packageRevenue = packageAssignments.reduce((total, assignment) => {
      return total + (assignment.pricing?.finalAmount || 0);
    }, 0);
    
    // Total revenue
    const totalRevenue = consultationRevenue + productRevenue + packageRevenue;
    
    // Calculate outstanding payments (pending orders and unpaid packages)
    const pendingOrders = await ProductOrder.find({
      createdAt: { $gte: start, $lte: end },
      paymentStatus: 'Pending',
      orderStatus: { $nin: ['Cancelled'] }
    });
    
    const unpaidPackages = await PackageAssignment.find({
      createdAt: { $gte: start, $lte: end },
      'payment.isReceived': false,
      status: { $ne: 'Cancelled' }
    });
    
    const outstandingPayments = 
      pendingOrders.reduce((sum, order) => sum + order.pricing.total, 0) +
      unpaidPackages.reduce((sum, pkg) => sum + pkg.pricing.finalAmount, 0);
    
    // Calculate refunds and cancellations
    const cancelledOrders = await ProductOrder.find({
      createdAt: { $gte: start, $lte: end },
      orderStatus: { $in: ['Cancelled', 'Returned'] }
    });
    
    const cancelledBookings = await Booking.find({
      createdAt: { $gte: start, $lte: end },
      status: 'Cancelled'
    }).populate('consultationId', 'price');
    
    const refundsLost = 
      cancelledOrders.reduce((sum, order) => sum + order.pricing.total, 0) +
      cancelledBookings.reduce((sum, booking) => sum + (booking.consultationId?.price || 0), 0);
    
    // Payment method distribution
    const paymentMethodDistribution = {
      Cash: 0,
      Card: 0,
      UPI: 0,
      'Bank Transfer': 0,
      COD: 0,
      Other: 0
    };
    
    productOrders.forEach(order => {
      if (paymentMethodDistribution.hasOwnProperty(order.paymentMethod)) {
        paymentMethodDistribution[order.paymentMethod] += order.pricing.total;
      }
    });
    
    packageAssignments.forEach(assignment => {
      if (assignment.payment.isReceived && assignment.payment.paymentMethod) {
        const method = assignment.payment.paymentMethod;
        if (paymentMethodDistribution.hasOwnProperty(method)) {
          paymentMethodDistribution[method] += assignment.pricing.finalAmount;
        }
      }
    });
    
    // Average transaction value
    const totalTransactions = bookings.length + productOrders.length + packageAssignments.length;
    const averageTransactionValue = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;
    
    // Revenue by location/branch
    const revenueByLocation = {};
    bookings.forEach(booking => {
      const location = booking.branchId?.name || booking.preferredLocation || 'Unknown';
      if (!revenueByLocation[location]) {
        revenueByLocation[location] = 0;
      }
      revenueByLocation[location] += booking.consultationId?.price || 0;
    });
    
    // Revenue by service category
    const revenueByCategory = {};
    bookings.forEach(booking => {
      const category = booking.consultationId?.category || 'Uncategorized';
      if (!revenueByCategory[category]) {
        revenueByCategory[category] = 0;
      }
      revenueByCategory[category] += booking.consultationId?.price || 0;
    });
    
    // Daily revenue trend (last 30 days)
    const dailyRevenue = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      
      const dayBookings = bookings.filter(b => {
        const bookingDate = new Date(b.createdAt);
        return bookingDate >= date && bookingDate < nextDate;
      });
      
      const dayOrders = productOrders.filter(o => {
        const orderDate = new Date(o.createdAt);
        return orderDate >= date && orderDate < nextDate;
      });
      
      const dayPackages = packageAssignments.filter(p => {
        const packageDate = new Date(p.createdAt);
        return packageDate >= date && packageDate < nextDate;
      });
      
      const dayRevenue = 
        dayBookings.reduce((sum, b) => sum + (b.consultationId?.price || 0), 0) +
        dayOrders.reduce((sum, o) => sum + o.pricing.total, 0) +
        dayPackages.reduce((sum, p) => sum + p.pricing.finalAmount, 0);
      
      dailyRevenue.push({
        date: date.toISOString().split('T')[0],
        revenue: dayRevenue,
        consultations: dayBookings.length,
        orders: dayOrders.length,
        packages: dayPackages.length
      });
    }
    
    // Week-over-week growth
    const lastWeekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const previousWeekStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    
    const lastWeekRevenue = dailyRevenue
      .filter(day => new Date(day.date) >= lastWeekStart)
      .reduce((sum, day) => sum + day.revenue, 0);
    
    const previousWeekRevenue = dailyRevenue
      .filter(day => {
        const date = new Date(day.date);
        return date >= previousWeekStart && date < lastWeekStart;
      })
      .reduce((sum, day) => sum + day.revenue, 0);
    
    const weekOverWeekGrowth = previousWeekRevenue > 0
      ? ((lastWeekRevenue - previousWeekRevenue) / previousWeekRevenue) * 100
      : 0;
    
    res.status(200).json({
      success: true,
      data: {
        overview: {
          totalRevenue,
          consultationRevenue,
          productRevenue,
          packageRevenue,
          outstandingPayments,
          refundsLost,
          averageTransactionValue,
          totalTransactions,
          weekOverWeekGrowth
        },
        paymentMethodDistribution,
        revenueByLocation,
        revenueByCategory,
        dailyRevenue,
        period: {
          startDate: start,
          endDate: end
        }
      }
    });
  } catch (error) {
    console.error('Error fetching financial analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch financial analytics',
      error: error.message
    });
  }
};

// Get Monthly Revenue Trend (last 12 months)
exports.getMonthlyRevenueTrend = async (req, res) => {
  try {
    const monthlyData = [];
    
    for (let i = 11; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
      
      const bookings = await Booking.find({
        createdAt: { $gte: startOfMonth, $lte: endOfMonth },
        status: { $in: ['Confirmed', 'Completed', 'In Progress'] }
      }).populate('consultationId', 'price');
      
      const orders = await ProductOrder.find({
        createdAt: { $gte: startOfMonth, $lte: endOfMonth },
        orderStatus: { $nin: ['Cancelled', 'Returned'] }
      });
      
      const packages = await PackageAssignment.find({
        createdAt: { $gte: startOfMonth, $lte: endOfMonth },
        status: { $in: ['Active', 'Completed'] }
      });
      
      const consultationRevenue = bookings.reduce((sum, b) => sum + (b.consultationId?.price || 0), 0);
      const productRevenue = orders.reduce((sum, o) => sum + o.pricing.total, 0);
      const packageRevenue = packages.reduce((sum, p) => sum + p.pricing.finalAmount, 0);
      
      monthlyData.push({
        month: startOfMonth.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        consultationRevenue,
        productRevenue,
        packageRevenue,
        totalRevenue: consultationRevenue + productRevenue + packageRevenue
      });
    }
    
    res.status(200).json({
      success: true,
      data: monthlyData
    });
  } catch (error) {
    console.error('Error fetching monthly revenue trend:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch monthly revenue trend',
      error: error.message
    });
  }
};

// Get Daily Collection Target Progress
exports.getDailyTargetProgress = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const bookings = await Booking.find({
      createdAt: { $gte: today, $lt: tomorrow },
      status: { $in: ['Confirmed', 'Completed', 'In Progress'] }
    }).populate('consultationId', 'price');
    
    const orders = await ProductOrder.find({
      createdAt: { $gte: today, $lt: tomorrow },
      orderStatus: { $nin: ['Cancelled', 'Returned'] }
    });
    
    const packages = await PackageAssignment.find({
      createdAt: { $gte: today, $lt: tomorrow },
      status: { $in: ['Active', 'Completed'] },
      'payment.isReceived': true
    });
    
    const todayCollection = 
      bookings.reduce((sum, b) => sum + (b.consultationId?.price || 0), 0) +
      orders.reduce((sum, o) => sum + o.pricing.total, 0) +
      packages.reduce((sum, p) => sum + p.pricing.finalAmount, 0);
    
    // Set daily target (can be configured)
    const dailyTarget = 50000; // ₹50,000 default target
    const progressPercentage = (todayCollection / dailyTarget) * 100;
    
    res.status(200).json({
      success: true,
      data: {
        todayCollection,
        dailyTarget,
        progressPercentage: Math.min(progressPercentage, 100),
        difference: todayCollection - dailyTarget,
        achieved: todayCollection >= dailyTarget
      }
    });
  } catch (error) {
    console.error('Error fetching daily target progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch daily target progress',
      error: error.message
    });
  }
};

// Get Patient Analytics Overview
exports.getPatientAnalytics = async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const endDate = new Date();
    
    // Get all patients
    const totalPatients = await User.countDocuments();
    
    // Get new patients in period - use lean() to avoid date conversion issues
    const allUsersInPeriod = await User.find().select('createdAt').lean();
    const newPatients = allUsersInPeriod.filter(user => {
      if (!user.createdAt) return false;
      const createdDate = new Date(user.createdAt);
      return createdDate >= startDate && createdDate <= endDate;
    }).length;
    
    // Get returning patients (patients with more than 1 booking)
    const returningPatients = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate },
          status: { $in: ['Confirmed', 'Completed', 'In Progress'] }
        }
      },
      {
        $group: {
          _id: '$userId',
          bookingCount: { $sum: 1 }
        }
      },
      {
        $match: { bookingCount: { $gt: 1 } }
      },
      {
        $count: 'total'
      }
    ]);
    
    const returningCount = returningPatients[0]?.total || 0;
    
    // Calculate ratios
    const totalInPeriod = newPatients + returningCount;
    const newPatientRatio = totalInPeriod > 0 ? (newPatients / totalInPeriod) * 100 : 0;
    const returningPatientRatio = totalInPeriod > 0 ? (returningCount / totalInPeriod) * 100 : 0;
    
    // Calculate retention rate (patients who returned in last 3 months)
    const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const retentionData = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: threeMonthsAgo, $lte: endDate },
          status: { $in: ['Confirmed', 'Completed', 'In Progress'] }
        }
      },
      {
        $group: {
          _id: '$userId',
          bookingCount: { $sum: 1 }
        }
      },
      {
        $match: { bookingCount: { $gte: 2 } }
      },
      {
        $count: 'total'
      }
    ]);
    
    const retainedPatients = retentionData[0]?.total || 0;
    const retentionRate = totalPatients > 0 ? (retainedPatients / totalPatients) * 100 : 0;
    
    // Get birthdays today
    const today = new Date();
    const todayMonth = today.getMonth() + 1; // getMonth() returns 0-11, we need 1-12
    const todayDay = today.getDate();
    
    console.log(`🎂 Checking birthdays for: Month ${todayMonth}, Day ${todayDay}`);
    
    const birthdaysToday = await User.find({
      dateOfBirth: { $exists: true, $ne: null }
    }).select('fullName email phone dateOfBirth').lean();
    
    console.log(`📊 Found ${birthdaysToday.length} users with dateOfBirth`);
    
    // Filter birthdays for today (check only month and day, ignore year)
    const todayBirthdays = birthdaysToday.filter(user => {
      if (!user.dateOfBirth) return false;
      
      try {
        let month, day;
        
        // Handle different date formats
        if (typeof user.dateOfBirth === 'string') {
          // Format: "1990-10-20" or "1990-10-20T00:00:00.000Z" or "20/10/1990"
          const dateStr = user.dateOfBirth.split('T')[0]; // Remove time part if exists
          
          if (dateStr.includes('-')) {
            // ISO format: "1990-10-20"
            const parts = dateStr.split('-');
            month = parseInt(parts[1]);
            day = parseInt(parts[2]);
          } else if (dateStr.includes('/')) {
            // Format: "20/10/1990" (DD/MM/YYYY)
            const parts = dateStr.split('/');
            day = parseInt(parts[0]);
            month = parseInt(parts[1]);
          }
        } else if (user.dateOfBirth instanceof Date) {
          // If stored as Date object
          month = user.dateOfBirth.getMonth() + 1;
          day = user.dateOfBirth.getDate();
        }
        
        const isMatch = month === todayMonth && day === todayDay;
        
        if (isMatch) {
          console.log(`🎉 Birthday match found: ${user.fullName} - ${user.dateOfBirth}`);
        }
        
        return isMatch;
      } catch (error) {
        console.error(`❌ Error parsing date for user ${user.fullName}:`, error.message);
        return false;
      }
    }).slice(0, 10).map(user => ({
      _id: user._id,
      name: user.fullName,
      email: user.email,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth
    }));
    
    console.log(`✅ Total birthdays today: ${todayBirthdays.length}`);
    
    // Get inactive patients (no booking in 3+ months)
    const inactivePatients = await User.aggregate([
      {
        $lookup: {
          from: 'bookings',
          localField: '_id',
          foreignField: 'userId',
          as: 'bookings'
        }
      },
      {
        $addFields: {
          lastBooking: { $max: '$bookings.createdAt' }
        }
      },
      {
        $match: {
          $or: [
            { lastBooking: { $lte: threeMonthsAgo } },
            { lastBooking: null }
          ]
        }
      },
      {
        $count: 'total'
      }
    ]);
    
    // Get membership status
    const activeMemberships = await User.countDocuments({
      membershipStatus: 'Active'
    }).catch(() => 0);
    
    // Get expired and pending memberships - use lean() to avoid date issues
    const zenMembers = await User.find({ 
      memberType: 'Zen Member' 
    }).select('zenMembershipExpiryDate').lean();
    
    const now = new Date();
    const expiredMemberships = zenMembers.filter(member => {
      if (!member.zenMembershipExpiryDate) return false;
      const expiryDate = new Date(member.zenMembershipExpiryDate);
      return expiryDate < now;
    }).length;
    
    const pendingMemberships = zenMembers.filter(member => 
      !member.zenMembershipExpiryDate
    ).length;
    
    res.status(200).json({
      success: true,
      data: {
        overview: {
          totalPatients,
          newPatients,
          returningPatients: returningCount,
          newPatientRatio,
          returningPatientRatio,
          retentionRate
        },
        birthdaysToday: todayBirthdays,
        inactivePatients: {
          count: inactiveCount,
          threshold: '3+ months'
        },
        membershipStatus: {
          active: activeMemberships,
          expired: expiredMemberships,
          pending: pendingMemberships
        }
      }
    });
  } catch (error) {
    console.error('Error fetching patient analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch patient analytics',
      error: error.message
    });
  }
};

// Get Patient Acquisition Trend (Monthly)
exports.getPatientAcquisitionTrend = async (req, res) => {
  try {
    // Get all users with createdAt using lean() to avoid date conversion issues
    const allUsers = await User.find().select('createdAt').lean();
    
    const monthlyData = [];
    
    for (let i = 11; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
      
      // Filter in JavaScript instead of MongoDB
      const count = allUsers.filter(user => {
        if (!user.createdAt) return false;
        const createdDate = new Date(user.createdAt);
        return createdDate >= startOfMonth && createdDate <= endOfMonth;
      }).length;
      
      monthlyData.push({
        month: startOfMonth.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        count
      });
    }
    
    res.status(200).json({
      success: true,
      data: monthlyData
    });
  } catch (error) {
    console.error('Error fetching patient acquisition trend:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch patient acquisition trend',
      error: error.message
    });
  }
};

// Get Top Valuable Patients
exports.getTopPatients = async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    
    // Aggregate spending from all sources
    const topPatients = await Booking.aggregate([
      {
        $match: {
          status: { $in: ['Confirmed', 'Completed', 'In Progress'] }
        }
      },
      {
        $lookup: {
          from: 'consultations',
          localField: 'consultationId',
          foreignField: '_id',
          as: 'consultation'
        }
      },
      {
        $unwind: '$consultation'
      },
      {
        $group: {
          _id: '$userId',
          totalSpent: { $sum: '$consultation.price' },
          visitCount: { $sum: 1 }
        }
      },
      {
        $sort: { totalSpent: -1 }
      },
      {
        $limit: parseInt(limit)
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'patient'
        }
      },
      {
        $unwind: '$patient'
      },
      {
        $project: {
          _id: 1,
          name: '$patient.fullName',
          email: '$patient.email',
          phone: '$patient.phone',
          totalSpent: 1,
          visitCount: 1
        }
      }
    ]);
    
    res.status(200).json({
      success: true,
      data: topPatients
    });
  } catch (error) {
    console.error('Error fetching top patients:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch top patients',
      error: error.message
    });
  }
};

// Get Patient Demographics
exports.getPatientDemographics = async (req, res) => {
  try {
    // Age distribution
    const patients = await User.find({ dateOfBirth: { $exists: true, $ne: null } }).lean();
    
    const ageGroups = {
      '0-18': 0,
      '19-30': 0,
      '31-45': 0,
      '46-60': 0,
      '61+': 0
    };
    
    const today = new Date();
    patients.forEach(patient => {
      try {
        // Handle both string and Date types
        const dob = typeof patient.dateOfBirth === 'string' ? new Date(patient.dateOfBirth) : patient.dateOfBirth;
        if (!isNaN(dob.getTime())) {
          const age = today.getFullYear() - dob.getFullYear();
          if (age <= 18) ageGroups['0-18']++;
          else if (age <= 30) ageGroups['19-30']++;
          else if (age <= 45) ageGroups['31-45']++;
          else if (age <= 60) ageGroups['46-60']++;
          else ageGroups['61+']++;
        }
      } catch (err) {
        // Skip invalid dates
        console.log('Invalid date for patient:', patient._id);
      }
    });
    
    const total = patients.length;
    const ageGroupsArray = Object.entries(ageGroups).map(([range, count]) => ({
      range,
      count,
      percentage: total > 0 ? (count / total) * 100 : 0
    }));
    
    // Gender distribution
    const male = await User.countDocuments({ gender: 'Male' });
    const female = await User.countDocuments({ gender: 'Female' });
    const other = await User.countDocuments({ gender: { $nin: ['Male', 'Female'] } });
    const totalGender = male + female + other;
    
    res.status(200).json({
      success: true,
      data: {
        ageGroups: ageGroupsArray,
        gender: {
          male,
          female,
          other,
          total: totalGender
        }
      }
    });
  } catch (error) {
    console.error('Error fetching patient demographics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch patient demographics',
      error: error.message
    });
  }
};

// Get Patient Sources
exports.getPatientSources = async (req, res) => {
  try {
    // Since referralSource field doesn't exist in User model, 
    // we'll use location as a proxy for now or return default data
    const sources = await User.aggregate([
      {
        $group: {
          _id: '$location',
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);
    
    const total = sources.reduce((sum, source) => sum + source.count, 0);
    
    // Map location to source channels (can be updated later)
    const sourcesWithPercentage = sources.map(source => ({
      source: source._id || 'Direct',
      count: source.count,
      percentage: total > 0 ? (source.count / total) * 100 : 0
    }));
    
    // Add default sources if no data
    if (sourcesWithPercentage.length === 0) {
      sourcesWithPercentage.push(
        { source: 'Instagram', count: 0, percentage: 0 },
        { source: 'Google', count: 0, percentage: 0 },
        { source: 'Direct', count: 0, percentage: 0 },
        { source: 'Referral', count: 0, percentage: 0 }
      );
    }
    
    res.status(200).json({
      success: true,
      data: sourcesWithPercentage
    });
  } catch (error) {
    console.error('Error fetching patient sources:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch patient sources',
      error: error.message
    });
  }
};

// Send Birthday Wish Email
exports.sendBirthdayWish = async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Get user details
    const user = await User.findById(userId).select('fullName email');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.email) {
      return res.status(400).json({
        success: false,
        message: 'User email not found'
      });
    }

    // Import email service
    const { sendBirthdayWish } = require('../utils/emailService');
    
    // Send birthday wish email
    await sendBirthdayWish(user.email, user.fullName);

    res.status(200).json({
      success: true,
      message: `Birthday wish sent successfully to ${user.fullName}!`
    });
  } catch (error) {
    console.error('Error sending birthday wish:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send birthday wish email',
      error: error.message
    });
  }
};

// ========================================
// APPOINTMENT & BOOKING ANALYTICS
// ========================================

// Get Comprehensive Appointment Analytics
exports.getAppointmentAnalytics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Default to last 30 days
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    // Get all bookings in date range
    const bookings = await Booking.find({
      createdAt: { $gte: start, $lte: end }
    }).populate('consultationId', 'name category');

    const totalBookings = bookings.length;
    const completedBookings = bookings.filter(b => b.status === 'Completed').length;
    const cancelledBookings = bookings.filter(b => b.status === 'Cancelled').length;
    const noShowBookings = bookings.filter(b => b.status === 'No Show').length;
    const pendingBookings = bookings.filter(b => b.status === 'Pending').length;

    // 1. Appointment Conversion Rate
    const conversionRate = totalBookings > 0 ? (completedBookings / totalBookings) * 100 : 0;

    // 2. Average Appointments per Day/Week/Month
    const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) || 1;
    const avgPerDay = totalBookings / daysDiff;
    const avgPerWeek = avgPerDay * 7;
    const avgPerMonth = avgPerDay * 30;

    // 3. Peak Booking Hours (0-23)
    const hourlyBookings = Array(24).fill(0);
    bookings.forEach(booking => {
      if (booking.timeSlot) {
        const hour = parseInt(booking.timeSlot.split(':')[0]);
        if (!isNaN(hour) && hour >= 0 && hour < 24) {
          hourlyBookings[hour]++;
        }
      }
    });

    // 4. Peak Booking Days (0=Sunday, 6=Saturday)
    const dayOfWeekBookings = Array(7).fill(0);
    bookings.forEach(booking => {
      const day = new Date(booking.appointmentDate).getDay();
      dayOfWeekBookings[day]++;
    });

    // 5. Cancellation Rate Trend (last 7 days)
    const cancellationTrend = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);

      const dayBookings = bookings.filter(b => {
        const bookingDate = new Date(b.appointmentDate);
        return bookingDate >= date && bookingDate < nextDate;
      });

      const dayCancellations = dayBookings.filter(b => b.status === 'Cancelled').length;
      const cancellationRate = dayBookings.length > 0 ? (dayCancellations / dayBookings.length) * 100 : 0;

      cancellationTrend.push({
        date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        rate: parseFloat(cancellationRate.toFixed(1)),
        cancelled: dayCancellations,
        total: dayBookings.length
      });
    }

    // 6. No-Show Rate by Service Type
    const serviceTypeStats = {};
    bookings.forEach(booking => {
      const serviceType = booking.consultationId?.category || 'Unknown';
      if (!serviceTypeStats[serviceType]) {
        serviceTypeStats[serviceType] = { total: 0, noShow: 0 };
      }
      serviceTypeStats[serviceType].total++;
      if (booking.status === 'No Show') {
        serviceTypeStats[serviceType].noShow++;
      }
    });

    const noShowByService = Object.keys(serviceTypeStats).map(service => ({
      service,
      noShowRate: serviceTypeStats[service].total > 0 
        ? ((serviceTypeStats[service].noShow / serviceTypeStats[service].total) * 100).toFixed(1)
        : 0,
      noShowCount: serviceTypeStats[service].noShow,
      totalBookings: serviceTypeStats[service].total
    }));

    // 7. Average Time Between Bookings (per patient)
    const patientBookings = {};
    bookings.forEach(booking => {
      const userId = booking.userId?.toString();
      if (userId) {
        if (!patientBookings[userId]) {
          patientBookings[userId] = [];
        }
        patientBookings[userId].push(new Date(booking.appointmentDate));
      }
    });

    let totalTimeDiffs = [];
    Object.values(patientBookings).forEach(dates => {
      if (dates.length > 1) {
        dates.sort((a, b) => a - b);
        for (let i = 1; i < dates.length; i++) {
          const diffDays = (dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24);
          totalTimeDiffs.push(diffDays);
        }
      }
    });

    const avgTimeBetweenBookings = totalTimeDiffs.length > 0
      ? totalTimeDiffs.reduce((a, b) => a + b, 0) / totalTimeDiffs.length
      : 0;

    // 8. Upcoming Appointments This Week
    const startOfWeek = new Date();
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    const upcomingThisWeek = await Booking.countDocuments({
      appointmentDate: { $gte: startOfWeek, $lte: endOfWeek },
      status: { $in: ['Pending', 'Confirmed'] }
    });

    // 9. Pending Confirmations Count
    const pendingConfirmations = await Booking.countDocuments({
      status: 'Pending',
      appointmentDate: { $gte: new Date() }
    });

    // Response
    res.status(200).json({
      success: true,
      data: {
        overview: {
          totalBookings,
          completedBookings,
          cancelledBookings,
          noShowBookings,
          pendingBookings,
          conversionRate: parseFloat(conversionRate.toFixed(1)),
          cancellationRate: totalBookings > 0 ? parseFloat(((cancelledBookings / totalBookings) * 100).toFixed(1)) : 0,
          noShowRate: totalBookings > 0 ? parseFloat(((noShowBookings / totalBookings) * 100).toFixed(1)) : 0
        },
        averages: {
          perDay: parseFloat(avgPerDay.toFixed(1)),
          perWeek: parseFloat(avgPerWeek.toFixed(1)),
          perMonth: parseFloat(avgPerMonth.toFixed(1))
        },
        peakHours: hourlyBookings.map((count, hour) => ({
          hour: `${hour.toString().padStart(2, '0')}:00`,
          count
        })),
        peakDays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => ({
          day,
          count: dayOfWeekBookings[index]
        })),
        cancellationTrend,
        noShowByService,
        avgTimeBetweenBookings: parseFloat(avgTimeBetweenBookings.toFixed(1)),
        upcomingThisWeek,
        pendingConfirmations
      }
    });
  } catch (error) {
    console.error('Error fetching appointment analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch appointment analytics',
      error: error.message
    });
  }
};

// ========================================
// SERVICE & TREATMENT PERFORMANCE ANALYTICS
// ========================================

// Get Comprehensive Service Analytics
exports.getServiceAnalytics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Default to last 30 days
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    // Get all bookings with consultation details
    const bookings = await Booking.find({
      createdAt: { $gte: start, $lte: end },
      status: { $in: ['Confirmed', 'Completed', 'In Progress'] }
    }).populate('consultationId', 'name category price duration');

    // Get all consultations/services
    const allServices = await Consultation.find();

    // 1. Top 10 Services by Revenue
    const serviceRevenue = {};
    bookings.forEach(booking => {
      const serviceId = booking.consultationId?._id?.toString();
      const serviceName = booking.consultationId?.name;
      const price = booking.consultationId?.price || 0;
      
      if (serviceId && serviceName) {
        if (!serviceRevenue[serviceId]) {
          serviceRevenue[serviceId] = {
            id: serviceId,
            name: serviceName,
            category: booking.consultationId.category,
            revenue: 0,
            bookings: 0
          };
        }
        serviceRevenue[serviceId].revenue += price;
        serviceRevenue[serviceId].bookings += 1;
      }
    });

    const topServicesByRevenue = Object.values(serviceRevenue)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // 2. Top 10 Services by Volume
    const topServicesByVolume = Object.values(serviceRevenue)
      .sort((a, b) => b.bookings - a.bookings)
      .slice(0, 10);

    // 3. Service-wise Profit Margin (assuming 60% margin for simplicity)
    const serviceProfitMargin = topServicesByRevenue.map(service => ({
      ...service,
      cost: service.revenue * 0.4, // 40% cost
      profit: service.revenue * 0.6, // 60% profit
      margin: 60
    }));

    // 4. Least Performing Services (Underutilized)
    const allServiceIds = allServices.map(s => s._id.toString());
    const bookedServiceIds = Object.keys(serviceRevenue);
    const unbookedServices = allServiceIds.filter(id => !bookedServiceIds.includes(id));
    
    const leastPerformingServices = allServices
      .filter(service => {
        const serviceId = service._id.toString();
        return serviceRevenue[serviceId]?.bookings < 5 || unbookedServices.includes(serviceId);
      })
      .map(service => ({
        id: service._id,
        name: service.name,
        category: service.category,
        price: service.price,
        bookings: serviceRevenue[service._id.toString()]?.bookings || 0,
        revenue: serviceRevenue[service._id.toString()]?.revenue || 0
      }))
      .sort((a, b) => a.bookings - b.bookings)
      .slice(0, 10);

    // 5. Average Service Duration vs Scheduled
    const durationComparison = [];
    Object.values(serviceRevenue).forEach(service => {
      const serviceData = allServices.find(s => s._id.toString() === service.id);
      if (serviceData && serviceData.duration) {
        durationComparison.push({
          name: service.name,
          scheduled: serviceData.duration,
          actual: serviceData.duration + Math.floor(Math.random() * 10 - 5), // Simulated actual duration
          variance: Math.floor(Math.random() * 10 - 5)
        });
      }
    });

    // 6. Service Category Performance
    const categoryPerformance = {};
    bookings.forEach(booking => {
      const category = booking.consultationId?.category || 'Other';
      const price = booking.consultationId?.price || 0;
      
      if (!categoryPerformance[category]) {
        categoryPerformance[category] = {
          category,
          revenue: 0,
          bookings: 0,
          avgPrice: 0
        };
      }
      categoryPerformance[category].revenue += price;
      categoryPerformance[category].bookings += 1;
    });

    Object.values(categoryPerformance).forEach(cat => {
      cat.avgPrice = cat.bookings > 0 ? cat.revenue / cat.bookings : 0;
    });

    const categoryPerformanceArray = Object.values(categoryPerformance)
      .sort((a, b) => b.revenue - a.revenue);

    // 7. New Services Added This Month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const newServicesThisMonth = await Consultation.find({
      createdAt: { $gte: startOfMonth }
    }).select('name category price createdAt');

    // 8. Package Utilization Rate
    const packageAssignments = await PackageAssignment.find({
      createdAt: { $gte: start, $lte: end }
    }).populate('packageId', 'name services');

    const packageUtilization = [];
    for (const assignment of packageAssignments) {
      if (assignment.packageId && assignment.services) {
        const totalSessions = assignment.services.reduce((sum, service) => sum + service.sessionsIncluded, 0);
        const usedSessions = assignment.services.reduce((sum, service) => sum + service.sessionsCompleted, 0);
        const utilizationRate = totalSessions > 0 ? (usedSessions / totalSessions) * 100 : 0;

        packageUtilization.push({
          packageName: assignment.packageId.name,
          totalSessions,
          usedSessions,
          remainingSessions: totalSessions - usedSessions,
          utilizationRate: parseFloat(utilizationRate.toFixed(1))
        });
      }
    }

    // Response
    res.status(200).json({
      success: true,
      data: {
        topServicesByRevenue,
        topServicesByVolume,
        serviceProfitMargin: serviceProfitMargin.slice(0, 10),
        leastPerformingServices,
        durationComparison: durationComparison.slice(0, 10),
        categoryPerformance: categoryPerformanceArray,
        newServicesThisMonth: {
          count: newServicesThisMonth.length,
          services: newServicesThisMonth
        },
        packageUtilization: packageUtilization.slice(0, 10),
        summary: {
          totalRevenue: Object.values(serviceRevenue).reduce((sum, s) => sum + s.revenue, 0),
          totalBookings: bookings.length,
          totalServices: allServices.length,
          activeServices: Object.keys(serviceRevenue).length,
          avgRevenuePerService: Object.keys(serviceRevenue).length > 0 
            ? Object.values(serviceRevenue).reduce((sum, s) => sum + s.revenue, 0) / Object.keys(serviceRevenue).length
            : 0
        }
      }
    });
  } catch (error) {
    console.error('Error fetching service analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch service analytics',
      error: error.message
    });
  }
};

// ========================================
// INVENTORY & PRODUCT INSIGHTS
// ========================================

// Import inventory analytics from separate module
const { getInventoryAnalytics } = require('./inventoryAnalyticsController');
exports.getInventoryAnalytics = getInventoryAnalytics;

// OLD VERSION - REPLACED WITH NEW ONE
exports.getInventoryAnalyticsOld = async (req, res) => {
  try {
    // Get all inventory items
    const inventoryItems = await Inventory.find().populate('productId', 'name brand formulation price');

    // 1. Low Stock Alerts (Critical items) - Less than 20% of reorder level
    const lowStockItems = inventoryItems.filter(item => {
      const reorderLevel = item.reorderLevel || 50;
      return item.quantity <= reorderLevel * 0.2 && item.quantity > 0;
    }).map(item => ({
      id: item._id,
      productName: item.productId?.name || item.productName,
      quantity: item.quantity,
      reorderLevel: item.reorderLevel || 50,
      location: item.location,
      critical: true
    })).slice(0, 10);

    // 2. Out of Stock Items Count
    const outOfStockItems = inventoryItems.filter(item => item.quantity === 0);
    const outOfStockCount = outOfStockItems.length;

    // 3. Fast-Moving Products (Top sellers) - Based on quantity changes
    const fastMovingProducts = inventoryItems
      .filter(item => item.quantity > 0)
      .map(item => ({
        id: item._id,
        productName: item.productId?.name || item.productName,
        brand: item.productId?.brand,
        quantity: item.quantity,
        soldUnits: Math.floor(Math.random() * 100) + 50, // Simulated sales data
        turnoverRate: (Math.random() * 5 + 3).toFixed(1)
      }))
      .sort((a, b) => b.soldUnits - a.soldUnits)
      .slice(0, 10);

    // 4. Slow-Moving Inventory (Dead stock) - Low turnover
    const slowMovingInventory = inventoryItems
      .filter(item => item.quantity > 0)
      .map(item => ({
        id: item._id,
        productName: item.productId?.name || item.productName,
        quantity: item.quantity,
        daysInStock: Math.floor(Math.random() * 180) + 90, // Simulated days
        turnoverRate: (Math.random() * 0.5).toFixed(2),
        value: item.quantity * (item.productId?.price || 0)
      }))
      .sort((a, b) => parseFloat(a.turnoverRate) - parseFloat(b.turnoverRate))
      .slice(0, 10);

    // 5. Inventory Value (Total stock worth)
    const totalInventoryValue = inventoryItems.reduce((sum, item) => {
      const price = item.productId?.price || 0;
      return sum + (item.quantity * price);
    }, 0);

    const inventoryValueByCategory = {};
    inventoryItems.forEach(item => {
      const formulation = item.productId?.formulation || 'Other';
      const value = item.quantity * (item.productId?.price || 0);
      
      if (!inventoryValueByCategory[formulation]) {
        inventoryValueByCategory[formulation] = 0;
      }
      inventoryValueByCategory[formulation] += value;
    });

    // 6. Product Expiry Alerts
    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const sixtyDays = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const ninetyDays = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const expiringItems = inventoryItems.filter(item => item.expiryDate);
    
    const expiryAlerts = {
      expiring30Days: expiringItems.filter(item => {
        const expiryDate = new Date(item.expiryDate);
        return expiryDate >= now && expiryDate <= thirtyDays;
      }).map(item => ({
        id: item._id,
        productName: item.productId?.name || item.productName,
        quantity: item.quantity,
        expiryDate: item.expiryDate,
        daysUntilExpiry: Math.ceil((new Date(item.expiryDate) - now) / (1000 * 60 * 60 * 24))
      })),
      expiring60Days: expiringItems.filter(item => {
        const expiryDate = new Date(item.expiryDate);
        return expiryDate > thirtyDays && expiryDate <= sixtyDays;
      }).length,
      expiring90Days: expiringItems.filter(item => {
        const expiryDate = new Date(item.expiryDate);
        return expiryDate > sixtyDays && expiryDate <= ninetyDays;
      }).length
    };

    // 7. Reorder Point Status
    const itemsNeedingReorder = inventoryItems.filter(item => {
      const reorderLevel = item.reorderLevel || 50;
      return item.quantity <= reorderLevel && item.quantity > 0;
    }).map(item => ({
      id: item._id,
      productName: item.productId?.name || item.productName,
      currentQuantity: item.quantity,
      reorderLevel: item.reorderLevel || 50,
      deficit: (item.reorderLevel || 50) - item.quantity
    }));

    // 8. Vendor Performance (Simulated data)
    const vendorPerformance = [
      { vendor: 'Vendor A', deliveryTime: 3.5, qualityRating: 4.5, onTimeDelivery: 92 },
      { vendor: 'Vendor B', deliveryTime: 2.8, qualityRating: 4.8, onTimeDelivery: 95 },
      { vendor: 'Vendor C', deliveryTime: 4.2, qualityRating: 4.2, onTimeDelivery: 88 },
      { vendor: 'Vendor D', deliveryTime: 3.1, qualityRating: 4.6, onTimeDelivery: 90 }
    ];

    // 9. Product-wise Profit Margin (Assuming 40% cost)
    const productProfitMargins = inventoryItems
      .filter(item => item.quantity > 0 && item.productId?.price)
      .map(item => ({
        productName: item.productId?.name || item.productName,
        sellingPrice: item.productId?.price || 0,
        cost: (item.productId?.price || 0) * 0.6, // 60% of price as cost
        profit: (item.productId?.price || 0) * 0.4, // 40% profit
        margin: 40,
        quantity: item.quantity
      }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 10);

    // 10. Inventory Turnover Ratio
    const totalCost = inventoryItems.reduce((sum, item) => {
      return sum + (item.quantity * (item.productId?.price || 0) * 0.6);
    }, 0);

    const avgInventoryCost = totalCost / 2; // Simplified average
    const cogs = totalCost * 2; // Simulated COGS
    const inventoryTurnoverRatio = avgInventoryCost > 0 ? (cogs / avgInventoryCost).toFixed(2) : 0;

    // Response
    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalItems: inventoryItems.length,
          totalValue: Math.round(totalInventoryValue),
          lowStockCount: lowStockItems.length,
          outOfStockCount,
          reorderNeededCount: itemsNeedingReorder.length,
          expiringIn30Days: expiryAlerts.expiring30Days.length
        },
        lowStockAlerts: lowStockItems,
        outOfStockItems: outOfStockItems.slice(0, 10).map(item => ({
          id: item._id,
          productName: item.productId?.name || item.productName,
          location: item.location,
          lastRestocked: item.lastRestocked
        })),
        fastMovingProducts,
        slowMovingInventory,
        inventoryValue: {
          total: Math.round(totalInventoryValue),
          byCategory: Object.keys(inventoryValueByCategory).map(category => ({
            category,
            value: Math.round(inventoryValueByCategory[category])
          })).sort((a, b) => b.value - a.value)
        },
        expiryAlerts,
        reorderPointStatus: itemsNeedingReorder.slice(0, 10),
        vendorPerformance,
        productProfitMargins,
        inventoryTurnoverRatio: parseFloat(inventoryTurnoverRatio)
      }
    });
  } catch (error) {
    console.error('Error fetching inventory analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch inventory analytics',
      error: error.message
    });
  }
};

module.exports = exports;
