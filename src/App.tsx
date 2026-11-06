import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { onAuthStateChanged, signOut } from '@firebase/auth';
import { TopBar } from './components/TopBar.tsx';
import { LoginView } from './components/LoginView.tsx';
import { OverviewDashboard } from './components/OverviewDashboard.tsx';
import { CustomerStorefrontView } from './components/CustomerStorefrontView.tsx';
import { InventoryCatalogView } from './components/InventoryCatalogView.tsx';
import { OrderStateMachineView } from './components/OrderStateMachineView.tsx';
import { AiAssistantView } from './components/AiAssistantView.tsx';
import { WhatsAppChannelView } from './components/WhatsAppChannelView.tsx';
import { ConversationalSalesView } from './components/ConversationalSalesView.tsx';
import { AutomationHubView } from './components/AutomationHubView.tsx';
import { ConcurrencySimulator } from './components/ConcurrencySimulator.tsx';
import { FulfillmentWorkspaceView } from './components/FulfillmentWorkspaceView.tsx';
import { CustomerSupportWorkspaceView } from './components/CustomerSupportWorkspaceView.tsx';
import { BusinessOwnerWorkspace } from './components/BusinessOwnerWorkspace.tsx';
import { EmbeddedWhatsAppWidget } from './components/EmbeddedWhatsAppWidget.tsx';
import { ShieldAlert } from 'lucide-react';
import {
  SEED_CUSTOMER_PROFILES,
  SEED_TENANTS,
  SEED_USERS,
} from './lib/sampleData.ts';
import { availabilityFromMap, type AvailabilityMap } from './lib/availabilitySource.ts';
import { Order, Product, Tenant, UserRole, WarehouseInventory, StockReservation, User } from './lib/types.ts';
import { isTabPermitted, getSafeDefaultTab, TabId } from './lib/permissions.ts';
import { apiFetch, firebaseAuth } from './lib/firebaseClient.ts';

const INITIAL_WORKSPACE_USERS: User[] = [
  ...SEED_USERS,
  ...SEED_CUSTOMER_PROFILES
    .filter((c) => !SEED_USERS.some((u) => u.email === c.email))
    .map((c) => ({
      id: c.id,
      tenantId: 'tenant-nordic',
      name: c.name,
      email: c.email,
      role: 'CUSTOMER' as UserRole,
    })),
];

