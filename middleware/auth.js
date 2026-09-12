const jwt = require('jsonwebtoken');
const Token = require('../models/Token');
const crypto = require('crypto');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
/** The stored session for a bearer: by hash (current), else by raw value (sessions from before hashing). */
const findSession = (token) => Token.findOne({ $or: [{ tokenHash: hashToken(token) }, { token }], isActive: true });
/** Sessions idle longer than this are ended even inside their 24h life. */
const IDLE_MS = Math.max(1, Number(process.env.ADMIN_SESSION_IDLE_HOURS) || 8) * 60 * 60 * 1000;

/*
 * Sliding expiry for guest sessions.
 *
 * A guest session was a hard 7 days with no renewal of any kind, so somebody
 * who had been signed in for a week got a silent 401 wherever they happened to
 * be — mid-checkout, mid-booking — and had to go and ask for an OTP. An app
 * that is in use every other day should never be logged out.
 *
 * How it works: once a session is past the halfway point of its own life, the
 * next authenticated call mints a FRESH token with a full life and returns it
 * in a response header. A client that stores the header keeps rolling forward;
 * a client that ignores it is affected in no way at all — its bearer keeps
 * working to exactly the same second it would have before.
 *
 * Two details that are easy to get wrong:
 *
 *  - The new token gets its OWN Token row. It cannot replace the old row's
 *    value, because the old bearer must stay usable for clients that ignore
 *    the header. Extending the old row's `expiresAt` on its own would achieve
 *    nothing: the JWT's own `exp` claim is what jwt.verify enforces, and that
 *    is not editable after signing.
 *  - The new token carries `prev`, the id of the row it supersedes. The first
 *    time the client actually presents the new token the old row is revoked,
 *    so a rolling session does not accumulate rows in "Active sessions".
 *
 * This is deliberately NOT refresh-token rotation: no second credential, no
 * new endpoint, nothing for the app to orchestrate.
 */
const SESSION_TOKEN_HEADER = 'X-Session-Token';
const SESSION_EXPIRES_HEADER = 'X-Session-Expires';
/** Never mint more than one replacement per session per this window. */
const RENEW_THROTTLE_MS = 15 * 60 * 1000;
const renewAttemptedAt = new Map();

const renewThrottled = (key) => {
  const now = Date.now();
  const at = renewAttemptedAt.get(key);
  if (at && now - at < RENEW_THROTTLE_MS) return true;
  renewAttemptedAt.set(key, now);
  // Bounded: a busy server must not hold a row per session it has ever seen.
  if (renewAttemptedAt.size > 5000) {
    for (const [k, t] of renewAttemptedAt) {
      if (now - t > RENEW_THROTTLE_MS) renewAttemptedAt.delete(k);
    }
  }
  return false;
};

/** Retire the row a rolling session has just moved off. Best-effort. */
const retireSupersededSession = (prevId, currentId) => {
  if (!prevId || String(prevId) === String(currentId)) return;
  Token.updateOne({ _id: prevId, isActive: true }, { $set: { isActive: false } }).catch(() => {});
};

/**
 * Hand the caller a fresh token when this one is past half its life.
 *
 * Never throws and never blocks the request: a session that could not be
 * renewed simply keeps the token it has.
 */
const slideSession = async (req, res, tokenDoc, decoded) => {
  try {
    const endsAt = new Date(tokenDoc.expiresAt).getTime();
    const startedAt = new Date(tokenDoc.createdAt || tokenDoc.lastUsedAt || Date.now()).getTime();
    const lifespan = endsAt - startedAt;
    if (!Number.isFinite(lifespan) || lifespan <= 0) return;
    if (Date.now() - startedAt < lifespan / 2) return;
    if (renewThrottled(String(tokenDoc._id))) return;

    const token = jwt.sign(
      { userId: String(decoded.userId), email: decoded.email, prev: String(tokenDoc._id) },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );
    const expiresAt = new Date(jwt.decode(token).exp * 1000);

    await Token.create({
      userId: tokenDoc.userId,
      userType: tokenDoc.userType || 'User',
      token,
      type: tokenDoc.type || 'access',
      deviceInfo: tokenDoc.deviceInfo,
      ipAddress: req.ip || req.connection?.remoteAddress || tokenDoc.ipAddress,
      expiresAt,
      isActive: true,
    });

    res.setHeader(SESSION_TOKEN_HEADER, token);
    res.setHeader(SESSION_EXPIRES_HEADER, expiresAt.toISOString());
    // Expo web reads these through CORS, where a response header is invisible
    // unless it is named here.
    const exposed = String(res.getHeader('Access-Control-Expose-Headers') || '')
      .split(',').map((h) => h.trim()).filter(Boolean);
    for (const name of [SESSION_TOKEN_HEADER, SESSION_EXPIRES_HEADER]) {
      if (!exposed.some((h) => h.toLowerCase() === name.toLowerCase())) exposed.push(name);
    }
    res.setHeader('Access-Control-Expose-Headers', exposed.join(', '));
  } catch (error) {
    console.error('Session renewal skipped:', error.message);
  }
};
const User = require('../models/User');
const Admin = require('../models/Admin');
const AdminAuditLog = require('../models/AdminAuditLog');
const Role = require('../models/Role');
const { sanitizePermissions, baselinePermissions } = require('../config/permissions');

