import { fetchProducts, submitCheckout, initRealtimeSync, fetchKVCart, saveKVCart, submitFeedback } from './api.js';

// Application Session ID for KV Persistence
let sessionId = localStorage.getItem('cloudcart_session_id');
if (!sessionId) {
  sessionId = 'sess-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
  localStorage.setItem('cloudcart_session_id', sessionId);
}

// Application State
let products = [];
let cart = JSON.parse(localStorage.getItem('cloudcart_cart') || '[]');
let activeCategory = 'all';
let searchQuery = '';

// DOM Elements
const productsGrid = document.getElementById('productsGrid');
const searchInput = document.getElementById('searchInput');
const categoryChips = document.querySelectorAll('.category-chip');
const cartBtn = document.getElementById('cartBtn');
const cartCount = document.getElementById('cartCount');
const cartDrawerOverlay = document.getElementById('cartDrawerOverlay');
const closeCartBtn = document.getElementById('closeCartBtn');
const cartItemsList = document.getElementById('cartItemsList');
const cartSubtotal = document.getElementById('cartSubtotal');
const checkoutBtn = document.getElementById('checkoutBtn');
const liveSyncDot = document.getElementById('liveSyncDot');
const activeUsersText = document.getElementById('activeUsersText');
const toastContainer = document.getElementById('toastContainer');

// Feedback Modal DOM Elements
const feedbackBtn = document.getElementById('feedbackBtn');
const feedbackModalOverlay = document.getElementById('feedbackModalOverlay');
const closeFeedbackBtn = document.getElementById('closeFeedbackBtn');
const feedbackForm = document.getElementById('feedbackForm');

// Initialize Customer App
async function init() {
  setupEventListeners();
  
  // Sync cart from Cloudflare KV Session Storage if local cart is empty
  if (cart.length === 0) {
    const kvCart = await fetchKVCart(sessionId);
    if (kvCart && kvCart.length > 0) {
      cart = kvCart;
      localStorage.setItem('cloudcart_cart', JSON.stringify(cart));
    }
  }

  updateCartUI();
  await loadProducts();

  // Connect to Cloudflare Durable Object for Live Sync
  initRealtimeSync(handleRealtimeEvent, handleSyncStatus);
}

// Load Products from API
async function loadProducts() {
  productsGrid.innerHTML = `
    <div style="grid-column: 1 / -1; text-align: center; padding: 4rem; color: var(--text-muted);">
      <p style="font-size: 1.2rem;">Loading CloudCart Catalog...</p>
    </div>
  `;

  products = await fetchProducts(activeCategory, searchQuery);
  renderProducts();
}

