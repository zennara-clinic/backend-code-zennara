# Product Order Status Flow - Zennara Clinic

## Status Sequence

### 1. **Order Placed** (Initial Status)
- **When**: User successfully creates an order from mobile app
- **Notifications Sent**: 
  - ✅ WhatsApp: Order Confirmation
  - ✅ Email: Order Confirmation
- **Next Actions**: Admin can confirm or cancel

### 2. **Confirmed** (Admin Action)
- **When**: Admin accepts the order from admin panel
- **Notifications Sent**:
  - ✅ WhatsApp: Order Confirmation (detailed)
  - ✅ Email: Order Confirmation (detailed)
- **Next Actions**: Admin moves to Processing

### 3. **Processing** (Admin Action)
- **When**: Order is being prepared
- **Notifications Sent**:
  - ✅ WhatsApp: Order Processing
  - ✅ Email: Order Processing
- **Next Actions**: Admin moves to Packed

### 4. **Packed** (Admin Action)
- **When**: Order is packed and ready for shipment
- **Notifications Sent**:
  - ✅ WhatsApp: Order Packed
  - ✅ Email: Order Packed
- **Next Actions**: Admin moves to Shipped

### 5. **Shipped** (Admin Action)
- **When**: Order is handed to courier
- **Notifications Sent**:
  - ✅ WhatsApp: Order Shipped (with tracking)
  - ✅ Email: Order Shipped (with tracking)
- **Fields Updated**: trackingId, estimatedDelivery, courier
- **Next Actions**: Admin moves to Out for Delivery

### 6. **Out for Delivery** (Admin Action)
- **When**: Order is out for delivery
- **Notifications Sent**:
  - ✅ WhatsApp: Out for Delivery
  - ✅ Email: Out for Delivery
- **Fields Updated**: deliveryPartner, expectedDeliveryTime
- **Next Actions**: Admin marks as Delivered

### 7. **Delivered** (Admin Action)
- **When**: Order successfully delivered
- **Notifications Sent**:
  - ✅ WhatsApp: Order Delivered
  - ✅ Email: Order Delivered
- **Fields Updated**: deliveredAt, paymentStatus = 'Paid' (for COD)
- **Next Actions**: User can rate or request return

### 8. **Cancelled** (User or Admin Action)
- **When**: Order cancelled before delivery
- **Notifications Sent**:
  - ✅ WhatsApp: Order Cancelled
  - ✅ Email: Order Cancelled
- **Fields Updated**: cancelledAt, cancelReason
- **Stock Action**: Items restored to inventory
- **Refund**: If payment made, refund initiated

### 9. **Returned** (User Request + Admin Approval)
- **When**: User requests return after delivery
- **Process**:
  1. User requests return → "Return Requested" notification
  2. Admin approves → "Return Approved" notification + status = "Returned"
  3. Admin rejects → "Return Rejected" notification (status unchanged)
- **Notifications**: Separate notifications for each step

---

## Valid Status Transitions

```
Order Placed → Confirmed → Processing → Packed → Shipped → Out for Delivery → Delivered
     ↓            ↓            ↓           ↓         ↓              ↓
Cancelled    Cancelled    Cancelled   Cancelled  Cancelled    Returned
```

---

## API Endpoints

### User Endpoints
- `POST /api/product-orders` - Create order (status: "Order Placed")
- `GET /api/product-orders` - Get user orders
- `GET /api/product-orders/:id` - Get single order
- `POST /api/product-orders/:id/cancel` - Cancel order
- `POST /api/product-orders/:id/return` - Request return

### Admin Endpoints
- `GET /api/admin/product-orders` - Get all orders
- `GET /api/admin/product-orders/:id` - Get single order
- `PUT /api/admin/product-orders/:id/status` - Update order status
- `POST /api/admin/product-orders/:id/return/approve` - Approve return
- `POST /api/admin/product-orders/:id/return/reject` - Reject return
- `GET /api/admin/product-orders/stats` - Get order statistics

---

## Mobile App Compatibility

All status changes are backward compatible. The mobile app will:
- Display "Order Placed" instead of "Pending" for new orders
- Continue to work with existing order statuses
- Receive real-time notifications via:
  - In-app notifications (NotificationHelper)
  - WhatsApp messages
  - Email notifications

---

## Admin Panel Updates Required

**IMPORTANT**: Admin panel frontend needs to update:

1. **Status Dropdown**:
   - Replace "Pending" with "Order Placed"
   - Keep all other statuses same

2. **Statistics Dashboard**:
   - Replace `pendingOrders` with `newOrders` (Order Placed count)
   - Add `confirmedOrders` (Confirmed count)

3. **Order Filters**:
   - Update filter options to use "Order Placed" instead of "Pending"

---

## Database Model

```javascript
orderStatus: {
  type: String,
  enum: [
    'Order Placed',    // Initial status when user creates order
    'Confirmed',       // Admin confirms the order
    'Processing',      // Order being prepared
    'Packed',          // Order packed
    'Shipped',         // Order shipped
    'Out for Delivery',// Out for delivery
    'Delivered',       // Successfully delivered
    'Cancelled',       // Cancelled by user/admin
    'Returned'         // Returned by user
  ],
  default: 'Order Placed'
}
```

---

## Testing Checklist

- [ ] User places order → Status = "Order Placed" → WhatsApp + Email sent
- [ ] Admin confirms order → Status = "Confirmed" → WhatsApp + Email sent
- [ ] Admin moves to Processing → WhatsApp + Email sent
- [ ] Admin moves to Packed → WhatsApp + Email sent
- [ ] Admin moves to Shipped → WhatsApp + Email sent (with tracking)
- [ ] Admin moves to Out for Delivery → WhatsApp + Email sent
- [ ] Admin marks Delivered → WhatsApp + Email sent + payment marked paid
- [ ] User cancels order → WhatsApp + Email sent + stock restored
- [ ] Admin cancels order → WhatsApp + Email sent + stock restored
- [ ] User requests return → WhatsApp + Email sent
- [ ] Admin approves return → WhatsApp + Email sent
- [ ] Admin rejects return → WhatsApp + Email sent

---

**Last Updated**: November 7, 2025
**Version**: 2.0
**Status**: Production Ready