/**
 * Resolve a staff account's effective permission set.
 *
 * super_admin implicitly holds everything, so callers should short-circuit on
 * `isSuperAdmin` rather than enumerating. For everyone else the set is the union
 * of three things: the baseline their built-in role carries, their assigned
 * custom role's permissions, and any direct grants on the account — with stale
 * keys dropped.
 *
 * The baseline matters for doctor/therapist accounts. They never get a custom
 * role, but the dermatologist and floor panels call the same gated endpoints as
 * the admin panel, so an empty set would 403 them out of their own panel.
 *
 * Returns { isSuperAdmin, permissions: Set<string>, roleKey, roleName }.
 */
async function computeEffectivePermissions(admin) {
  if (!admin) return { isSuperAdmin: false, permissions: new Set(), roleKey: null, roleName: null };
  if (admin.role === 'super_admin') {
    return { isSuperAdmin: true, permissions: new Set(), roleKey: 'super_admin', roleName: 'Super admin' };
  }
  const perms = new Set(sanitizePermissions(baselinePermissions(admin.role)));
  for (const p of sanitizePermissions(admin.permissions)) perms.add(p);
  let roleKey = null;
  let roleName = null;
  if (admin.customRoleId) {
    const role = await Role.findById(admin.customRoleId).lean();
    if (role && role.isActive !== false) {
      roleKey = role.key;
      roleName = role.name;
      for (const p of sanitizePermissions(role.permissions)) perms.add(p);
    }
  }
  /*
   * Per-centre assignments ("receptionist at JH, manager at Kondapur").
   * Route gates stay organisation-wide (the union), because a request rarely
   * names its centre; `permissionsByBranch` lets the panel and any
   * centre-aware handler narrow to the centre in hand. Only assignments whose
   * window covers today count — a deputation that has ended grants nothing.
   */
  const now = new Date();
  const current = (admin.assignments || []).filter((a) => a && a.branchId
    && !(a.from && new Date(a.from) > now) && !(a.to && new Date(a.to) < now));
  const permissionsByBranch = {};
  const assignments = [];
  if (current.length) {
    const roleIds = [...new Set(current.map((a) => String(a.roleId || '')).filter(Boolean))];
    const roles = roleIds.length ? await Role.find({ _id: { $in: roleIds }, isActive: { $ne: false } }).lean() : [];
    const byId = new Map(roles.map((r) => [String(r._id), r]));
    for (const a of current) {
      const role = a.roleId ? byId.get(String(a.roleId)) : null;
      const keys = role ? sanitizePermissions(role.permissions) : [];
      const b = String(a.branchId);
      permissionsByBranch[b] = [...new Set([...(permissionsByBranch[b] || []), ...keys])];
      for (const p of keys) perms.add(p);
      assignments.push({ branchId: b, roleId: a.roleId ? String(a.roleId) : null, roleName: role ? role.name : null, roleKey: role ? role.key : null, kind: a.kind || 'primary', from: a.from || null, to: a.to || null });
    }
  }
  return { isSuperAdmin: false, permissions: perms, roleKey, roleName, permissionsByBranch, assignments };
}
exports.computeEffectivePermissions = computeEffectivePermissions;

