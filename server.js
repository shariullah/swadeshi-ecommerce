const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const Razorpay = require('razorpay');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// Ensure avatars directory exists
if (!fs.existsSync('./uploads/avatars')) {
    fs.mkdirSync('./uploads/avatars', { recursive: true });
}

// ============ SQLite DATABASE SETUP (better-sqlite3) ============
const dbPath = process.env.RAILWAY_ENV ? '/tmp/swadeshi.db' : './swadeshi.db';
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        description TEXT,
        price REAL,
        category TEXT,
        images TEXT,
        stock INTEGER DEFAULT 0,
        isFeatured INTEGER DEFAULT 0,
        isFinest INTEGER DEFAULT 0,
        region TEXT DEFAULT '',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        isAdmin INTEGER DEFAULT 0,
        wishlist TEXT DEFAULT '[]',
        phone TEXT DEFAULT '',
        address TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE,
        description TEXT,
        discountType TEXT DEFAULT 'percentage',
        discountValue REAL,
        minOrderAmount REAL DEFAULT 0,
        maxDiscount REAL,
        validFrom DATETIME,
        validTo DATETIME,
        usageLimit INTEGER DEFAULT 0,
        usedCount INTEGER DEFAULT 0,
        isActive INTEGER DEFAULT 1,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        type TEXT,
        name TEXT,
        phone TEXT,
        street TEXT,
        city TEXT,
        state TEXT,
        pincode TEXT,
        isDefault INTEGER DEFAULT 0,
        FOREIGN KEY (userId) REFERENCES users(id)
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        products TEXT,
        totalAmount REAL,
        shippingAddress TEXT,
        phone TEXT,
        orderId TEXT,
        paymentId TEXT,
        status TEXT DEFAULT 'Pending',
        deliveredAt DATETIME,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS order_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orderId INTEGER,
        status TEXT,
        message TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (orderId) REFERENCES orders(id)
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS search_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        searchTerm TEXT,
        resultCount INTEGER,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

console.log('✅ SQLite Database initialized');

// ============ HELPER FUNCTIONS ============
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET || 'mysecretkey', { expiresIn: '7d' });
};

function getTrackingMessage(status) {
    const messages = {
        'Pending': 'Order received and pending confirmation',
        'Processing': 'Order is being processed and packed',
        'Shipped': 'Order has been shipped via our logistics partner',
        'Delivered': 'Order has been delivered successfully',
        'Cancelled': 'Order has been cancelled'
    };
    return messages[status] || 'Order status updated';
}

// Image Upload Setup for Products
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/avatars/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const avatarUpload = multer({ storage: avatarStorage });

// ============ MIDDLEWARE ============
async function auth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'mysecretkey');
        const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(decoded.id);
        if (!user) return res.status(401).json({ error: 'User not found' });
        req.user = { 
            id: user.id, 
            isAdmin: user.isAdmin === 1, 
            name: user.name, 
            email: user.email, 
            phone: user.phone || '', 
            address: user.address || '',
            avatar: user.avatar || ''
        };
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ============ API ROUTES ============

app.get('/api/test', (req, res) => {
    res.json({ message: 'Server is working with better-sqlite3!' });
});

app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const hashed = await bcrypt.hash(password, 10);
        
        const result = db.prepare(`INSERT INTO users (name, email, password) VALUES (?, ?, ?)`).run(name, email, hashed);
        const token = generateToken(result.lastInsertRowid);
        res.json({ token, user: { id: result.lastInsertRowid, name, email, isAdmin: false, phone: '', address: '', avatar: '' } });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    if (!user) {
        return res.status(401).json({ error: 'User not found' });
    }
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    
    const token = generateToken(user.id);
    res.json({ 
        token, 
        user: { 
            id: user.id, 
            name: user.name, 
            email: user.email, 
            isAdmin: user.isAdmin === 1,
            phone: user.phone || '',
            address: user.address || '',
            avatar: user.avatar || ''
        } 
    });
});

