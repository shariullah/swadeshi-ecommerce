const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
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

// Image Upload Setup for Products
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// Avatar Upload Setup
const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/avatars/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const avatarUpload = multer({ storage: avatarStorage });

// Ensure avatars directory exists
if (!fs.existsSync('./uploads/avatars')) {
    fs.mkdirSync('./uploads/avatars', { recursive: true });
}

// Use Render's persistent disk for database (prevents data loss)
const dbPath = '/data/swadeshi.db';
const db = new sqlite3.Database(dbPath);
console.log(`✅ Database using persistent storage at: ${dbPath}`);

// Create tables
db.serialize(() => {
    // Products table
    db.run(`CREATE TABLE IF NOT EXISTS products (
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
    )`);
    
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
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
    )`);

    // Coupons table
    db.run(`CREATE TABLE IF NOT EXISTS coupons (
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
    )`);
    
    // Addresses table
    db.run(`CREATE TABLE IF NOT EXISTS addresses (
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
    )`);
    
    // Orders table
    db.run(`CREATE TABLE IF NOT EXISTS orders (
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
    )`);
    
    // Order tracking table
    db.run(`CREATE TABLE IF NOT EXISTS order_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orderId INTEGER,
        status TEXT,
        message TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (orderId) REFERENCES orders(id)
    )`);
    
    // Search analytics table
    db.run(`CREATE TABLE IF NOT EXISTS search_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        searchTerm TEXT,
        resultCount INTEGER,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    console.log('✅ SQLite Database initialized');
});

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

// ============ MIDDLEWARE ============
async function auth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'mysecretkey');
        db.get(`SELECT * FROM users WHERE id = ?`, [decoded.id], (err, user) => {
            if (err || !user) return res.status(401).json({ error: 'User not found' });
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
        });
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ============ API ROUTES ============

// Test route
app.get('/api/test', (req, res) => {
    res.json({ message: 'Server is working with SQLite!' });
});

// Debug endpoint
app.get('/api/debug/columns', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    db.all(`PRAGMA table_info(products)`, [], (err, columns) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(columns);
    });
});

// Register
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const hashed = await bcrypt.hash(password, 10);
        
        db.run(`INSERT INTO users (name, email, password) VALUES (?, ?, ?)`, [name, email, hashed], function(err) {
            if (err) {
                return res.status(400).json({ error: err.message });
            }
            const token = generateToken(this.lastID);
            res.json({ token, user: { id: this.lastID, name, email, isAdmin: false, phone: '', address: '', avatar: '' } });
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Login
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) {
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
});

// Get all products with filters
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
    
    db.all(query, params, (err, products) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        const parsedProducts = products.map(p => ({
            ...p,
            images: p.images ? JSON.parse(p.images) : []
        }));
        res.json(parsedProducts);
    });
});

// Get single product
app.get('/api/products/:id', (req, res) => {
    db.get(`SELECT * FROM products WHERE id = ?`, [req.params.id], (err, product) => {
        if (err || !product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        product.images = product.images ? JSON.parse(product.images) : [];
        res.json(product);
    });
});

// Create product (Admin only)
app.post('/api/products', auth, upload.array('images', 3), (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    try {
        const productData = JSON.parse(req.body.data);
        const imageUrls = JSON.stringify(req.files.map(file => `/uploads/${file.filename}`));
        
        db.run(`INSERT INTO products (name, description, price, category, images, stock) VALUES (?, ?, ?, ?, ?, ?)`,
            [productData.name, productData.description, productData.price, productData.category, imageUrls, productData.stock || 10],
            function(err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ id: this.lastID, ...productData, images: JSON.parse(imageUrls) });
            });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update product (Admin only)
app.put('/api/products/:id', auth, upload.array('images', 3), (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    try {
        const updateData = JSON.parse(req.body.data);
        
        let imageUrls = null;
        if (req.files && req.files.length > 0) {
            imageUrls = JSON.stringify(req.files.map(file => `/uploads/${file.filename}`));
        } else if (updateData.existingImages) {
            imageUrls = JSON.stringify(updateData.existingImages);
        }
        
        let query = `UPDATE products SET name=?, description=?, price=?, category=?, stock=?`;
        let params = [updateData.name, updateData.description, updateData.price, updateData.category, updateData.stock];
        
        if (imageUrls) {
            query += `, images=?`;
            params.push(imageUrls);
        }
        
        query += ` WHERE id=?`;
        params.push(req.params.id);
        
        db.run(query, params, function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ message: 'Product updated' });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete product (Admin only)
app.delete('/api/products/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    db.run(`DELETE FROM products WHERE id = ?`, [req.params.id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Deleted' });
    });
});