// Protect routes - verify JWT token
exports.protect = async (req, res, next) => {
  try {
    let token;

    // Check if token exists in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized. Please login to access this resource.'
      });
    }

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Check if token exists and is valid in database
      const tokenDoc = await findSession(token);
      
      if (!tokenDoc) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }

      // Check if token has expired
      if (!tokenDoc.isValid()) {
        await tokenDoc.revoke();
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }

      // Check if user account still exists and is active (fetch full user data)
      const user = await User.findById(decoded.userId).select('-password -otp -otpExpires');
      
      if (!user) {
        // User account deleted - revoke all tokens
        await Token.revokeAllUserTokens(decoded.userId);
        return res.status(401).json({
          success: false,
          message: 'Account not found. Please contact support.',
          code: 'ACCOUNT_DELETED'
        });
      }

      if (!user.isActive) {
        // Account deactivated - revoke all tokens
        await Token.revokeAllUserTokens(decoded.userId);
        return res.status(401).json({
          success: false,
          message: 'Your account has been deactivated. Please contact support.',
          code: 'ACCOUNT_DEACTIVATED'
        });
      }

      // Update last used time
      tokenDoc.lastUsedAt = Date.now();
      await tokenDoc.save();

      // Sliding expiry: retire the row this session rolled off, and hand back a
      // fresh token if this one is past half its life.
      if (decoded.prev) retireSupersededSession(decoded.prev, tokenDoc._id);
      await slideSession(req, res, tokenDoc, decoded);

      // Convert Mongoose document to plain object and add to request
      req.user = {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        location: user.location,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        memberType: user.memberType || 'Regular Member',
        zenMembershipStartDate: user.zenMembershipStartDate,
        zenMembershipExpiryDate: user.zenMembershipExpiryDate,
        zenMembershipAutoRenew: user.zenMembershipAutoRenew,
        profilePicture: user.profilePicture,
        isVerified: user.isVerified,
        isActive: user.isActive,
        createdAt: user.createdAt
      };
      req.tokenId = tokenDoc._id;
      
      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }
      
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please login again.'
      });
    }
  } catch (error) {
    console.error('❌ Authentication error');
    res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

// Protect admin routes - verify admin JWT token
/**
 * Identify a staff caller on a PUBLIC route without ever rejecting.
 *
 * Some listings are read by both the app (anonymous) and the panel (staff),
 * and the staff view is allowed to carry fields the app must not see. This
 * sets `req.admin` when a valid, active staff token is present and otherwise
 * leaves it undefined. It never answers 401/403 — that is protectAdmin's job.
 */
exports.identifyAdmin = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer')) return next();
    const token = header.split(' ')[1];
    if (!token) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const isAdminToken = decoded.type === 'admin' || !!decoded.adminId;
    if (!isAdminToken) return next();
    const admin = await Admin.findById(decoded.adminId).lean();
    if (admin && admin.isActive) {
      req.admin = { _id: admin._id, email: admin.email, name: admin.name, role: admin.role };
    }
  } catch (_) {
    // A bad or expired token on a public route is simply an anonymous call.
  }
  return next();
};

