// Quick test to verify auth middleware exports
const auth = require('./middleware/auth');

console.log('Auth module:', auth);
console.log('protectAdmin exists?', typeof auth.protectAdmin);
console.log('protect exists?', typeof auth.protect);

if (typeof auth.protectAdmin === 'function') {
  console.log('✅ protectAdmin is a function - middleware is correctly exported');
} else {
  console.log('❌ protectAdmin is NOT a function - there is an export issue');
}
