const Product = require('../models/Product');
const Branch = require('../models/Branch');
const { visibleAtFilter, presentForCentre, resolveListing } = require('../utils/productCentre');
const taxonomy = require('../utils/productTaxonomy');

/*
 * What a guest's phone is never sent. The shop used to return the whole
 * document, which put the buying price and the supplier on a public endpoint.
 * LIST_HIDDEN also leaves out the long-form product page: the shop loads the
 * whole catalogue at once and only the product screen reads `details`.
 */
const PUBLIC_HIDDEN = [
  'buyingPrice', 'vendorName', 'vendorId', 'reorderLevel', 'targetLevel', 'templateStatus',
  'batchTracking', 'consumptionOrder', 'branchStock', 'centres', 'barcodes',
  'zenotiProductId', 'zenotiCategoryId', 'zenotiSubCategoryId', 'zenotiSyncedAt',
  'stockSource', 'stockUpdatedAt', 'priceSource', 'rxSource', 'catalogueSource', '__v',
];
const DETAIL_SELECT = PUBLIC_HIDDEN.map((f) => `-${f}`).join(' ');
const LIST_SELECT = `${DETAIL_SELECT} -details`;

/** The shop's own filters — collection, category, concern, brand — as a Mongo clause. */
function shopFilters(q) {
  const and = [];
  const collection = taxonomy.normaliseCollections(q.collection)[0];
  if (q.collection && q.collection !== 'all') and.push(collection ? { shopCollections: collection } : { _id: null });
  if (q.category && q.category !== 'All') and.push(taxonomy.categoryFilter(q.category));
  if (q.concern) {
    const concern = taxonomy.normaliseConcerns(q.concern)[0];
    and.push(concern ? { concerns: concern } : { _id: null });
  }
  if (q.brand) {
    const rx = new RegExp(`^${String(q.brand).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    and.push({ $or: [{ brand: rx }, { OrgName: rx }] });
  }
  return and;
}

/*
 * Which centre the guest is shopping at.
 *
 * The app sends `branchId` (a Branch id) or `centre` (the centre's name, as
 * the app stores the guest's selected centre by name). Either resolves to an
 * active clinic; anything else — no centre, a pharmacy, an unknown name —
 * means "no centre", and the shop reads as it always did: every product,
 * base prices. Cached for a minute: three centres, read on every list call.
 */
let centreCache = { at: 0, byId: new Map(), byName: new Map() };
async function shoppingCentre(req) {
  const q = req.query || {};
  const wantId = typeof q.branchId === 'string' && /^[0-9a-f]{24}$/i.test(q.branchId) ? q.branchId.toLowerCase() : null;
  const wantName = typeof q.centre === 'string' ? q.centre.trim().toLowerCase() : '';
  if (!wantId && !wantName) return null;
  if (Date.now() - centreCache.at > 60 * 1000) {
    const rows = await Branch.find({ isActive: true, centreType: { $in: ['clinic', null] }, isPharmacy: { $ne: true } }).select('name').lean().catch(() => []);
    centreCache = {
      at: Date.now(),
      byId: new Map(rows.map((b) => [String(b._id).toLowerCase(), b])),
      byName: new Map(rows.map((b) => [String(b.name).trim().toLowerCase(), b])),
    };
  }
  return (wantId && centreCache.byId.get(wantId)) || (wantName && centreCache.byName.get(wantName)) || null;
}
const forCentre = (products, centre) => products.map((p) => presentForCentre(p, centre ? centre._id : null));

// @desc    Get all products
// @route   GET /api/products?branchId=|centre=
// @access  Public
exports.getAllProducts = async (req, res) => {
  try {
    const { formulation, search, minPrice, maxPrice, sort, isPopular } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(0, parseInt(req.query.limit, 10) || 0)); // 0 = the whole list, as before

    /*
     * The app shop sells RETAIL stock only. Consumables (needles, device
     * supplies) belong to the treatment room and are mirrored from Zenoti with
     * isRetail false — they must never reach a guest's product list even if
     * someone activates one by accident. Prescription items DO appear (with
     * their description) but cannot be ordered; utils/orderPricing refuses
     * them at checkout.
     */
    const centre = await shoppingCentre(req);
    const query = { isActive: true, isAppProduct: true, ...visibleAtFilter(centre ? centre._id : null) };
    
    if (formulation && formulation !== 'All') {
      query.formulation = formulation;
    }
    
    if (search) {
      query.$text = { $search: search };
    }
    
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }
    
    if (isPopular === 'true') {
      query.isPopular = true;
    }

    const shop = shopFilters(req.query);
    if (shop.length) query.$and = [...(query.$and || []), ...shop];

    // Build sort
    let sortOption = {};
    switch (sort) {
      case 'price_asc':
        sortOption = { price: 1 };
        break;
      case 'price_desc':
        sortOption = { price: -1 };
        break;
      case 'rating':
        sortOption = { rating: -1 };
        break;
      case 'popular':
        sortOption = { isPopular: -1, reviews: -1, name: 1 };
        break;
      case 'name':
        sortOption = { name: 1 };
        break;
      case 'newest':
        sortOption = { createdAt: -1, name: 1 };
        break;
      default:
        // A whole catalogue loaded in one go shares a creation time, so "newest
        // first" alone is no order at all: bestsellers lead, then A to Z.
        sortOption = { isPopular: -1, name: 1 };
    }

    let find = Product.find(query).select(LIST_SELECT).sort(sortOption).collation({ locale: 'en', strength: 2 });
    if (limit) find = find.skip((page - 1) * limit).limit(limit);
    const [products, total] = await Promise.all([find, limit ? Product.countDocuments(query) : null]);

    res.json({
      success: true,
      data: forCentre(products, centre),
      centre: centre ? { _id: centre._id, name: centre.name } : null,
      ...(limit ? { pagination: { page, limit, total, pages: Math.ceil(total / limit) } } : {}),
    });
  } catch (error) {
    console.error('Get all products error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.message
    });
  }
};

// @desc    Get single product by ID
// @route   GET /api/products/:id
// @access  Public
exports.getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate MongoDB ObjectId
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    
    const product = await Product.findById(id).select(DETAIL_SELECT);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    // The detail page is reached from a list the centre already filtered, but a
    // shared link or a stale cart can ask for a product hidden at the guest's
    // centre. It is still returned — with the centre's price and a flag — so
    // the app can show it and say it is not on sale here, rather than 404.
    const centre = await shoppingCentre(req);
    const presented = presentForCentre(product, centre ? centre._id : null);
    const listing = resolveListing(product, centre ? centre._id : null);
    // Named, not slugged: the product screen prints these as chips.
    const concernLabels = (presented.concerns || []).map((slug) => taxonomy.CONCERN_BY_SLUG.get(slug)).filter(Boolean).map((c) => ({ slug: c.slug, name: c.name }));
    res.json({
      success: true,
      data: { ...presented, concernLabels, availableAtCentre: centre ? listing.visible : true },
      centre: centre ? { _id: centre._id, name: centre.name } : null,
    });
  } catch (error) {
    console.error('Get product by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product',
      error: error.message
    });
  }
};

// @desc    Get products by formulation
// @route   GET /api/products/formulation/:formulation
// @access  Public
exports.getProductsByFormulation = async (req, res) => {
  try {
    const { formulation } = req.params;
    const { limit } = req.query;
    
    const centre = await shoppingCentre(req);
    const query = { formulation, isActive: true, isAppProduct: true, ...visibleAtFilter(centre ? centre._id : null) };
    
    let productsQuery = Product.find(query).select(LIST_SELECT).sort({ isPopular: -1, name: 1 });
    
    if (limit) {
      productsQuery = productsQuery.limit(parseInt(limit));
    }
    
    const products = await productsQuery;
    
    res.json({
      success: true,
      data: forCentre(products, centre),
      count: products.length
    });
  } catch (error) {
    console.error('Get products by formulation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.message
    });
  }
};

// @desc    Search products
// @route   GET /api/products/search/:query
// @access  Public
exports.searchProducts = async (req, res) => {
  try {
    const { query } = req.params;
    const { limit } = req.query;
    
    const centre = await shoppingCentre(req);
    const searchQuery = {
      isActive: true,
      isAppProduct: true,
      ...visibleAtFilter(centre ? centre._id : null),
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { description: { $regex: query, $options: 'i' } },
        { OrgName: { $regex: query, $options: 'i' } },
        { formulation: { $regex: query, $options: 'i' } },
        { brand: { $regex: query, $options: 'i' } },
        { categories: { $regex: query, $options: 'i' } },
        { shortDescription: { $regex: query, $options: 'i' } },
        { 'details.keyIngredients': { $regex: query, $options: 'i' } }
      ]
    };
    
    let productsQuery = Product.find(searchQuery).select(LIST_SELECT).sort({ isPopular: -1, name: 1 });
    
    if (limit) {
      productsQuery = productsQuery.limit(parseInt(limit));
    }
    
    const products = await productsQuery;
    
    res.json({
      success: true,
      data: forCentre(products, centre),
      count: products.length
    });
  } catch (error) {
    console.error('Search products error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search products',
      error: error.message
    });
  }
};

// @desc    Get all formulations
// @route   GET /api/products/formulations/list
// @access  Public
exports.getFormulations = async (req, res) => {
  try {
    const formulations = await Product.distinct('formulation', { isActive: true });
    
    res.json({
      success: true,
      data: formulations
    });
  } catch (error) {
    console.error('Get formulations error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch formulations',
      error: error.message
    });
  }
};


// @desc    Catalogue categories → sub-categories with counts (what the shop shows as tabs/chips)
// @route   GET /api/products/categories/list
exports.getCategories = async (req, res) => {
  try {
    const centre = await shoppingCentre(req);
    const rows = await Product.aggregate([
      { $match: { isActive: true, isAppProduct: true, ...visibleAtFilter(centre ? centre._id : null) } },
      { $group: { _id: { c: { $ifNull: ['$productCategory', 'Other'] }, s: '$productSubCategory' }, n: { $sum: 1 } } },
      { $group: { _id: '$_id.c', count: { $sum: '$n' }, subs: { $push: { name: '$_id.s', count: '$n' } } } },
      { $sort: { count: -1, _id: 1 } },
    ]);
    res.json({
      success: true,
      data: rows.map((r) => ({
        name: r._id,
        count: r.count,
        subCategories: r.subs.filter((x) => x.name).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      })),
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch categories', error: error.message });
  }
};

// @desc    The shop's landing page in one call: collections, categories and concerns, each with how many products it holds here
// @route   GET /api/products/taxonomy?branchId=|centre=
// @access  Public
exports.getTaxonomy = async (req, res) => {
  try {
    const centre = await shoppingCentre(req);
    const match = { isActive: true, isAppProduct: true, ...visibleAtFilter(centre ? centre._id : null) };
    const [counts, brands] = await Promise.all([
      taxonomy.countTaxonomy(Product, match),
      Product.aggregate([
        { $match: match },
        { $group: { _id: { $ifNull: ['$brand', '$OrgName'] }, count: { $sum: 1 } } },
        { $match: { _id: { $nin: [null, ''] } } },
        { $sort: { count: -1, _id: 1 } },
      ]),
    ]);
    res.json({
      success: true,
      data: { ...taxonomy.present(counts), brands: brands.map((b) => ({ name: b._id, count: b.count })) },
      centre: centre ? { _id: centre._id, name: centre.name } : null,
    });
  } catch (error) {
    console.error('Get taxonomy error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch the shop menu', error: error.message });
  }
};

// @desc    Check stock availability
// @route   POST /api/products/check-stock
// @access  Public
exports.checkStock = async (req, res) => {
  try {
    const { items } = req.body; // Array of { productId, quantity }
    
    const stockStatus = [];
    let allAvailable = true;
    
    for (const item of items) {
      const product = await Product.findById(item.productId);
      
      if (!product) {
        stockStatus.push({
          productId: item.productId,
          available: false,
          reason: 'Product not found'
        });
        allAvailable = false;
        continue;
      }
      
      if (!product.isActive) {
        stockStatus.push({
          productId: item.productId,
          productName: product.name,
          available: false,
          reason: 'Product is not available'
        });
        allAvailable = false;
        continue;
      }
      
      // A product whose stock is not counted is always available.
      if (product.trackStock !== false && product.stock < item.quantity) {
        stockStatus.push({
          productId: item.productId,
          productName: product.name,
          available: false,
          reason: 'Insufficient stock',
          requestedQuantity: item.quantity
        });
        allAvailable = false;
        continue;
      }

      // Whether, never how many: the count is the clinic's business.
      stockStatus.push({
        productId: item.productId,
        productName: product.name,
        available: true
      });
    }
    
    res.json({
      success: true,
      allAvailable,
      stockStatus
    });
  } catch (error) {
    console.error('Check stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check stock',
      error: error.message
    });
  }
};