app.get('/api/products', (req, res) => {
    let query = `SELECT * FROM products`;
    let params = [];
    let conditions = [];
    
    if (req.query.category && req.query.category !== 'All' && req.query.category !== 'undefined') {
        conditions.push(`category = ?`);
        params.push(req.query.category);
    }
    
    if (req.query.search && req.query.search.trim() !== '') {
        conditions.push(`(name LIKE ? OR description LIKE ?)`);
        params.push(`%${req.query.search}%`, `%${req.query.search}%`);
    }
    
    if (conditions.length > 0) {
        query += ` WHERE ` + conditions.join(` AND `);
    }
    
    query += ` ORDER BY createdAt DESC`;
    
    const products = db.prepare(query).all(...params);
    const parsedProducts = products.map(p => ({
        ...p,
        images: p.images ? JSON.parse(p.images) : []
    }));
    res.json(parsedProducts);
});

app.get('/api/products/:id', (req, res) => {
    const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id);
    if (!product) {
        return res.status(404).json({ error: 'Product not found' });
    }
    product.images = product.images ? JSON.parse(product.images) : [];
    res.json(product);
});

app.post('/api/products', auth, upload.array('images', 3), (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    try {
        const productData = JSON.parse(req.body.data);
        const imageUrls = JSON.stringify(req.files.map(file => `/uploads/${file.filename}`));
        
        const result = db.prepare(`INSERT INTO products (name, description, price, category, images, stock) VALUES (?, ?, ?, ?, ?, ?)`).run(
            productData.name, productData.description, productData.price, productData.category, imageUrls, productData.stock || 10
        );
        res.json({ id: result.lastInsertRowid, ...productData, images: JSON.parse(imageUrls) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/products/:id/field', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    const { field, value } = req.body;
    
    let query = '';
    let param = '';
    
    if (field === 'isFeatured' || field === 'isFinest') {
        query = `UPDATE products SET ${field} = ? WHERE id = ?`;
        param = value ? 1 : 0;
    } else if (field === 'region') {
        query = `UPDATE products SET region = ? WHERE id = ?`;
        param = value || '';
    } else {
        return res.status(400).json({ error: 'Invalid field' });
    }
    
    db.prepare(query).run(param, req.params.id);
    res.json({ success: true });
});

app.delete('/api/products/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    db.prepare(`DELETE FROM products WHERE id = ?`).run(req.params.id);
    res.json({ message: 'Deleted' });
});

app.post('/api/wishlist/:productId', auth, (req, res) => {
    const user = db.prepare(`SELECT wishlist FROM users WHERE id = ?`).get(req.user.id);
    let wishlist = user.wishlist ? JSON.parse(user.wishlist) : [];
    const index = wishlist.indexOf(parseInt(req.params.productId));
    
    if (index === -1) {
        wishlist.push(parseInt(req.params.productId));
    } else {
        wishlist.splice(index, 1);
    }
    
    db.prepare(`UPDATE users SET wishlist = ? WHERE id = ?`).run(JSON.stringify(wishlist), req.user.id);
    res.json({ wishlist });
});

app.get('/api/wishlist', auth, (req, res) => {
    const user = db.prepare(`SELECT wishlist FROM users WHERE id = ?`).get(req.user.id);
    const wishlistIds = user.wishlist ? JSON.parse(user.wishlist) : [];
    if (wishlistIds.length === 0) {
        return res.json([]);
    }
    const placeholders = wishlistIds.map(() => '?').join(',');
    const products = db.prepare(`SELECT * FROM products WHERE id IN (${placeholders})`).all(...wishlistIds);
    res.json(products || []);
});

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.post('/api/create-order', auth, async (req, res) => {
    try {
        const options = {
            amount: req.body.amount * 100,
            currency: "INR",
            receipt: `receipt_${Date.now()}`,
            payment_capture: 1
        };
        const order = await razorpay.orders.create(options);
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/verify-payment', auth, (req, res) => {
    const { orderId, paymentId, products, totalAmount, shippingAddress, phone } = req.body;
    const result = db.prepare(`INSERT INTO orders (userId, products, totalAmount, shippingAddress, phone, orderId, paymentId, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        req.user.id, JSON.stringify(products), totalAmount, shippingAddress, phone, orderId, paymentId, 'Processing'
    );
    res.json({ success: true, orderId: result.lastInsertRowid });
});

app.get('/api/orders', auth, (req, res) => {
    const orders = db.prepare(`SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC`).all(req.user.id);
    const parsedOrders = orders.map(o => ({
        ...o,
        products: JSON.parse(o.products)
    }));
    res.json(parsedOrders);
});

app.get('/api/admin/orders', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const orders = db.prepare(`SELECT * FROM orders ORDER BY createdAt DESC`).all();
    const parsedOrders = orders.map(o => ({
        ...o,
        products: JSON.parse(o.products)
    }));
    res.json(parsedOrders);
});

app.put('/api/orders/:id/status', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const { status } = req.body;
    db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).run(status, req.params.id);
    const trackingMessage = getTrackingMessage(status);
    db.prepare(`INSERT INTO order_tracking (orderId, status, message, createdAt) VALUES (?, ?, ?, ?)`).run(req.params.id, status, trackingMessage, new Date().toISOString());
    res.json({ message: 'Status updated' });
});

app.get('/api/admin/stats', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const totalOrders = db.prepare(`SELECT COUNT(*) as count FROM orders`).get();
    const totalRevenue = db.prepare(`SELECT SUM(totalAmount) as total FROM orders`).get();
    const totalProducts = db.prepare(`SELECT COUNT(*) as count FROM products`).get();
    res.json({
        totalOrders: totalOrders?.count || 0,
        totalRevenue: totalRevenue?.total || 0,
        totalProducts: totalProducts?.count || 0
    });
});

app.get('/api/orders/:id', auth, (req, res) => {
    const order = db.prepare(`SELECT * FROM orders WHERE id = ? AND userId = ?`).get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    order.products = JSON.parse(order.products);
    const tracking = db.prepare(`SELECT * FROM order_tracking WHERE orderId = ? ORDER BY createdAt ASC`).all(req.params.id);
    res.json({ ...order, tracking: tracking || [] });
});

// User profile endpoints
app.put('/api/user/update', auth, (req, res) => {
    const { name, email, phone } = req.body;
    let query = 'UPDATE users SET ';
    const updates = [];
    const params = [];
    if (name) { updates.push('name = ?'); params.push(name); }
    if (email) { updates.push('email = ?'); params.push(email); }
    if (phone) { updates.push('phone = ?'); params.push(phone); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    query += updates.join(', ') + ' WHERE id = ?';
    params.push(req.user.id);
    db.prepare(query).run(...params);
    res.json({ success: true });
});

app.put('/api/user/change-password', auth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = db.prepare(`SELECT password FROM users WHERE id = ?`).get(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    db.prepare(`UPDATE users SET password = ? WHERE id = ?`).run(hashed, req.user.id);
    res.json({ success: true });
});

// Coupon endpoints
app.get('/api/admin/coupons', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const coupons = db.prepare(`SELECT * FROM coupons ORDER BY createdAt DESC`).all();
    res.json(coupons || []);
});

app.post('/api/admin/coupons', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const { code, description, discountType, discountValue, minOrderAmount, maxDiscount, validFrom, validTo, usageLimit } = req.body;
    const result = db.prepare(`INSERT INTO coupons (code, description, discountType, discountValue, minOrderAmount, maxDiscount, validFrom, validTo, usageLimit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        code.toUpperCase(), description, discountType, discountValue, minOrderAmount || 0, maxDiscount || null, validFrom || null, validTo || null, usageLimit || 0
    );
    res.json({ id: result.lastInsertRowid, message: 'Coupon created successfully' });
});

app.delete('/api/admin/coupons/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    db.prepare(`DELETE FROM coupons WHERE id=?`).run(req.params.id);
    res.json({ message: 'Coupon deleted' });
});

app.post('/api/validate-coupon', auth, (req, res) => {
    const { code, orderAmount } = req.body;
    const coupon = db.prepare(`SELECT * FROM coupons WHERE code = ? AND isActive = 1`).get(code.toUpperCase());
    if (!coupon) return res.status(404).json({ error: 'Invalid coupon code' });
    
    const now = new Date();
    if (coupon.validFrom && new Date(coupon.validFrom) > now) {
        return res.status(400).json({ error: `Coupon valid from ${new Date(coupon.validFrom).toLocaleDateString()}` });
    }
    if (coupon.validTo && new Date(coupon.validTo) < now) {
        return res.status(400).json({ error: 'Coupon has expired' });
    }
    if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
        return res.status(400).json({ error: 'Coupon usage limit reached' });
    }
    if (orderAmount < coupon.minOrderAmount) {
        return res.status(400).json({ error: `Minimum order amount of ₹${coupon.minOrderAmount} required` });
    }
    
    let discountAmount = 0;
    if (coupon.discountType === 'percentage') {
        discountAmount = (orderAmount * coupon.discountValue) / 100;
        if (coupon.maxDiscount && discountAmount > coupon.maxDiscount) {
            discountAmount = coupon.maxDiscount;
        }
    } else {
        discountAmount = Math.min(coupon.discountValue, orderAmount);
    }
    
    res.json({
        valid: true,
        coupon: {
            id: coupon.id,
            code: coupon.code,
            description: coupon.description,
            discountType: coupon.discountType,
            discountValue: coupon.discountValue,
            discountAmount: Math.round(discountAmount),
            finalAmount: Math.round(orderAmount - discountAmount),
            savings: Math.round(discountAmount)
        }
    });
});

app.post('/api/use-coupon', auth, (req, res) => {
    const { couponId } = req.body;
    db.prepare(`UPDATE coupons SET usedCount = usedCount + 1 WHERE id = ?`).run(couponId);
    res.json({ success: true });
});

// Export database
app.get('/api/export-data', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    const exportData = {
        products: db.prepare(`SELECT * FROM products`).all(),
        users: db.prepare(`SELECT id, name, email, phone, isAdmin, wishlist, avatar, createdAt FROM users`).all(),
        orders: db.prepare(`SELECT * FROM orders ORDER BY createdAt DESC`).all(),
        coupons: db.prepare(`SELECT * FROM coupons ORDER BY createdAt DESC`).all()
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=swadeshi-backup-${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`);
    res.json(exportData);
});

// ============ INITIALIZE SAMPLE DATA ============
async function init() {
    // Create admin user
    const admin = db.prepare(`SELECT * FROM users WHERE email = 'admin@swadeshi.com'`).get();
    if (!admin) {
        const hashed = await bcrypt.hash('admin123', 10);
        db.prepare(`INSERT INTO users (name, email, password, isAdmin) VALUES (?, ?, ?, ?)`).run('Admin', 'admin@swadeshi.com', hashed, 1);
        console.log('✅ Admin created: admin@swadeshi.com / admin123');
    }
    
    // Add sample products
    const productCount = db.prepare(`SELECT COUNT(*) as count FROM products`).get();
    if (productCount.count === 0) {
        const samples = [
            ['Banarasi Silk Saree', 'Handwoven pure silk saree with gold zari work.', 8999, 'Sarees', JSON.stringify(['https://images.unsplash.com/photo-1611501275019-9c5c6f6c5a5e?w=300']), 5],
            ['Madhubani Painting', 'Traditional folk art from Bihar.', 3499, 'Paintings', JSON.stringify(['https://images.unsplash.com/photo-1581091226033-d5c48150dbaa?w=300']), 10],
            ['Kalamkari Kurta', 'Hand-painted cotton kurta.', 2499, 'Apparel', JSON.stringify(['https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=300']), 15]
        ];
        for (const sample of samples) {
            db.prepare(`INSERT INTO products (name, description, price, category, images, stock) VALUES (?, ?, ?, ?, ?, ?)`).run(...sample);
        }
        console.log('✅ Sample products added');
    }
}

init();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
    console.log(`✅ Using better-sqlite3 database`);
});