exports.protectAdmin = async (req, res, next) => {
  try {
    let token;

    // Check if token exists in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized. Admin access required.'
      });
    }

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Is this a staff token at all?
      //
      // This used to test `decoded.role !== 'admin'`, which conflated two
      // different things: `type` says the token belongs to a staff account,
      // `role` says what that account is allowed to do. Because the payload
      // carries the account's real role, any account that was not literally
      // an 'admin' — super_admin, doctor, therapist — was
      // refused at the door and could never sign in. Per-role permissions are
      // enforced by requireRole() further down each route.
      const isAdminToken = decoded.type === 'admin' || !!decoded.adminId;
      if (!isAdminToken) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. Staff privileges required.'
        });
      }

      // The JWT alone is not the session — the Token row is. Without this
      // check, sign-out and password resets could never actually end a
      // session: a copied bearer token would keep working until the JWT
      // expired on its own.
      const tokenDoc = await findSession(token);
      if (!tokenDoc) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }
      if (!tokenDoc.isValid()) {
        await tokenDoc.revoke();
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }
      // Idle limit: a panel left open on an unattended desk closes itself.
      const lastUsed = tokenDoc.lastUsedAt ? new Date(tokenDoc.lastUsedAt).getTime() : new Date(tokenDoc.createdAt).getTime();
      if (Date.now() - lastUsed > IDLE_MS) {
        await tokenDoc.revoke();
        return res.status(401).json({
          success: false,
          message: 'You were signed out after a period of inactivity. Please sign in again.',
          code: 'SESSION_EXPIRED'
        });
      }
      // Touch at most once a minute — a busy panel must not write on every call.
      if (Date.now() - lastUsed > 60 * 1000) {
        Token.updateOne({ _id: tokenDoc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
      }

      // Check if admin account still exists and is active
      const admin = await Admin.findById(decoded.adminId);
      
      if (!admin) {
        return res.status(401).json({
          success: false,
          message: 'Admin account not found.',
          code: 'ACCOUNT_DELETED'
        });
      }
      // "Sign out everywhere" / deactivation moved the version on: refuse.
      if (decoded.sv !== undefined && Number(decoded.sv) !== Number(admin.sessionVersion || 1)) {
        await tokenDoc.revoke();
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }

      if (!admin.isActive) {
        return res.status(401).json({
          success: false,
          message: 'Your admin account has been deactivated.',
          code: 'ACCOUNT_DEACTIVATED'
        });
      }

      // Update last login
      admin.lastLogin = Date.now();
      await admin.save();

      // Resolve the account's effective admin-panel permissions once per
      // request so requirePermission() and controllers can consult them without
      // re-querying. super_admin short-circuits to "everything".
      const eff = await computeEffectivePermissions(admin);

      // Add admin info to request
      req.admin = {
        _id: admin._id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        isActive: admin.isActive,
        isSuperAdmin: eff.isSuperAdmin,
        permissions: eff.permissions,     // Set<string>
        roleKey: eff.roleKey,
        roleName: eff.roleName,
      };

      // Extract IP and user agent for audit logging
      req.adminIp = req.ip || req.connection.remoteAddress;
      req.adminUserAgent = req.get('user-agent');

      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }

      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please login again.'
      });
    }
  } catch (error) {
    console.error('❌ Admin authentication error:', error);
    res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

// Role-based access control middleware
exports.requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          message: 'Admin authentication required'
        });
      }

      if (!allowedRoles.includes(req.admin.role)) {
        // Log unauthorized access attempt
        await AdminAuditLog.logAction({
          adminId: req.admin._id,
          adminEmail: req.admin.email,
          action: 'PERMISSION_DENIED',
          resource: 'SECURITY',
          details: {
            attemptedRole: req.admin.role,
            requiredRoles: allowedRoles,
            endpoint: req.originalUrl,
            method: req.method
          },
          ipAddress: req.adminIp || req.ip,
          userAgent: req.adminUserAgent,
          status: 'FAILED',
          errorMessage: `Role '${req.admin.role}' not authorized for this operation`
        });

        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions. This action requires elevated privileges.',
          requiredRole: allowedRoles
        });
      }

      next();
    } catch (error) {
      console.error('❌ Role verification error:', error);
      res.status(500).json({
        success: false,
        message: 'Permission verification failed'
      });
    }
  };
};

/**
 * Permission-based access control — the granular successor to requireRole.
 *
 * Pass one or more permission keys; the caller passes if they are a super_admin
 * or hold ANY of them (OR semantics, matching requireRole). Use it to gate a
 * mutation on its `.manage` key, e.g. requirePermission('bookings.manage').
 * Denials are audited exactly like requireRole so the security log is uniform.
 *
 * Requires protectAdmin to have run first (it populates req.admin.permissions).
 */
exports.requirePermission = (...needed) => {
  const required = needed.flat().map((p) => String(p).trim()).filter(Boolean);
  return async (req, res, next) => {
    try {
      if (!req.admin) {
        return res.status(401).json({ success: false, message: 'Admin authentication required' });
      }
      const perms = req.admin.permissions instanceof Set ? req.admin.permissions : new Set();
      const allowed = req.admin.isSuperAdmin || required.some((p) => perms.has(p));
      if (!allowed) {
        await AdminAuditLog.logAction({
          adminId: req.admin._id,
          adminEmail: req.admin.email,
          action: 'PERMISSION_DENIED',
          resource: 'SECURITY',
          details: {
            required,
            held: Array.from(perms),
            role: req.admin.role,
            roleKey: req.admin.roleKey || null,
            endpoint: req.originalUrl,
            method: req.method,
          },
          ipAddress: req.adminIp || req.ip,
          userAgent: req.adminUserAgent,
          status: 'FAILED',
          errorMessage: `Missing permission (${required.join(' or ')})`,
        }).catch(() => undefined);
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to perform this action.',
          requiredPermission: required,
        });
      }
      next();
    } catch (error) {
      console.error('❌ Permission verification error:', error);
      res.status(500).json({ success: false, message: 'Permission verification failed' });
    }
  };
};

