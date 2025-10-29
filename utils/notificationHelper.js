const Notification = require('../models/Notification');

/**
 * Notification Helper
 * Utility functions to create notifications for various events
 */

class NotificationHelper {
  /**
   * Create a notification
   * @param {Object} data - Notification data
   */
  static async create(data) {
    try {
      const notification = new Notification(data);
      await notification.save();
      return notification;
    } catch (error) {
      console.error('Error creating notification:', error);
      throw error;
    }
  }

  /**
   * Booking Notifications
   */
  static async bookingCreated(booking) {
    try {
      return await this.create({
        type: 'booking',
        title: 'New Booking Created',
        message: `New booking for ${booking.consultation?.name || 'consultation'} at ${booking.branch?.name || 'branch'} on ${new Date(booking.appointmentDate).toLocaleDateString()}`,
        relatedId: booking._id,
        relatedModel: 'Booking',
        priority: 'high',
        metadata: {
          bookingId: booking._id,
          patientName: booking.patientName,
          consultationName: booking.consultation?.name,
          branchName: booking.branch?.name,
          appointmentDate: booking.appointmentDate
        }
      });
    } catch (error) {
      console.error('Error creating booking notification:', error);
    }
  }

  static async bookingConfirmed(booking) {
    try {
      return await this.create({
        type: 'booking',
        title: 'Booking Confirmed',
        message: `Booking for ${booking.patientName} has been confirmed`,
        relatedId: booking._id,
        relatedModel: 'Booking',
        priority: 'medium',
        metadata: {
          bookingId: booking._id,
          patientName: booking.patientName
        }
      });
    } catch (error) {
      console.error('Error creating booking confirmation notification:', error);
    }
  }

  static async bookingCancelled(booking) {
    try {
      return await this.create({
        type: 'booking',
        title: 'Booking Cancelled',
        message: `Booking for ${booking.patientName} has been cancelled`,
        relatedId: booking._id,
        relatedModel: 'Booking',
        priority: 'medium',
        metadata: {
          bookingId: booking._id,
          patientName: booking.patientName
        }
      });
    } catch (error) {
      console.error('Error creating booking cancellation notification:', error);
    }
  }

