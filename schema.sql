-- Database Schema for CloudCart Electronics (Cloudflare D1)

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    image_url TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    items_summary TEXT NOT NULL DEFAULT '',
    total_amount REAL NOT NULL,
    items_count INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    email TEXT,
    rating INTEGER NOT NULL,
    comments TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed initial products for CloudCart Electronics (Prices in Indian Rupees ₹)
INSERT OR REPLACE INTO products (id, name, category, price, stock, description, image_url, is_active) VALUES
('prod-1', 'CloudCart Book Pro 16"', 'laptops', 199999.00, 12, 'Ultra-performance M-series flagship laptop with 120Hz Liquid Retina display, 32GB RAM, and 1TB SSD.', 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=800&q=80', 1),
('prod-2', 'CloudCart Phone 15 Ultra', 'smartphones', 99999.00, 8, 'Titanium body smartphone with periscope quad-camera system, 120Hz OLED screen, and all-day battery life.', 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=800&q=80', 1),
('prod-3', 'CloudCart Studio Sound ANC', 'audio', 24999.00, 25, 'Premium wireless noise-canceling headphones with spatial audio tracking and 40-hour battery.', 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80', 1),
('prod-4', 'CloudCart Watch Horizon 2', 'smartwatches', 32999.00, 5, 'Rugged smartwatch with dual-frequency GPS, health metrics monitoring, and 100m water resistance.', 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=800&q=80', 1),
('prod-5', 'CloudCart Mechanical Key V1', 'accessories', 11999.00, 30, 'Wireless mechanical keyboard with hot-swappable tactile switches and customizable RGB lighting.', 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=800&q=80', 1),
('prod-6', 'CloudCart Air Tab 11"', 'tablets', 64999.00, 15, 'Ultra-thin tablet powered by CloudCart Neural Chip with stylus and keyboard magnetically attached.', 'https://images.unsplash.com/photo-1544244015-0df4b3ffc6b0?auto=format&fit=crop&w=800&q=80', 1);

-- Seed sample customer feedback
INSERT OR REPLACE INTO feedback (id, customer_name, email, rating, comments) VALUES
('fb-1', 'John Doe', 'john@example.com', 5, 'Exceptional delivery speed and build quality on CloudCart Book Pro!'),
('fb-2', 'Jane Smith', 'jane@example.com', 4, 'CloudCart Studio Sound ANC headphones have amazing noise cancellation.');