/**
 * Role-OR-permission gate, for the handful of endpoints that serve two kinds of
 * caller: an admin-panel account acting on the permission, and a built-in role
 * acting on itself (a dermatologist editing their own profile, say, where the
 * controller then enforces ownership). Pass `{ permissions, roles }`; the caller
 * passes if they are a super_admin, hold ANY listed permission, or sit in ANY
 * listed role. Denials are audited exactly like requirePermission.
 */
exports.requireAccess = ({ permissions = [], roles = [] } = {}) => {
  const needPerms = [].concat(permissions).map((p) => String(p).trim()).filter(Boolean);
  const needRoles = [].concat(roles).map((r) => String(r).trim()).filter(Boolean);
  return async (req, res, next) => {
    try {
      if (!req.admin) {
        return res.status(401).json({ success: false, message: 'Admin authentication required' });
      }
      const perms = req.admin.permissions instanceof Set ? req.admin.permissions : new Set();
      const allowed = req.admin.isSuperAdmin
        || needRoles.includes(req.admin.role)
        || needPerms.some((p) => perms.has(p));
      if (!allowed) {
        await AdminAuditLog.logAction({
          adminId: req.admin._id,
          adminEmail: req.admin.email,
          action: 'PERMISSION_DENIED',
          resource: 'SECURITY',
          details: {
            required: needPerms,
            requiredRoles: needRoles,
            held: Array.from(perms),
            role: req.admin.role,
            roleKey: req.admin.roleKey || null,
            endpoint: req.originalUrl,
            method: req.method,
          },
          ipAddress: req.adminIp || req.ip,
          userAgent: req.adminUserAgent,
          status: 'FAILED',
          errorMessage: `Missing permission (${needPerms.join(' or ') || 'n/a'})`,
        }).catch(() => undefined);
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to perform this action.',
          requiredPermission: needPerms,
        });
      }
      next();
    } catch (error) {
      console.error('❌ Access verification error:', error);
      res.status(500).json({ success: false, message: 'Permission verification failed' });
    }
  };
};

// Audit logging middleware - logs all admin actions
exports.auditLog = (action, resource) => {
  return async (req, res, next) => {
    // Store original res.json to intercept response
    const originalJson = res.json.bind(res);
    
    res.json = function(data) {
      // Log action after response
      setImmediate(async () => {
        try {
          if (req.admin) {
            const status = res.statusCode >= 200 && res.statusCode < 300 ? 'SUCCESS' : 'FAILED';
            
            await AdminAuditLog.logAction({
              adminId: req.admin._id,
              adminEmail: req.admin.email,
              action,
              resource,
              resourceId: req.params.id || req.body.id || null,
              details: {
                endpoint: req.originalUrl,
                method: req.method,
                body: sanitizeLogData(req.body),
                query: req.query
              },
              ipAddress: req.adminIp || req.ip,
              userAgent: req.adminUserAgent,
              status,
              errorMessage: status === 'FAILED' ? data.message : null
            });
          }
        } catch (error) {
          console.error('❌ Audit logging error:', error);
        }
      });
      
      return originalJson(data);
    };
    
    next();
  };
};