  /**
   * Order Notifications
   */
  static async orderCreated(order) {
    try {
      console.log('📝 Creating order notification with data:', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        totalAmount: order.totalAmount,
        customerName: order.shippingAddress?.name
      });
      
      return await this.create({
        type: 'order',
        title: 'New Order Placed',
        message: `New order #${order.orderNumber || order._id} for ₹${order.totalAmount?.toFixed(2) || '0.00'} from ${order.shippingAddress?.name || 'customer'}`,
        relatedId: order._id,
        relatedModel: 'ProductOrder',
        priority: 'high',
        metadata: {
          orderId: order._id,
          orderNumber: order.orderNumber,
          totalAmount: order.totalAmount,
          customerName: order.shippingAddress?.name
        }
      });
    } catch (error) {
      console.error('❌ Error creating order notification:', error);
      throw error; // Re-throw so the calling code knows there was an error
    }
  }

  static async orderStatusChanged(order, oldStatus, newStatus) {
    try {
      return await this.create({
        type: 'order',
        title: 'Order Status Updated',
        message: `Order #${order.orderNumber || order._id} status changed from ${oldStatus} to ${newStatus}`,
        relatedId: order._id,
        relatedModel: 'ProductOrder',
        priority: 'medium',
        metadata: {
          orderId: order._id,
          orderNumber: order.orderNumber,
          oldStatus,
          newStatus
        }
      });
    } catch (error) {
      console.error('Error creating order status notification:', error);
    }
  }

  static async paymentReceived(order) {
    try {
      return await this.create({
        type: 'order',
        title: 'Payment Received',
        message: `Payment of ₹${order.totalAmount.toFixed(2)} received for order #${order.orderNumber || order._id}`,
        relatedId: order._id,
        relatedModel: 'ProductOrder',
        priority: 'high',
        metadata: {
          orderId: order._id,
          orderNumber: order.orderNumber,
          amount: order.totalAmount
        }
      });
    } catch (error) {
      console.error('Error creating payment notification:', error);
    }
  }

  /**
   * Consultation Notifications
   */
  static async consultationCreated(consultation) {
    try {
      return await this.create({
        type: 'consultation',
        title: 'New Consultation Service Added',
        message: `New consultation service "${consultation.name}" has been added`,
        relatedId: consultation._id,
        relatedModel: 'Consultation',
        priority: 'medium',
        metadata: {
          consultationId: consultation._id,
          consultationName: consultation.name,
          price: consultation.price
        }
      });
    } catch (error) {
      console.error('Error creating consultation notification:', error);
    }
  }

  static async consultationUpdated(consultation) {
    try {
      return await this.create({
        type: 'consultation',
        title: 'Consultation Service Updated',
        message: `Consultation service "${consultation.name}" has been updated`,
        relatedId: consultation._id,
        relatedModel: 'Consultation',
        priority: 'low',
        metadata: {
          consultationId: consultation._id,
          consultationName: consultation.name
        }
      });
    } catch (error) {
      console.error('Error creating consultation update notification:', error);
    }
  }

  /**
   * Product Notifications
   */
  static async productCreated(product) {
    try {
      return await this.create({
        type: 'product',
        title: 'New Product Added',
        message: `New product "${product.name}" has been added to the catalog`,
        relatedId: product._id,
        relatedModel: 'Product',
        priority: 'medium',
        metadata: {
          productId: product._id,
          productName: product.name,
          price: product.price
        }
      });
    } catch (error) {
      console.error('Error creating product notification:', error);
    }
  }

  static async productUpdated(product) {
    try {
      return await this.create({
        type: 'product',
        title: 'Product Updated',
        message: `Product "${product.name}" has been updated`,
        relatedId: product._id,
        relatedModel: 'Product',
        priority: 'low',
        metadata: {
          productId: product._id,
          productName: product.name
        }
      });
    } catch (error) {
      console.error('Error creating product update notification:', error);
    }
  }

  /**
   * Inventory Notifications
   */
  static async lowStockAlert(inventory) {
    try {
      return await this.create({
        type: 'inventory',
        title: 'Low Stock Alert',
        message: `${inventory.product?.name || 'Product'} is running low - Only ${inventory.quantity} units remaining`,
        relatedId: inventory._id,
        relatedModel: 'Inventory',
        priority: 'urgent',
        metadata: {
          inventoryId: inventory._id,
          productName: inventory.product?.name,
          quantity: inventory.quantity,
          branch: inventory.branch?.name
        }
      });
    } catch (error) {
      console.error('Error creating low stock notification:', error);
    }
  }

  static async outOfStockAlert(inventory) {
    try {
      return await this.create({
        type: 'inventory',
        title: 'Out of Stock Alert',
        message: `${inventory.product?.name || 'Product'} is out of stock at ${inventory.branch?.name || 'branch'}`,
        relatedId: inventory._id,
        relatedModel: 'Inventory',
        priority: 'urgent',
        metadata: {
          inventoryId: inventory._id,
          productName: inventory.product?.name,
          branch: inventory.branch?.name
        }
      });
    } catch (error) {
      console.error('Error creating out of stock notification:', error);
    }
  }

  static async inventoryRestocked(inventory) {
    try {
      return await this.create({
        type: 'inventory',
        title: 'Inventory Restocked',
        message: `${inventory.product?.name || 'Product'} has been restocked - ${inventory.quantity} units available`,
        relatedId: inventory._id,
        relatedModel: 'Inventory',
        priority: 'low',
        metadata: {
          inventoryId: inventory._id,
          productName: inventory.product?.name,
          quantity: inventory.quantity,
          branch: inventory.branch?.name
        }
      });
    } catch (error) {
      console.error('Error creating inventory restock notification:', error);
    }
  }
}

module.exports = NotificationHelper;