// Update product fields
app.put('/api/products/:id/field', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    const { field, value } = req.body;
    
    console.log(`Updating product ${req.params.id}: ${field} = ${value}`);
    
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
    
    db.run(query, [param, req.params.id], function(err) {
        if (err) {
            console.error('Database error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        console.log(`Successfully updated product ${req.params.id}: ${field}=${param}`);
        res.json({ success: true });
    });
});

// Wishlist
app.post('/api/wishlist/:productId', auth, (req, res) => {
    db.get(`SELECT wishlist FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        let wishlist = user.wishlist ? JSON.parse(user.wishlist) : [];
        const index = wishlist.indexOf(parseInt(req.params.productId));
        
        if (index === -1) {
            wishlist.push(parseInt(req.params.productId));
        } else {
            wishlist.splice(index, 1);
        }
        
        db.run(`UPDATE users SET wishlist = ? WHERE id = ?`, [JSON.stringify(wishlist), req.user.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ wishlist });
        });
    });
});

app.get('/api/wishlist', auth, (req, res) => {
    db.get(`SELECT wishlist FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        const wishlistIds = user.wishlist ? JSON.parse(user.wishlist) : [];
        if (wishlistIds.length === 0) {
            return res.json([]);
        }
        const placeholders = wishlistIds.map(() => '?').join(',');
        db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, wishlistIds, (err, products) => {
            res.json(products || []);
        });
    });
});

// Search Analytics
app.get('/api/popular-searches', (req, res) => {
    db.all(`SELECT searchTerm, COUNT(*) as count FROM search_analytics 
            GROUP BY searchTerm ORDER BY count DESC LIMIT 10`, [], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results || []);
    });
});