// Protect routes - allow both user and admin
exports.protectBoth = async (req, res, next) => {
  try {
    let token;

    // Check if token exists in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized. Please login to access this resource.'
      });
    }

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Check if it's a staff token — see the note in protectAdmin about why
      // this keys off `type`/`adminId` rather than the account's role.
      if ((decoded.type === 'admin' || decoded.role === 'admin') && decoded.adminId) {
        const admin = await Admin.findById(decoded.adminId);
        
        if (!admin) {
          return res.status(401).json({
            success: false,
            message: 'Admin account not found.',
            code: 'ACCOUNT_DELETED'
          });
        }

        if (!admin.isActive) {
          return res.status(401).json({
            success: false,
            message: 'Your admin account has been deactivated.',
            code: 'ACCOUNT_DEACTIVATED'
          });
        }

        // Update last login
        admin.lastLogin = Date.now();
        await admin.save();

        // Add admin info to request
        req.admin = {
          _id: admin._id,
          email: admin.email,
          name: admin.name,
          role: admin.role,
          isActive: admin.isActive
        };
        
        // Extract IP and user agent for audit logging
        req.adminIp = req.ip || req.connection.remoteAddress;
        req.adminUserAgent = req.get('user-agent');
        
        return next();
      }
      
      // Otherwise, treat as user token
      if (decoded.userId) {
        // Check if token exists and is valid in database
        const tokenDoc = await findSession(token);
        
        if (!tokenDoc) {
          return res.status(401).json({
            success: false,
            message: 'Session expired. Please login again.',
            code: 'SESSION_EXPIRED'
          });
        }

        // Check if token has expired
        if (!tokenDoc.isValid()) {
          await tokenDoc.revoke();
          return res.status(401).json({
            success: false,
            message: 'Session expired. Please login again.',
            code: 'SESSION_EXPIRED'
          });
        }

        // Check if user account still exists and is active
        const user = await User.findById(decoded.userId).select('-password -otp -otpExpires');
        
        if (!user) {
          await Token.revokeAllUserTokens(decoded.userId);
          return res.status(401).json({
            success: false,
            message: 'Account not found. Please contact support.',
            code: 'ACCOUNT_DELETED'
          });
        }

        if (!user.isActive) {
          await Token.revokeAllUserTokens(decoded.userId);
          return res.status(401).json({
            success: false,
            message: 'Your account has been deactivated. Please contact support.',
            code: 'ACCOUNT_DEACTIVATED'
          });
        }

        // Update last used time
        tokenDoc.lastUsedAt = Date.now();
        await tokenDoc.save();

        // Sliding expiry — same contract as protect(), so a guest whose app
        // happens to hit only these routes still rolls forward.
        if (decoded.prev) retireSupersededSession(decoded.prev, tokenDoc._id);
        await slideSession(req, res, tokenDoc, decoded);

        // Add user to request
        req.user = {
          _id: user._id,
          email: user.email,
          fullName: user.fullName,
          phone: user.phone,
          location: user.location,
          dateOfBirth: user.dateOfBirth,
          gender: user.gender,
          memberType: user.memberType || 'Regular Member',
          zenMembershipStartDate: user.zenMembershipStartDate,
          zenMembershipExpiryDate: user.zenMembershipExpiryDate,
          zenMembershipAutoRenew: user.zenMembershipAutoRenew,
          profilePicture: user.profilePicture,
          isVerified: user.isVerified,
          isActive: user.isActive,
          createdAt: user.createdAt
        };
        req.tokenId = tokenDoc._id;
        
        return next();
      }
      
      // If neither user nor admin token
      return res.status(401).json({
        success: false,
        message: 'Invalid token format.'
      });
      
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }
      
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please login again.'
      });
    }
  } catch (error) {
    console.error('❌ Authentication error');
    res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

// Optional auth - allows both authenticated and guest access
// If token is present and valid, populate req.user; otherwise continue as guest
exports.optionalAuth = async (req, res, next) => {
  try {
    let token;

    // Check if token exists in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    // If no token, continue as guest
    if (!token) {
      req.user = null;
      req.isGuest = true;
      return next();
    }

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Check if token exists and is valid in database
      const tokenDoc = await findSession(token);
      
      if (!tokenDoc || !tokenDoc.isValid()) {
        // Invalid token - continue as guest
        req.user = null;
        req.isGuest = true;
        return next();
      }

      // Check if user account still exists and is active
      const user = await User.findById(decoded.userId).select('-password -otp -otpExpires');
      
      if (!user || !user.isActive) {
        // User not found or inactive - continue as guest
        req.user = null;
        req.isGuest = true;
        return next();
      }

      // Update last used time
      tokenDoc.lastUsedAt = Date.now();
      await tokenDoc.save();
      
      // Add authenticated user to request
      req.user = {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        location: user.location,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        memberType: user.memberType || 'Regular Member',
        zenMembershipStartDate: user.zenMembershipStartDate,
        zenMembershipExpiryDate: user.zenMembershipExpiryDate,
        zenMembershipAutoRenew: user.zenMembershipAutoRenew,
        profilePicture: user.profilePicture,
        isVerified: user.isVerified,
        isActive: user.isActive,
        createdAt: user.createdAt
      };
      req.tokenId = tokenDoc._id;
      req.isGuest = false;
      
      next();
    } catch (error) {
      // Token verification failed - continue as guest
      req.user = null;
      req.isGuest = true;
      next();
    }
  } catch (error) {
    console.error('❌ Optional authentication error');
    // On error, continue as guest
    req.user = null;
    req.isGuest = true;
    next();
  }
};

// Helper to sanitize sensitive data from logs
function sanitizeLogData(data) {
  if (!data || typeof data !== 'object') return data;
  
  const sanitized = { ...data };
  const sensitiveFields = ['password', 'otp', 'token', 'secret', 'apiKey'];
  
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });
  
  return sanitized;
}
