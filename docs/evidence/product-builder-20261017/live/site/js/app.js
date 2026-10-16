document.addEventListener('DOMContentLoaded', () => {
  // Sample Data matching specific test expectations
  const defaultCustomers = [
    {
      id: 'cust-1',
      name: 'Alice Smith',
      email: 'alice.smith@example.com',
      phone: '+1 (555) 234-5678',
      notes: 'Key enterprise client, interested in annual subscription upgrade.',
      createdAt: new Date().toISOString()
    },
    {
      id: 'cust-2',
      name: 'Bob Jones',
      email: 'bob.jones@example.com',
      phone: '+1 (555) 876-5432',
      notes: 'Freelance designer collaborating on Q3 marketing campaign.',
      createdAt: new Date().toISOString()
    },
    {
      id: 'cust-3',
      name: 'Carol White',
      email: 'carol.w@example.com',
      phone: '+1 (555) 345-6789',
      notes: 'Referred by David. Requires follow-up next Tuesday.',
      createdAt: new Date().toISOString()
    }
  ];

  // LocalStorage wrapper with fallback
  const Storage = {
    get(key) {
      try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : null;
      } catch (e) {
        console.warn('LocalStorage unavailable, using in-memory store', e);
        return window._memoryStore ? window._memoryStore[key] : null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn('LocalStorage unavailable, writing to in-memory store', e);
        window._memoryStore = window._memoryStore || {};
        window._memoryStore[key] = value;
      }
    }
  };

  // State
  let customers = Storage.get('crm_customers');
  if (!customers || !Array.isArray(customers)) {
    customers = defaultCustomers;
    Storage.set('crm_customers', customers);
  }

  let currentDeleteId = null;

  // DOM Elements
  const customerListEl = document.getElementById('customer-list');
  const searchInput = document.getElementById('search');
  const totalCustomersEl = document.getElementById('metric-total');
  const recentCustomersEl = document.getElementById('metric-recent');
  
  const emptyStateEl = document.getElementById('empty-state');
  const noResultsStateEl = document.getElementById('no-results-state');
  const tableContainerEl = document.querySelector('.table-container');

  const customerModal = document.getElementById('customer-modal');
  const customerForm = document.getElementById('customer-form');
  const modalTitle = document.getElementById('modal-title');
  const customerIdInput = document.getElementById('customer-id');
  const customerNameInput = document.getElementById('customer-name');
  const customerEmailInput = document.getElementById('customer-email');
  const customerPhoneInput = document.getElementById('customer-phone');
  const customerNotesInput = document.getElementById('customer-notes');

  const deleteModal = document.getElementById('delete-modal');
  const deleteCustomerNameEl = document.getElementById('delete-customer-name');
  const confirmDeleteBtn = document.getElementById('confirm-delete-btn');

  // Buttons
  const openModalBtns = [
    document.getElementById('open-add-modal-btn'),
    document.getElementById('open-add-modal-btn-2')
  ];
  const closeModalBtn = document.getElementById('close-modal-btn');
  const cancelModalBtn = document.getElementById('cancel-modal-btn');
  const closeDeleteModalBtn = document.getElementById('close-delete-modal-btn');
  const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
  const exportBtn = document.getElementById('export-btn');
  const addFirstBtns = document.querySelectorAll('.add-first-btn');

  // Initialize App View
  render();

  // Event Listeners
  searchInput.addEventListener('input', () => {
    renderCustomerList();
  });

  openModalBtns.forEach(btn => {
    if (btn) btn.addEventListener('click', () => openCustomerModal());
  });

  closeModalBtn.addEventListener('click', closeCustomerModal);
  cancelModalBtn.addEventListener('click', closeCustomerModal);
  
  customerModal.addEventListener('click', (e) => {
    if (e.target === customerModal) closeCustomerModal();
  });

  closeDeleteModalBtn.addEventListener('click', closeDeleteModal);
  cancelDeleteBtn.addEventListener('click', closeDeleteModal);
  deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) closeDeleteModal();
  });

  addFirstBtns.forEach(btn => {
    btn.addEventListener('click', () => openCustomerModal());
  });

  customerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveCustomerFromForm();
  });

  confirmDeleteBtn.addEventListener('click', () => {
    if (currentDeleteId) {
      deleteCustomer(currentDeleteId);
    }
  });

  exportBtn.addEventListener('click', exportCSV);

  // Core Render Function
  function render() {
    renderMetrics();
    renderCustomerList();
  }

  function renderMetrics() {
    totalCustomersEl.textContent = customers.length;
    
    // Count added this month
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    
    const recentCount = customers.filter(c => {
      if (!c.createdAt) return false;
      const d = new Date(c.createdAt);
      return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    }).length;

    recentCustomersEl.textContent = recentCount;
  }

  function renderCustomerList() {
    const query = searchInput.value.trim().toLowerCase();
    
    // Filter customers
    const filtered = customers.filter(c => {
      const nameMatch = c.name && c.name.toLowerCase().includes(query);
      const emailMatch = c.email && c.email.toLowerCase().includes(query);
      return nameMatch || emailMatch;
    });

    customerListEl.innerHTML = '';

    // Handle states
    if (customers.length === 0) {
      tableContainerEl.classList.add('hidden');
      emptyStateEl.classList.remove('hidden');
      noResultsStateEl.classList.add('hidden');
      return;
    }

    if (filtered.length === 0) {
      tableContainerEl.classList.add('hidden');
      emptyStateEl.classList.add('hidden');
      noResultsStateEl.classList.remove('hidden');
      return;
    }

    tableContainerEl.classList.remove('hidden');
    emptyStateEl.classList.add('hidden');
    noResultsStateEl.classList.add('hidden');

    // Populate table rows
    filtered.forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="font-semibold">${escapeHTML(c.name)}</td>
        <td>${escapeHTML(c.email)}</td>
        <td>${escapeHTML(c.phone || '-')}</td>
        <td title="${escapeHTML(c.notes || '')}">${escapeHTML(truncate(c.notes, 30) || '-')}</td>
        <td class="text-right">
          <div class="action-buttons">
            <button class="btn-icon edit-btn" data-id="${c.id}" title="Edit customer">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="btn-icon delete-btn text-danger" data-id="${c.id}" title="Delete customer">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
          </div>
        </td>
      `;
      customerListEl.appendChild(tr);
    });

    // Attach row action listeners
    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        openCustomerModal(id);
      });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        openDeleteModal(id);
      });
    });
  }

  // CRUD Operations
  function openCustomerModal(id = null) {
    customerForm.reset();
    if (id) {
      modalTitle.textContent = 'Edit Customer Record';
      const customer = customers.find(c => c.id === id);
      if (customer) {
        customerIdInput.value = customer.id;
        customerNameInput.value = customer.name;
        customerEmailInput.value = customer.email;
        customerPhoneInput.value = customer.phone || '';
        customerNotesInput.value = customer.notes || '';
      }
    } else {
      modalTitle.textContent = 'Add New Customer';
      customerIdInput.value = '';
    }
    customerModal.classList.remove('hidden');
    customerNameInput.focus();
  }

  function closeCustomerModal() {
    customerModal.classList.add('hidden');
  }

  function saveCustomerFromForm() {
    const id = customerIdInput.value;
    const name = customerNameInput.value.trim();
    const email = customerEmailInput.value.trim();
    const phone = customerPhoneInput.value.trim();
    const notes = customerNotesInput.value.trim();

    if (!name || !email) {
      showToast('Please fill in all required fields.', 'error');
      return;
    }

    if (id) {
      // Edit existing
      customers = customers.map(c => {
        if (c.id === id) {
          return { ...c, name, email, phone, notes };
        }
        return c;
      });
      showToast('Customer updated successfully.', 'success');
    } else {
      // Create new
      const newCustomer = {
        id: 'cust-' + Date.now(),
        name,
        email,
        phone,
        notes,
        createdAt: new Date().toISOString()
      };
      customers.unshift(newCustomer);
      showToast('Customer added successfully.', 'success');
    }

    Storage.set('crm_customers', customers);
    closeCustomerModal();
    render();
  }

  function openDeleteModal(id) {
    const customer = customers.find(c => c.id === id);
    if (customer) {
      currentDeleteId = id;
      deleteCustomerNameEl.textContent = customer.name;
      deleteModal.classList.remove('hidden');
    }
  }

  function closeDeleteModal() {
    deleteModal.classList.add('hidden');
    currentDeleteId = null;
  }

  function deleteCustomer(id) {
    customers = customers.filter(c => c.id !== id);
    Storage.set('crm_customers', customers);
    closeDeleteModal();
    render();
    showToast('Customer record deleted.', 'success');
  }

  // Export CSV
  function exportCSV() {
    if (customers.length === 0) {
      showToast('No customer data to export.', 'error');
      return;
    }

    const headers = ['Name', 'Email', 'Phone', 'Notes', 'Created At'];
    const rows = customers.map(c => [
      `"${(c.name || '').replace(/"/g, '""')}"`,
      `"${(c.email || '').replace(/"/g, '""')}"`,
      `"${(c.phone || '').replace(/"/g, '""')}"`,
      `"${(c.notes || '').replace(/"/g, '""')}"`,
      `"${c.createdAt || ''}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `customers_export_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast('Customer list exported as CSV.', 'success');
  }

  // Utilities
  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
  }
});