export default function App() {
  const [tenants] = useState<Tenant[]>(SEED_TENANTS);
  const [currentTenant, setCurrentTenant] = useState<Tenant>(SEED_TENANTS[0]);
  const [dynamicUsers, setDynamicUsers] = useState<User[]>(INITIAL_WORKSPACE_USERS);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [currentRole, setCurrentRole] = useState<UserRole>('CUSTOMER');
  const [userSyncStatus, setUserSyncStatus] = useState<'loading' | 'connected' | 'error'>('loading');
  const [activeTab, setActiveTab] = useState<string>('storefront');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [isConcurrencyModalOpen, setIsConcurrencyModalOpen] = useState<boolean>(false);
  const [orderSyncStatus, setOrderSyncStatus] = useState<'loading' | 'connected' | 'error'>('loading');

  // Everything below is a mirror of server state, kept only so the views can
  // render. Nothing here decides whether a sale may proceed: checkout asks the
  // server to reserve, and the mirrors are refreshed from the answer.
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [availabilityMap, setAvailabilityMap] = useState<AvailabilityMap>({});
  const [inventories, setInventories] = useState<WarehouseInventory[]>([]);
  const [reservations, setReservations] = useState<StockReservation[]>([]);

  const availability = useMemo(() => availabilityFromMap(availabilityMap), [availabilityMap]);
  const hasLoggedInventoryError = useRef(false);

  const refreshInventory = useCallback(async () => {
    if (!currentUser) return;
    try {
      const [productsResponse, inventoryResponse] = await Promise.all([
        apiFetch('/api/products'),
        apiFetch('/api/inventory'),
      ]);
      const productData = await productsResponse.json().catch(() => ({}));
      const inventoryData = await inventoryResponse.json().catch(() => ({}));

      if (!productsResponse.ok || !Array.isArray(productData?.products)) {
        throw new Error(productData?.error || `Loading the catalogue failed (HTTP ${productsResponse.status}).`);
      }
      if (!inventoryResponse.ok || !inventoryData?.availability) {
        throw new Error(inventoryData?.error || `Loading stock levels failed (HTTP ${inventoryResponse.status}).`);
      }

      setProducts(productData.products);
      setAvailabilityMap(inventoryData.availability);
      // Staff receive per-warehouse rows and reservations; customers receive only
      // the summary, so these stay empty for them.
      setInventories(Array.isArray(inventoryData.inventories) ? inventoryData.inventories : []);
      setReservations(Array.isArray(inventoryData.reservations) ? inventoryData.reservations : []);
      hasLoggedInventoryError.current = false;
    } catch (error) {
      if (!hasLoggedInventoryError.current) {
        console.error('Inventory synchronization failed:', error);
        hasLoggedInventoryError.current = true;
      }
    }
  }, [currentUser]);

  /** Posts a stock command, logs a rejection, and lets the caller refresh. */
  const stockAction = useCallback(async (path: string, body: unknown) => {
    const response = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error || `The stock update was rejected (HTTP ${response.status}).`;
      console.error(`Stock action ${path} failed:`, message);
      throw new Error(message);
    }
    return data;
  }, []);

  useEffect(() => {
    if (!currentUser) {
      setProducts([]);
      setAvailabilityMap({});
      setInventories([]);
      setReservations([]);
      return;
    }
    void refreshInventory();
    const syncInterval = setInterval(() => void refreshInventory(), 3000);
    return () => clearInterval(syncInterval);
  }, [currentUser?.id, refreshInventory]);

  useEffect(() => {
    const auth = firebaseAuth;
    if (!auth) {
      setAuthReady(true);
      return;
    }

    return onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setCurrentUser(null);
        setAuthReady(true);
        return;
      }
      if (!firebaseUser.emailVerified && import.meta.env.VITE_REQUIRE_EMAIL_VERIFIED === 'true') {
        setCurrentUser(null);
        setAuthReady(true);
        return;
      }

      try {
        const response = await apiFetch('/api/auth/me', {}, firebaseUser);
        const data = await response.json();
        if (!response.ok || !data?.user) {
          throw new Error(data?.error || `Could not restore sign-in (HTTP ${response.status}).`);
        }
        const user = data.user as User;
        const tenant = tenants.find((item) => item.id === user.tenantId);
        if (tenant) setCurrentTenant(tenant);
        setCurrentUser(user);
        setCurrentRole(user.role);
        setActiveTab(user.role === 'CUSTOMER' ? 'storefront' : 'overview');
      } catch (error) {
        console.error('Restoring Firebase sign-in failed:', error);
        await signOut(auth);
      } finally {
        setAuthReady(true);
      }
    });
  }, [tenants]);

  // Synchronize orders across WhatsApp webhooks and system UI in real time
  useEffect(() => {
    if (!currentUser) {
      setOrders([]);
      setOrderSyncStatus('loading');
      return;
    }
    let hasLoggedSyncError = false;
    const fetchSyncedOrders = async () => {
      try {
        const response = await apiFetch('/api/orders');
        if (!response.ok) {
          throw new Error(`Order sync failed with HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data?.orders)) {
          throw new Error('Order sync returned an invalid response.');
        }
        setOrders(data.orders);
        setOrderSyncStatus('connected');
        hasLoggedSyncError = false;
      } catch (error) {
        setOrderSyncStatus('error');
        if (!hasLoggedSyncError) {
          console.error('Order synchronization failed:', error);
          hasLoggedSyncError = true;
        }
      }
    };

    fetchSyncedOrders();
    const syncInterval = setInterval(fetchSyncedOrders, 3000);
    return () => clearInterval(syncInterval);
  }, [currentUser?.id]);

  const fetchSyncedUsers = async () => {
    if (!currentUser || !['BUSINESS_OWNER', 'SUPER_ADMIN'].includes(currentRole)) return;
    try {
      const response = await apiFetch('/api/users');
      const data = await response.json();
      if (!response.ok || !Array.isArray(data?.users)) {
        throw new Error(data?.error || `Could not load customer accounts (HTTP ${response.status}).`);
      }
      setDynamicUsers(data.users);
      setUserSyncStatus('connected');
    } catch (error) {
      setDynamicUsers([]);
      setUserSyncStatus('error');
      throw error;
    }
  };

  useEffect(() => {
    if (!currentUser || !['BUSINESS_OWNER', 'SUPER_ADMIN'].includes(currentRole)) return;
    setUserSyncStatus('loading');
    let hasLoggedSyncError = false;
    const syncUsers = () => {
      fetchSyncedUsers().catch((error) => {
        if (!hasLoggedSyncError) {
          console.error('Loading customer accounts failed:', error);
          hasLoggedSyncError = true;
        }
      });
    };
    syncUsers();
    const userInterval = setInterval(syncUsers, 3000);
    return () => clearInterval(userInterval);
  }, [currentUser?.id, currentRole]);

  const handleAddCustomer = async (customerData: { name: string; email: string; role?: UserRole }) => {
    if (!currentUser) return;
    const response = await apiFetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customerData),
    });
    const data = await response.json();
    if (!response.ok || !data?.user) {
      throw new Error(data?.error || `Could not create customer (HTTP ${response.status}).`);
    }
    setDynamicUsers((prev) => [data.user, ...prev.filter((u) => u.id !== data.user.id)]);
    return data.user as User;
  };

  const handleSelectTab = (tab: string) => {
    if (isTabPermitted(currentRole, tab as TabId)) {
      setActiveTab(tab);
    } else {
      setActiveTab(getSafeDefaultTab(currentRole, tab as TabId));
    }
  };

  const handleCustomerOrderCreated = (newOrder: Order) => {
    // The order already exists server-side; adopt the authoritative copy and pull
    // the stock levels the reservation changed.
    setOrders((prev) => [newOrder, ...prev.filter((o) => o.id !== newOrder.id)]);
    void refreshInventory();
  };

  // Add Product Handler (Business Owner / Store Admin only)
  const handleAddProduct = (newProduct: Product, initialStockUS: number, initialStockEU: number) => {
    void stockAction('/api/products', {
      product: newProduct,
      inventory: [
        {
          warehouseId: 'WH-MAIN-US',
          warehouseName: 'Main US Distribution Center (Chicago)',
          physicalStock: initialStockUS,
          lowStockThreshold: 5,
        },
        {
          warehouseId: 'WH-MAIN-EU',
          warehouseName: 'European Regional Hub (Frankfurt)',
          physicalStock: initialStockEU,
          lowStockThreshold: 5,
        },
      ],
    })
      .then(refreshInventory)
      .catch(() => undefined);
  };

  // Stock Adjustment Handler
  const handleAdjustStock = (
    sku: string,
    warehouseId: string,
    deltaPhysical: number,
    quarantineDelta: number,
    reason: string
  ) => {
    void stockAction('/api/inventory/adjust', {
      sku,
      warehouseId,
      physicalDelta: deltaPhysical,
      quarantineDelta,
      reason,
    })
      .then(refreshInventory)
      .catch(() => undefined);
  };

  // Reservation Trigger Handler
  const handleTriggerReservation = (sku: string, qty: number) => {
    void stockAction('/api/inventory/reserve', {
      sku,
      quantity: qty,
      orderId: `MANUAL-${Date.now()}`,
    })
      .then(refreshInventory)
      .catch(() => undefined);
  };

  // Commit Reservation Handler
  const handleCommitReservation = (reservationId: string) => {
    void stockAction(
      `/api/inventory/reservations/${encodeURIComponent(reservationId)}/commit`,
      {}
    )
      .then(refreshInventory)
      .catch(() => undefined);
  };

  // Cancel/Release Reservation Handler
  const handleCancelReservation = (reservationId: string) => {
    void stockAction(
      `/api/inventory/reservations/${encodeURIComponent(reservationId)}/cancel`,
      {}
    )
      .then(refreshInventory)
      .catch(() => undefined);
  };

  // Sweep Expired Reservations
  const handleSweepExpired = () => {
    void stockAction('/api/inventory/sweep', {})
      .then(refreshInventory)
      .catch(() => undefined);
  };

  // Order Update Handler
  const handleUpdateOrder = (updatedOrder: Order) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === updatedOrder.id ? updatedOrder : o))
    );

    // Only the fields the server accepts. Status changes run through the order
    // state machine there, which also commits or releases the reservations.
    apiFetch(`/api/orders/${encodeURIComponent(updatedOrder.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: updatedOrder.status,
        trackingNumber: updatedOrder.trackingNumber,
        shippingCarrier: updatedOrder.shippingCarrier,
        notes: updatedOrder.notes,
      }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data?.error || `Updating the order failed (HTTP ${response.status}).`);
        }
        if (data?.order) {
          setOrders((prev) => prev.map((o) => (o.id === data.order.id ? data.order : o)));
        }
        await refreshInventory();
      })
      .catch((error) => console.error('Updating the order failed:', error));
  };

  // Webhook Paid Handler
  const handleOrderPaid = (orderId: string, transactionRef: string) => {
    apiFetch(`/api/orders/${encodeURIComponent(orderId)}/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionRef }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data?.error || `Confirming payment failed (HTTP ${response.status}).`);
        }
        if (data?.order) {
          setOrders((prev) => prev.map((o) => (o.id === data.order.id ? data.order : o)));
        }
        await refreshInventory();
      })
      .catch((error) => console.error('Confirming payment failed:', error));
  };

  const handleLogin = (user: User) => {
    setCurrentUser(user);
    setCurrentRole(user.role);
    const tenant = tenants.find((item) => item.id === user.tenantId);
    if (tenant) setCurrentTenant(tenant);
    if (user.role === 'CUSTOMER') {
      setActiveTab('storefront');
    } else {
      setActiveTab('overview');
    }
  };

  const handleLogout = async () => {
    setAuthMode('signin');
    if (firebaseAuth) await signOut(firebaseAuth);
  };

  const handleOpenSignUp = () => {
    setAuthMode('signup');
  };

  const handleUpdateUserRole = async (targetUserId: string, newRole: UserRole, reason?: string) => {
    if (!currentUser) throw new Error('Sign in before changing account roles.');
    const response = await apiFetch(`/api/users/${encodeURIComponent(targetUserId)}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole, reason }),
    });
    const data = await response.json();
    if (!response.ok || !data?.user) {
      throw new Error(data?.error || `Could not update role (HTTP ${response.status}).`);
    }
    setDynamicUsers((users) => users.map((user) => (user.id === data.user.id ? data.user : user)));
  };

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-600">
        Restoring secure sign-in...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginView
        tenants={tenants}
        currentTenant={currentTenant}
        onSelectTenant={setCurrentTenant}
        onLogin={handleLogin}
        initialMode={authMode}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
      {/* 3-Zone Top Navigation Bar */}
      <TopBar
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        currentTenant={currentTenant}
        currentRole={currentRole}
        currentUser={currentUser}
        onLogout={handleLogout}
        onOpenConcurrencyModal={() => setIsConcurrencyModalOpen(true)}
      />

      {/* Main Content Area */}
      <main className={`flex-1 w-full ${currentRole === 'BUSINESS_OWNER' && activeTab === 'overview' ? '' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8'}`}>
        {!isTabPermitted(currentRole, activeTab as TabId) ? (
          <div className="p-8 bg-white border border-slate-200 rounded-2xl text-center space-y-4 max-w-lg mx-auto my-12 shadow-xs">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto text-slate-500">
              <ShieldAlert className="w-6 h-6 text-slate-700" />
            </div>
            <h2 className="text-lg font-bold text-slate-900">Access Restricted</h2>
            <p className="text-xs text-slate-600">
              The Customer persona only has access to the Storefront & Cart and Inventory & Catalog.
            </p>
            <button
              onClick={() => handleSelectTab('storefront')}
              className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800"
            >
              Return to Storefront & Cart
            </button>
          </div>
        ) : (
          <>
            {activeTab === 'storefront' && (
              <CustomerStorefrontView
                tenant={currentTenant}
                products={products}
                availability={availability}
                orders={orders}
                currentUser={currentUser}
                currentRole={currentRole}
                onOrderCreated={handleCustomerOrderCreated}
                onNavigateTab={handleSelectTab}
              />
            )}

            {activeTab === 'overview' && (
              currentRole === 'FULFILLMENT_STAFF' ? (
                <FulfillmentWorkspaceView
                  tenant={currentTenant}
                  orders={orders}
                  inventories={inventories}
                  currentRole={currentRole}
                  onUpdateOrder={handleUpdateOrder}
                />
              ) : currentRole === 'SUPPORT_STAFF' ? (
                <CustomerSupportWorkspaceView
                  tenant={currentTenant}
                  orders={orders}
                  products={products}
                  inventories={inventories}
                  currentRole={currentRole}
                  onUpdateOrder={handleUpdateOrder}
                />
              ) : (
                <BusinessOwnerWorkspace
                  tenant={currentTenant}
                  orders={orders}
                  products={products}
                  inventories={inventories}
                  activeReservationsCount={reservations.filter((r) => r.status === 'ACTIVE').length}
                  currentUser={currentUser}
                  orderSyncStatus={orderSyncStatus}
                  users={dynamicUsers}
                  userSyncStatus={userSyncStatus}
                  onUpdateUserRole={handleUpdateUserRole}
                  onAddCustomer={handleAddCustomer}
                  onRefreshUsers={fetchSyncedUsers}
                  onNavigateTab={handleSelectTab}
                  onSweepExpired={handleSweepExpired}
                  onOpenConcurrencyModal={() => setIsConcurrencyModalOpen(true)}
                  onUpdateOrder={handleUpdateOrder}
                  renderOrderStateMachine={() => (
                    <OrderStateMachineView
                      tenant={currentTenant}
                      orders={orders}
                      currentRole={currentRole}
                      onUpdateOrder={handleUpdateOrder}
                    />
                  )}
                  renderInventoryCatalog={() => (
                    <InventoryCatalogView
                      tenant={currentTenant}
                      products={products}
                      inventories={inventories}
                      reservations={reservations}
                      currentRole={currentRole}
                      onNavigateToStorefront={() => handleSelectTab('storefront')}
                      onAdjustStock={handleAdjustStock}
                      onCancelReservation={handleCancelReservation}
                      onCommitReservation={handleCommitReservation}
                      onTriggerReservation={handleTriggerReservation}
                      onAddProduct={handleAddProduct}
                    />
                  )}
                  renderFulfillmentView={() => (
                    <FulfillmentWorkspaceView
                      tenant={currentTenant}
                      orders={orders}
                      inventories={inventories}
                      currentRole={currentRole}
                      onUpdateOrder={handleUpdateOrder}
                    />
                  )}
                  renderAutomationView={() => (
                    <AutomationHubView
                      tenant={currentTenant}
                      orders={orders}
                      onOrderPaid={handleOrderPaid}
                    />
                  )}
                  renderAiAssistantView={() => (
                    <AiAssistantView
                      tenant={currentTenant}
                      products={products}
                      inventories={inventories}
                      orders={orders}
                    />
                  )}
                  renderWhatsAppView={() => (
                    <WhatsAppChannelView
                      tenant={currentTenant}
                      products={products}
                      orders={orders}
                      onOrderCreated={handleCustomerOrderCreated}
                      onNavigateToOrder={() => handleSelectTab('orders')}
                    />
                  )}
                  renderSupportView={() => (
                    <CustomerSupportWorkspaceView
                      tenant={currentTenant}
                      orders={orders}
                      products={products}
                      inventories={inventories}
                      currentRole={currentRole}
                      onUpdateOrder={handleUpdateOrder}
                    />
                  )}
                />
              )
            )}

            {activeTab === 'inventory' && (
              <InventoryCatalogView
                tenant={currentTenant}
                products={products}
                inventories={inventories}
                reservations={reservations}
                currentRole={currentRole}
                onNavigateToStorefront={() => handleSelectTab('storefront')}
                onAdjustStock={handleAdjustStock}
                onCancelReservation={handleCancelReservation}
                onCommitReservation={handleCommitReservation}
                onTriggerReservation={handleTriggerReservation}
                onAddProduct={handleAddProduct}
              />
            )}

            {activeTab === 'orders' && (
              <OrderStateMachineView
                tenant={currentTenant}
                orders={orders}
                currentRole={currentRole}
                onUpdateOrder={handleUpdateOrder}
              />
            )}

            {(activeTab === 'ai-sales' || activeTab === 'ai-assistant' || activeTab === 'whatsapp') && (
              <ConversationalSalesView
                tenant={currentTenant}
                products={products}
                inventories={inventories}
                orders={orders}
                initialSubTab={activeTab === 'whatsapp' ? 'whatsapp' : 'assistant'}
                onOrderCreated={handleCustomerOrderCreated}
                onNavigateToOrder={() => handleSelectTab('orders')}
                onNavigateToSupport={() => handleSelectTab('support')}
              />
            )}

            {activeTab === 'support' && (
              <CustomerSupportWorkspaceView
                tenant={currentTenant}
                orders={orders}
                products={products}
                inventories={inventories}
                currentRole={currentRole}
                onUpdateOrder={handleUpdateOrder}
              />
            )}

            {activeTab === 'automation' && (
              <AutomationHubView
                tenant={currentTenant}
                orders={orders}
                onOrderPaid={handleOrderPaid}
              />
            )}
          </>
        )}
      </main>

      {/* Concurrency Simulator Modal */}
      <ConcurrencySimulator
        isOpen={isConcurrencyModalOpen}
        onClose={() => setIsConcurrencyModalOpen(false)}
      />

      {/* Embedded WhatsApp Floating Chat Widget */}
      <EmbeddedWhatsAppWidget
        tenant={currentTenant}
        products={products}
        inventories={inventories}
        displayPhoneNumber="+254 752 720933"
        onOrderCreated={handleCustomerOrderCreated}
        onNavigateTab={handleSelectTab}
      />

      {/* Quiet Footer */}
      <footer className="border-t border-slate-200 bg-white py-4 px-4 sm:px-6 lg:px-8 text-xs text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>&copy; 2026 SokoFlow · Every order. Every channel. One clear view.</span>
          <div className="flex items-center gap-3">
            <span>KRA eTIMS Tax Compliant (16% VAT)</span>
            <span aria-hidden="true">·</span>
            <span>Daraja M-PESA STK Push</span>
            <span aria-hidden="true">·</span>
            <span>Nairobi & Mombasa Fulfillment Hubs</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