// Format currency in INR (₹)
function formatCurrency(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

// Render Products Grid
function renderProducts() {
  if (!products || products.length === 0) {
    productsGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 4rem; color: var(--text-muted);">
        <h3>No products found</h3>
        <p>Try selecting a different category or clear search query.</p>
      </div>
    `;
    return;
  }

  productsGrid.innerHTML = products.map(prod => {
    let stockClass = 'in-stock';
    let stockText = `${prod.stock} In Stock`;

    if (prod.stock === 0) {
      stockClass = 'out-stock';
      stockText = 'Out of Stock';
    } else if (prod.stock <= 5) {
      stockClass = 'low-stock';
      stockText = `Only ${prod.stock} Left!`;
    }

    const isOutOfStock = prod.stock === 0;

    return `
      <div class="product-card" id="card-${prod.id}">
        <div class="product-img-wrapper">
          <img src="${prod.image_url}" alt="${prod.name}" loading="lazy" />
          <span class="stock-badge ${stockClass}" id="badge-${prod.id}">${stockText}</span>
        </div>
        <div class="product-info">
          <span class="product-category">${prod.category}</span>
          <h3 class="product-title">${prod.name}</h3>
          <p class="product-desc">${prod.description}</p>
          <div class="product-footer">
            <span class="product-price" id="price-${prod.id}">${formatCurrency(prod.price)}</span>
            <button 
              class="btn-add-cart" 
              id="btn-add-${prod.id}"
              onclick="window.addToCart('${prod.id}')"
              ${isOutOfStock ? 'disabled' : ''}
            >
              ${isOutOfStock ? 'Sold Out' : 'Add to Cart'}
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Global window reference for inline onclick
window.addToCart = (productId) => {
  const product = products.find(p => p.id === productId);
  if (!product || product.stock <= 0) return;

  const existingIndex = cart.findIndex(item => item.id === productId);
  if (existingIndex > -1) {
    if (cart[existingIndex].quantity < product.stock) {
      cart[existingIndex].quantity += 1;
    } else {
      showToast(`Cannot add more than available stock (${product.stock})`, 'warning');
      return;
    }
  } else {
    cart.push({ ...product, quantity: 1 });
  }

  saveCart();
  updateCartUI();
  showToast(`Added ${product.name} to cart`, 'success');
};

function saveCart() {
  localStorage.setItem('cloudcart_cart', JSON.stringify(cart));
  // Asynchronously sync cart with Cloudflare KV
  saveKVCart(sessionId, cart);
}

function updateCartUI() {
  const totalCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  cartCount.textContent = totalCount;

  if (cart.length === 0) {
    cartItemsList.innerHTML = `
      <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
        <p>Your shopping cart is empty</p>
      </div>
    `;
    cartSubtotal.textContent = '₹0';
    checkoutBtn.disabled = true;
    return;
  }

  checkoutBtn.disabled = false;
  let total = 0;

  cartItemsList.innerHTML = cart.map(item => {
    const itemTotal = item.price * item.quantity;
    total += itemTotal;
    return `
      <div class="cart-item">
        <img src="${item.image_url}" alt="${item.name}" />
        <div class="cart-item-details">
          <div class="cart-item-title">${item.name}</div>
          <div class="cart-item-price">${formatCurrency(item.price)}</div>
          <div class="cart-qty-controls">
            <button class="btn-qty" onclick="window.updateQty('${item.id}', -1)">-</button>
            <span style="font-weight: 700;">${item.quantity}</span>
            <button class="btn-qty" onclick="window.updateQty('${item.id}', 1)">+</button>
          </div>
        </div>
        <button 
          style="background: transparent; border: none; color: var(--danger); cursor: pointer; font-size: 1.1rem;"
          onclick="window.removeFromCart('${item.id}')"
        >&times;</button>
      </div>
    `;
  }).join('');

  cartSubtotal.textContent = formatCurrency(total);
}

window.updateQty = (productId, delta) => {
  const itemIndex = cart.findIndex(i => i.id === productId);
  if (itemIndex === -1) return;

  const product = products.find(p => p.id === productId);

  if (delta > 0 && product && cart[itemIndex].quantity >= product.stock) {
    showToast(`Maximum stock limit reached (${product.stock})`, 'warning');
    return;
  }

  cart[itemIndex].quantity += delta;
  if (cart[itemIndex].quantity <= 0) {
    cart.splice(itemIndex, 1);
  }

  saveCart();
  updateCartUI();
};

window.removeFromCart = (productId) => {
  cart = cart.filter(i => i.id !== productId);
  saveCart();
  updateCartUI();
};

// Setup Event Listeners
function setupEventListeners() {
  // Search bar input
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadProducts, 300);
  });

  // Category filter chips
  categoryChips.forEach(chip => {
    chip.addEventListener('click', () => {
      categoryChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeCategory = chip.dataset.category;
      loadProducts();
    });
  });

  // Cart Drawer open/close
  cartBtn.addEventListener('click', () => cartDrawerOverlay.classList.add('active'));
  closeCartBtn.addEventListener('click', () => cartDrawerOverlay.classList.remove('active'));
  cartDrawerOverlay.addEventListener('click', (e) => {
    if (e.target === cartDrawerOverlay) cartDrawerOverlay.classList.remove('active');
  });

  // Feedback Modal open/close
  if (feedbackBtn) {
    feedbackBtn.addEventListener('click', () => feedbackModalOverlay.classList.add('active'));
    closeFeedbackBtn.addEventListener('click', () => feedbackModalOverlay.classList.remove('active'));
    feedbackModalOverlay.addEventListener('click', (e) => {
      if (e.target === feedbackModalOverlay) feedbackModalOverlay.classList.remove('active');
    });

    feedbackForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(feedbackForm);
      const feedbackData = {
        customer_name: formData.get('customer_name'),
        email: formData.get('email'),
        rating: parseInt(formData.get('rating')),
        comments: formData.get('comments')
      };

      const res = await submitFeedback(feedbackData);
      if (res.success) {
        showToast('⭐ Thank you for your feedback!', 'success');
        feedbackForm.reset();
        feedbackModalOverlay.classList.remove('active');
      } else {
        showToast(`❌ ${res.error}`, 'danger');
      }
    });
  }

  // Checkout process
  checkoutBtn.addEventListener('click', async () => {
    if (cart.length === 0) return;

    checkoutBtn.disabled = true;
    checkoutBtn.textContent = 'Processing Purchase...';

    const res = await submitCheckout(cart, 'Guest Customer');

    if (res.success) {
      showToast(`🎉 Order Placed! ID: ${res.orderId}`, 'success');
      cart = [];
      saveCart();
      updateCartUI();
      cartDrawerOverlay.classList.remove('active');
    } else {
      showToast(`❌ Checkout Failed: ${res.error}`, 'danger');
    }

    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Complete Purchase';
  });
}

// Handle Realtime Durable Object Sync Events
function handleRealtimeEvent(event) {
  if (event.type === 'PRODUCT_STOCK_UPDATED') {
    const prod = products.find(p => p.id === event.productId);
    if (prod) {
      prod.stock = event.newStock;
      updateSingleProductBadge(prod);
    }
  } else if (event.type === 'PRODUCT_UPDATED' || event.type === 'PRODUCT_ADDED' || event.type === 'PRODUCT_DELETED') {
    loadProducts();
  } else if (event.type === 'ACTIVE_USERS_COUNT') {
    activeUsersText.textContent = `${event.activeConnections} Live User${event.activeConnections === 1 ? '' : 's'}`;
  }
}

function updateSingleProductBadge(prod) {
  const badge = document.getElementById(`badge-${prod.id}`);
  const btn = document.getElementById(`btn-add-${prod.id}`);
  if (!badge || !btn) return;

  if (prod.stock === 0) {
    badge.className = 'stock-badge out-stock';
    badge.textContent = 'Out of Stock';
    btn.disabled = true;
    btn.textContent = 'Sold Out';
  } else if (prod.stock <= 5) {
    badge.className = 'stock-badge low-stock';
    badge.textContent = `Only ${prod.stock} Left!`;
    btn.disabled = false;
    btn.textContent = 'Add to Cart';
  } else {
    badge.className = 'stock-badge in-stock';
    badge.textContent = `${prod.stock} In Stock`;
    btn.disabled = false;
    btn.textContent = 'Add to Cart';
  }
}

function handleSyncStatus(isOnline) {
  if (isOnline) {
    liveSyncDot.classList.remove('offline');
  } else {
    liveSyncDot.classList.add('offline');
    activeUsersText.textContent = 'Connecting...';
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Start app on DOMReady
document.addEventListener('DOMContentLoaded', init);