app.post('/api/search-analytics', (req, res) => {
    const { searchTerm, resultCount } = req.body;
    db.run(`INSERT INTO search_analytics (searchTerm, resultCount) VALUES (?, ?)`, 
        [searchTerm, resultCount]);
    res.json({ success: true });
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
        console.log('Order created:', order);
        res.json(order);
    } catch (error) {
        console.error('Order creation error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/verify-payment', auth, (req, res) => {
    const { orderId, paymentId, products, totalAmount, shippingAddress, phone } = req.body;
    db.run(`INSERT INTO orders (userId, products, totalAmount, shippingAddress, phone, orderId, paymentId, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, JSON.stringify(products), totalAmount, shippingAddress, phone, orderId, paymentId, 'Processing'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, orderId: this.lastID });
        });
});

app.get('/api/orders', auth, (req, res) => {
    db.all(`SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC`, [req.user.id], (err, orders) => {
        if (err) return res.status(500).json({ error: err.message });
        const parsedOrders = orders.map(o => ({
            ...o,
            products: JSON.parse(o.products)
        }));
        res.json(parsedOrders);
    });
});

app.get('/api/admin/orders', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    db.all(`SELECT * FROM orders ORDER BY createdAt DESC`, [], (err, orders) => {
        if (err) return res.status(500).json({ error: err.message });
        const parsedOrders = orders.map(o => ({
            ...o,
            products: JSON.parse(o.products)
        }));
        res.json(parsedOrders);
    });
});

app.put('/api/orders/:id/status', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    const { status } = req.body;
    const deliveredAt = status === 'Delivered' ? new Date().toISOString() : null;
    
    db.run(`UPDATE orders SET status = ?, deliveredAt = ? WHERE id = ?`, 
        [status, deliveredAt, req.params.id], 
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            const trackingMessage = getTrackingMessage(status);
            db.run(`INSERT INTO order_tracking (orderId, status, message, createdAt) VALUES (?, ?, ?, ?)`,
                [req.params.id, status, trackingMessage, new Date().toISOString()]);
            
            res.json({ message: 'Status updated' });
        });
});

app.get('/api/admin/stats', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    db.get(`SELECT COUNT(*) as totalOrders FROM orders`, [], (err, orderCount) => {
        db.get(`SELECT SUM(totalAmount) as totalRevenue FROM orders`, [], (err, revenue) => {
            db.get(`SELECT COUNT(*) as totalProducts FROM products`, [], (err, productCount) => {
                res.json({
                    totalOrders: orderCount ? orderCount.totalOrders : 0,
                    totalRevenue: revenue ? (revenue.totalRevenue || 0) : 0,
                    totalProducts: productCount ? productCount.totalProducts : 0
                });
            });
        });
    });
});

// Get single order with tracking details
app.get('/api/orders/:id', auth, (req, res) => {
    db.get(`SELECT * FROM orders WHERE id = ? AND userId = ?`, [req.params.id, req.user.id], (err, order) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        order.products = JSON.parse(order.products);
        
        const orderDate = new Date(order.createdAt);
        let estimatedDelivery = new Date(orderDate);
        
        if (order.status === 'Pending') {
            estimatedDelivery.setDate(orderDate.getDate() + 10);
        } else if (order.status === 'Processing') {
            estimatedDelivery.setDate(orderDate.getDate() + 7);
        } else if (order.status === 'Shipped') {
            estimatedDelivery.setDate(orderDate.getDate() + 3);
        } else if (order.status === 'Delivered') {
            estimatedDelivery = new Date(order.deliveredAt || orderDate);
        } else if (order.status === 'Cancelled') {
            estimatedDelivery = new Date(orderDate);
        }
        
        db.all(`SELECT * FROM order_tracking WHERE orderId = ? ORDER BY createdAt ASC`, [req.params.id], (err, tracking) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ...order, estimatedDelivery: estimatedDelivery.toISOString(), tracking: tracking || [] });
        });
    });
});

// ============ CANCEL ORDER WITH REFUND ============

app.put('/api/orders/:id/cancel', auth, async (req, res) => {
    const orderId = req.params.id;
    console.log('========================================');
    console.log(`Cancel order request received for order ID: ${orderId}`);
    console.log(`User ID: ${req.user.id}`);
    console.log('========================================');
    
    db.get(`SELECT * FROM orders WHERE id = ? AND userId = ?`, [orderId, req.user.id], async (err, order) => {
        if (err) {
            console.error('❌ Database error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        if (!order) {
            console.log(`❌ Order ${orderId} not found for user ${req.user.id}`);
            return res.status(404).json({ error: 'Order not found' });
        }
        
        console.log(`✅ Order found:`);
        console.log(`   - Status: ${order.status}`);
        console.log(`   - PaymentId: ${order.paymentId}`);
        console.log(`   - Total Amount: ₹${order.totalAmount}`);
        
        if (order.status !== 'Pending' && order.status !== 'Processing') {
            console.log(`❌ Order cannot be cancelled - status: ${order.status}`);
            return res.status(400).json({ error: 'Order cannot be cancelled. Only Pending or Processing orders can be cancelled.' });
        }
        
        if (order.status === 'Cancelled') {
            console.log(`❌ Order is already cancelled`);
            return res.status(400).json({ error: 'Order is already cancelled' });
        }
        
        let refundSuccess = false;
        let refundError = null;
        
        if (order.paymentId) {
            console.log(`💰 Attempting refund for payment: ${order.paymentId}`);
            console.log(`💰 Refund amount: ₹${order.totalAmount}`);
            try {
                const razorpayInstance = new Razorpay({
                    key_id: process.env.RAZORPAY_KEY_ID,
                    key_secret: process.env.RAZORPAY_KEY_SECRET
                });
                
                const refund = await razorpayInstance.payments.refund(order.paymentId, {
                    amount: order.totalAmount * 100,
                    speed: 'normal',
                    notes: {
                        order_id: orderId.toString(),
                        reason: 'Customer cancelled order before shipping'
                    }
                });
                
                if (refund && refund.status === 'processed') {
                    refundSuccess = true;
                    console.log(`✅ Refund processed successfully! Refund ID: ${refund.id}`);
                } else {
                    console.log(`⚠️ Refund status: ${refund?.status}`);
                }
            } catch (refundErr) {
                console.error('❌ Refund error details:', refundErr);
                refundError = refundErr.error?.description || refundErr.message || 'Refund failed. Please contact support.';
            }
        } else {
            console.log(`⚠️ No payment ID found for this order`);
        }
        
        db.run(`UPDATE orders SET status = 'Cancelled' WHERE id = ?`, [orderId], function(err) {
            if (err) {
                console.error('❌ Error updating order status:', err.message);
                return res.status(500).json({ error: err.message });
            }
            
            console.log(`✅ Order ${orderId} status updated to 'Cancelled'`);
            
            const refundMessage = refundSuccess ? 'Refund has been processed successfully.' : (refundError ? `Note: ${refundError}` : '');
            db.run(`INSERT INTO order_tracking (orderId, status, message, createdAt) VALUES (?, ?, ?, ?)`,
                [orderId, 'Cancelled', `Order cancelled as requested by customer. ${refundMessage}`, new Date().toISOString()]);
            
            const products = JSON.parse(order.products);
            console.log(`📦 Restoring stock for ${products.length} product(s)`);
            products.forEach(item => {
                db.run(`UPDATE products SET stock = stock + ? WHERE id = ?`, [item.quantity, item.product]);
                console.log(`   - Product ID ${item.product}: +${item.quantity} stock restored`);
            });
            
            console.log(`✅ Cancel order process completed! Refund success: ${refundSuccess}`);
            console.log('========================================');
            
            res.json({ 
                success: true, 
                message: refundSuccess ? 'Order cancelled and refund initiated successfully!' : 'Order cancelled. Refund status: ' + (refundError || 'No payment to refund'),
                refundProcessed: refundSuccess
            });
        });
    });
});

// ============ USER PROFILE ENDPOINTS ============

app.put('/api/user/update', auth, async (req, res) => {
    const { name, email, phone } = req.body;
    let query = 'UPDATE users SET ';
    const params = [];
    const updates = [];
    
    if (name) { updates.push('name = ?'); params.push(name); }
    if (email) { updates.push('email = ?'); params.push(email); }
    if (phone) { updates.push('phone = ?'); params.push(phone); }
    
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    
    query += updates.join(', ') + ' WHERE id = ?';
    params.push(req.user.id);
    
    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Profile updated successfully' });
    });
});

app.put('/api/user/change-password', auth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Please provide current and new password' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    db.get('SELECT password FROM users WHERE id = ?', [req.user.id], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        const valid = await bcrypt.compare(currentPassword, user.password);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        
        const hashed = await bcrypt.hash(newPassword, 10);
        db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Password changed successfully' });
        });
    });
});

app.post('/api/user/avatar', auth, avatarUpload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatarUrl, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, avatarUrl: avatarUrl });
    });
});

app.get('/api/user/addresses', auth, (req, res) => {
    db.all('SELECT * FROM addresses WHERE userId = ? ORDER BY isDefault DESC', [req.user.id], (err, addresses) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(addresses || []);
    });
});

app.post('/api/user/addresses', auth, (req, res) => {
    const { type, name, phone, street, city, state, pincode, isDefault } = req.body;
    if (isDefault) db.run('UPDATE addresses SET isDefault = 0 WHERE userId = ?', [req.user.id]);
    db.run(`INSERT INTO addresses (userId, type, name, phone, street, city, state, pincode, isDefault) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, type, name, phone, street, city, state, pincode, isDefault ? 1 : 0],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        });
});

