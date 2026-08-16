import { fetchProducts, initRealtimeSync, fetchFeedbackList, API_BASE } from '../../js/api.js';

let products = [];
let orders = [];
let feedbackList = [];

// DOM Elements
const totalProductsEl = document.getElementById('totalProducts');
const totalStockEl = document.getElementById('totalStock');
const activeUsersEl = document.getElementById('activeUsers');
const totalOrdersEl = document.getElementById('totalOrders');
const productsTableBody = document.getElementById('productsTableBody');
const ordersTableBody = document.getElementById('ordersTableBody');
const feedbackTableBody = document.getElementById('feedbackTableBody');
const addProductBtn = document.getElementById('addProductBtn');
const addModal = document.getElementById('addModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const addProductForm = document.getElementById('addProductForm');

async function initAdmin() {
  setupEventListeners();
  await loadMetrics();
  await loadAdminProducts();
  await loadAdminOrders();
  await loadAdminFeedback();

  // Connect to Real-time Sync Engine (Durable Object)
  initRealtimeSync(handleRealtimeSync);
}

function formatCurrency(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

async function loadMetrics() {
  try {
    const res = await fetch(`${API_BASE}/metrics`);
    const data = await res.json();
    if (data.success) {
      totalProductsEl.textContent = data.metrics.totalProducts;
      totalStockEl.textContent = data.metrics.totalStock;
      totalOrdersEl.textContent = `${data.metrics.totalOrders} (${formatCurrency(data.metrics.totalRevenue)})`;
    }
  } catch (err) {
    console.error("Error loading metrics:", err);
  }
}

async function loadAdminProducts() {
  products = await fetchProducts('all');
  renderProductsTable();
}

async function loadAdminOrders() {
  try {
    const res = await fetch(`${API_BASE}/orders`);
    const data = await res.json();
    if (data.success) {
      orders = data.orders || [];
      renderOrdersTable();
    }
  } catch (err) {
    console.error("Error loading orders:", err);
  }
}

async function loadAdminFeedback() {
  feedbackList = await fetchFeedbackList();
  renderFeedbackTable();
}

function renderProductsTable() {
  if (!products || products.length === 0) {
    productsTableBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          No products found.
        </td>
      </tr>
    `;
    return;
  }

  productsTableBody.innerHTML = products.map(prod => `
    <tr id="admin-row-${prod.id}">
      <td><img src="${prod.image_url}" class="prod-thumb" alt="${prod.name}" /></td>
      <td style="font-weight: 700;">${prod.name}</td>
      <td style="text-transform: capitalize;">${prod.category}</td>
      <td>
        <input 
          type="number" 
          step="1" 
          value="${prod.price}" 
          style="width: 100px; background: var(--bg-dark); color: #fff; border: 1px solid var(--border-color); padding: 0.3rem 0.5rem; border-radius: 6px;"
          onchange="window.updatePrice('${prod.id}', this.value)"
        />
      </td>
      <td>
        <div class="stock-control">
          <button class="btn-stock" onclick="window.adjustStock('${prod.id}', -1)">-</button>
          <span style="font-weight: 800; min-width: 30px; text-align: center;" id="admin-stock-${prod.id}">${prod.stock}</span>
          <button class="btn-stock" onclick="window.adjustStock('${prod.id}', 1)">+</button>
        </div>
      </td>
      <td>
        <span class="stock-badge ${prod.stock === 0 ? 'out-stock' : prod.stock <= 5 ? 'low-stock' : 'in-stock'}">
          ${prod.stock === 0 ? 'Out of Stock' : prod.stock <= 5 ? 'Low Stock' : 'Active'}
        </span>
      </td>
      <td>
        <button class="btn-danger" onclick="window.deleteProduct('${prod.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

function renderOrdersTable() {
  if (!orders || orders.length === 0) {
    ordersTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          No customer orders placed yet.
        </td>
      </tr>
    `;
    return;
  }

  ordersTableBody.innerHTML = orders.map(ord => {
    const formattedTime = ord.created_at ? new Date(ord.created_at).toLocaleString('en-IN') : 'Just now';
    return `
      <tr>
        <td style="font-family: monospace; font-weight: 700; color: var(--accent-blue);">${ord.id}</td>
        <td>${ord.customer_name}</td>
        <td style="font-weight: 600;">${ord.items_summary || (ord.items_count + ' item(s)')}</td>
        <td style="font-weight: 800; color: var(--success);">${formatCurrency(ord.total_amount)}</td>
        <td style="color: var(--text-muted); font-size: 0.85rem;">${formattedTime}</td>
      </tr>
    `;
  }).join('');
}

function renderFeedbackTable() {
  if (!feedbackList || feedbackList.length === 0) {
    feedbackTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          No customer feedback submitted yet.
        </td>
      </tr>
    `;
    return;
  }

  feedbackTableBody.innerHTML = feedbackList.map(fb => {
    const formattedTime = fb.created_at ? new Date(fb.created_at).toLocaleString('en-IN') : 'Just now';
    const stars = '⭐'.repeat(fb.rating);
    return `
      <tr>
        <td style="font-weight: 700;">${fb.customer_name}</td>
        <td style="color: var(--text-muted);">${fb.email || 'N/A'}</td>
        <td style="color: var(--warning);">${stars} (${fb.rating}/5)</td>
        <td>${fb.comments}</td>
        <td style="color: var(--text-muted); font-size: 0.85rem;">${formattedTime}</td>
      </tr>
    `;
  }).join('');
}

window.adjustStock = async (prodId, delta) => {
  const prod = products.find(p => p.id === prodId);
  if (!prod) return;

  const newStock = Math.max(0, prod.stock + delta);
  prod.stock = newStock;
  document.getElementById(`admin-stock-${prodId}`).textContent = newStock;

  try {
    const res = await fetch(`${API_BASE}/products/${prodId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stock: newStock })
    });
    const data = await res.json();
    if (data.success) {
      loadMetrics();
    }
  } catch (err) {
    console.error("Stock adjustment failed:", err);
  }
};

window.updatePrice = async (prodId, newPriceVal) => {
  const price = parseFloat(newPriceVal);
  if (isNaN(price) || price < 0) return;

  try {
    const res = await fetch(`${API_BASE}/products/${prodId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price })
    });
    const data = await res.json();
    if (data.success) {
      loadMetrics();
    }
  } catch (err) {
    console.error("Price update failed:", err);
  }
};

window.deleteProduct = async (prodId) => {
  if (!confirm("Are you sure you want to delete this product?")) return;

  try {
    const res = await fetch(`${API_BASE}/products/${prodId}`, {
      method: "DELETE"
    });
    const data = await res.json();
    if (data.success) {
      await loadAdminProducts();
      await loadMetrics();
    }
  } catch (err) {
    console.error("Delete product failed:", err);
  }
};

function setupEventListeners() {
  addProductBtn.addEventListener('click', () => addModal.classList.add('active'));
  closeModalBtn.addEventListener('click', () => addModal.classList.remove('active'));

  addProductForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(addProductForm);
    const newProduct = {
      name: formData.get('name'),
      category: formData.get('category'),
      price: parseFloat(formData.get('price')),
      stock: parseInt(formData.get('stock')),
      description: formData.get('description'),
      image_url: formData.get('image_url')
    };

    try {
      const res = await fetch(`${API_BASE}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newProduct)
      });
      const data = await res.json();
      if (data.success) {
        addModal.classList.remove('active');
        addProductForm.reset();
        await loadAdminProducts();
        await loadMetrics();
      }
    } catch (err) {
      console.error("Add product failed:", err);
    }
  });
}

function handleRealtimeSync(event) {
  if (event.type === 'ACTIVE_USERS_COUNT') {
    activeUsersEl.textContent = event.activeConnections;
  } else if (event.type === 'PRODUCT_STOCK_UPDATED') {
    const stockEl = document.getElementById(`admin-stock-${event.productId}`);
    if (stockEl) stockEl.textContent = event.newStock;
    loadMetrics();
  } else if (event.type === 'ORDER_PLACED') {
    if (event.order) {
      orders.unshift(event.order);
      renderOrdersTable();
      loadMetrics();
      loadAdminProducts();
    }
  } else if (event.type === 'FEEDBACK_SUBMITTED') {
    if (event.feedback) {
      feedbackList.unshift(event.feedback);
      renderFeedbackTable();
    }
  } else if (event.type === 'PRODUCT_ADDED' || event.type === 'PRODUCT_UPDATED' || event.type === 'PRODUCT_DELETED') {
    loadAdminProducts();
    loadMetrics();
  }
}

document.addEventListener('DOMContentLoaded', initAdmin);