app.put('/api/user/addresses/:id/default', auth, (req, res) => {
    db.run('UPDATE addresses SET isDefault = 0 WHERE userId = ?', [req.user.id]);
    db.run('UPDATE addresses SET isDefault = 1 WHERE id = ? AND userId = ?', [req.params.id, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.delete('/api/user/addresses/:id', auth, (req, res) => {
    db.run('DELETE FROM addresses WHERE id = ? AND userId = ?', [req.params.id, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.delete('/api/user/delete', auth, (req, res) => {
    db.run('DELETE FROM users WHERE id = ?', [req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ============ COUPON API ENDPOINTS ============

app.get('/api/admin/coupons', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    db.all(`SELECT * FROM coupons ORDER BY createdAt DESC`, [], (err, coupons) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(coupons || []);
    });
});

app.post('/api/admin/coupons', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const { code, description, discountType, discountValue, minOrderAmount, maxDiscount, validFrom, validTo, usageLimit } = req.body;
    db.run(`INSERT INTO coupons (code, description, discountType, discountValue, minOrderAmount, maxDiscount, validFrom, validTo, usageLimit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [code.toUpperCase(), description, discountType, discountValue, minOrderAmount || 0, maxDiscount || null, validFrom || null, validTo || null, usageLimit || 0],
        function(err) {
            if (err) {
                console.error('Coupon creation error:', err.message);
                return res.status(500).json({ error: err.message });
            }
            res.json({ id: this.lastID, message: 'Coupon created successfully' });
        });
});

app.put('/api/admin/coupons/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const { code, description, discountType, discountValue, minOrderAmount, maxDiscount, validFrom, validTo, usageLimit, isActive } = req.body;
    db.run(`UPDATE coupons SET code=?, description=?, discountType=?, discountValue=?, minOrderAmount=?, maxDiscount=?, validFrom=?, validTo=?, usageLimit=?, isActive=? WHERE id=?`,
        [code.toUpperCase(), description, discountType, discountValue, minOrderAmount || 0, maxDiscount || null, validFrom || null, validTo || null, usageLimit || 0, isActive ? 1 : 0, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Coupon updated successfully' });
        });
});

app.delete('/api/admin/coupons/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    db.run(`DELETE FROM coupons WHERE id=?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Coupon deleted' });
    });
});

app.post('/api/validate-coupon', auth, (req, res) => {
    const { code, orderAmount } = req.body;
    db.get(`SELECT * FROM coupons WHERE code = ? AND isActive = 1`, [code.toUpperCase()], (err, coupon) => {
        if (err) return res.status(500).json({ error: err.message });
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
});

app.post('/api/use-coupon', auth, (req, res) => {
    const { couponId } = req.body;
    db.run(`UPDATE coupons SET usedCount = usedCount + 1 WHERE id = ?`, [couponId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Export database as JSON
app.get('/api/export-data', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    const exportData = {};
    let completed = 0;
    let totalQueries = 4;
    
    function checkComplete() {
        completed++;
        if (completed === totalQueries) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename=swadeshi-backup-${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`);
            res.json(exportData);
        }
    }
    
    db.all(`SELECT * FROM products`, [], (err, products) => {
        if (err) return res.status(500).json({ error: err.message });
        exportData.products = products;
        exportData.products_count = products.length;
        checkComplete();
    });
    
    db.all(`SELECT id, name, email, phone, isAdmin, wishlist, avatar, createdAt FROM users`, [], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });
        exportData.users = users;
        exportData.users_count = users.length;
        checkComplete();
    });
    
    db.all(`SELECT * FROM orders ORDER BY createdAt DESC`, [], (err, orders) => {
        if (err) return res.status(500).json({ error: err.message });
        const parsedOrders = orders.map(o => ({
            ...o,
            products: o.products ? JSON.parse(o.products) : []
        }));
        exportData.orders = parsedOrders;
        exportData.orders_count = orders.length;
        checkComplete();
    });
    
    db.all(`SELECT * FROM coupons ORDER BY createdAt DESC`, [], (err, coupons) => {
        if (err) return res.status(500).json({ error: err.message });
        exportData.coupons = coupons;
        exportData.coupons_count = coupons.length;
        checkComplete();
    });
});

// ============ INITIALIZE SAMPLE DATA ============
async function init() {
    db.get(`SELECT * FROM users WHERE email = 'admin@swadeshi.com'`, [], async (err, admin) => {
        if (!admin) {
            const hashed = await bcrypt.hash('admin123', 10);
            db.run(`INSERT INTO users (name, email, password, isAdmin) VALUES (?, ?, ?, ?)`, 
                ['Admin', 'admin@swadeshi.com', hashed, 1], (err) => {
                if (!err) console.log('✅ Admin created: admin@swadeshi.com / admin123');
            });
        }
    });
    
    db.get(`SELECT COUNT(*) as count FROM products`, [], (err, result) => {
        if (result && result.count === 0) {
            const samples = [
                ['Banarasi Silk Saree', 'Handwoven pure silk saree with gold zari work.', 8999, 'Sarees', JSON.stringify(['https://images.unsplash.com/photo-1611501275019-9c5c6f6c5a5e?w=300']), 5],
                ['Madhubani Painting', 'Traditional folk art from Bihar.', 3499, 'Paintings', JSON.stringify(['https://images.unsplash.com/photo-1581091226033-d5c48150dbaa?w=300']), 10],
                ['Kalamkari Kurta', 'Hand-painted cotton kurta.', 2499, 'Apparel', JSON.stringify(['https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=300']), 15]
            ];
            samples.forEach(sample => {
                db.run(`INSERT INTO products (name, description, price, category, images, stock) VALUES (?, ?, ?, ?, ?, ?)`, sample);
            });
            console.log('✅ Sample products added');
        }
    });
}

init();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
    console.log(`✅ Using SQLite database - no MongoDB needed!`);
});