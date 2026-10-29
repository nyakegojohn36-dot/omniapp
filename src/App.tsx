import React, { useState, useMemo, useEffect } from 'react';
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
  SEED_INVENTORIES,
  SEED_ORDERS,
  SEED_PRODUCTS,
  SEED_TENANTS,
  SEED_USERS,
} from './lib/sampleData.ts';
import { InventoryStore } from './lib/inventoryEngine.ts';
import { Order, Product, Tenant, UserRole, WarehouseInventory, StockReservation, User } from './lib/types.ts';
import { isTabPermitted, getSafeDefaultTab, TabId } from './lib/permissions.ts';
import { getDynamicUsers, updateUserRole } from './lib/userStore.ts';

export default function App() {
  const [tenants] = useState<Tenant[]>(SEED_TENANTS);
  const [currentTenant, setCurrentTenant] = useState<Tenant>(SEED_TENANTS[0]);
  const [dynamicUsers, setDynamicUsers] = useState<User[]>(() => getDynamicUsers());
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentRole, setCurrentRole] = useState<UserRole>('CUSTOMER');
  const [activeTab, setActiveTab] = useState<string>('storefront');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [isConcurrencyModalOpen, setIsConcurrencyModalOpen] = useState<boolean>(false);
  const [orderSyncStatus, setOrderSyncStatus] = useState<'loading' | 'connected' | 'error'>('loading');

  // Core State Stores
  const inventoryEngine = useMemo(() => new InventoryStore(SEED_INVENTORIES), []);
  const [products, setProducts] = useState<Product[]>(SEED_PRODUCTS);
  const [orders, setOrders] = useState<Order[]>(SEED_ORDERS);
  const [inventories, setInventories] = useState<WarehouseInventory[]>(() =>
    inventoryEngine.getAllInventories()
  );
  const [reservations, setReservations] = useState<StockReservation[]>([
    {
      id: 'res-seed-008',
      tenantId: 'tenant-nordic',
      orderId: 'ORD-000008',
      sku: 'TSHIRT001',
      warehouseId: 'WH-MAIN-US',
      quantity: 2,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    },
  ]);

  const refreshInventories = () => {
    setInventories(inventoryEngine.getAllInventories());
    setReservations(inventoryEngine.getAllReservations());
  };

  // Synchronize orders across WhatsApp webhooks and system UI in real time
  useEffect(() => {
    let hasLoggedSyncError = false;
    const fetchSyncedOrders = async () => {
      try {
        const response = await fetch('/api/orders');
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
  }, []);

  const handleRoleChange = (newRole: UserRole) => {
    setCurrentRole(newRole);
    if (!isTabPermitted(newRole, activeTab as TabId)) {
      setActiveTab(getSafeDefaultTab(newRole, activeTab as TabId));
    }
  };

  const handleSelectTab = (tab: string) => {
    if (isTabPermitted(currentRole, tab as TabId)) {
      setActiveTab(tab);
    } else {
      setActiveTab(getSafeDefaultTab(currentRole, tab as TabId));
    }
  };

  const handleCustomerOrderCreated = (newOrder: Order) => {
    setOrders((prev) => [newOrder, ...prev.filter((o) => o.id !== newOrder.id)]);
    refreshInventories();
    fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newOrder),
    }).catch(() => {});
  };

  // Add Product Handler (Business Owner / Store Admin only)
  const handleAddProduct = (newProduct: Product, initialStockUS: number, initialStockEU: number) => {
    setProducts((prev) => [newProduct, ...prev]);

    const usInv: WarehouseInventory = {
      sku: newProduct.sku,
      warehouseId: 'WH-MAIN-US',
      warehouseName: 'Main US Distribution Center (Chicago)',
      physicalStock: initialStockUS,
      reservedStock: 0,
      quarantineStock: 0,
      lowStockThreshold: 5,
      lastReconciledAt: new Date().toISOString(),
    };

    const euInv: WarehouseInventory = {
      sku: newProduct.sku,
      warehouseId: 'WH-MAIN-EU',
      warehouseName: 'European Regional Hub (Frankfurt)',
      physicalStock: initialStockEU,
      reservedStock: 0,
      quarantineStock: 0,
      lowStockThreshold: 5,
      lastReconciledAt: new Date().toISOString(),
    };

    inventoryEngine.addWarehouseInventory(usInv);
    inventoryEngine.addWarehouseInventory(euInv);
    refreshInventories();
  };

  // Stock Adjustment Handler
  const handleAdjustStock = (
    sku: string,
    warehouseId: string,
    deltaPhysical: number,
    quarantineDelta: number,
    reason: string
  ) => {
    inventoryEngine.recordAdjustment(sku, warehouseId, deltaPhysical, quarantineDelta, reason);
    refreshInventories();
  };

  // Reservation Trigger Handler
  const handleTriggerReservation = (sku: string, qty: number) => {
    const res = inventoryEngine.reserveStock({
      tenantId: currentTenant.id,
      orderId: `ORD-${Date.now()}`,
      sku,
      quantity: qty,
      ttlMinutes: currentTenant.reservationTTLMinutes,
    });
    refreshInventories();
    if (res.success && res.reservation) {
      setReservations((prev) => [res.reservation!, ...prev]);
    }
  };

  // Commit Reservation Handler
  const handleCommitReservation = (reservationId: string) => {
    inventoryEngine.commitReservation(reservationId);
    refreshInventories();
  };

  // Cancel/Release Reservation Handler
  const handleCancelReservation = (reservationId: string) => {
    inventoryEngine.cancelReservation(reservationId);
    refreshInventories();
  };

  // Sweep Expired Reservations
  const handleSweepExpired = () => {
    const released = inventoryEngine.cleanExpiredReservations();
    refreshInventories();
  };

  // Order Update Handler
  const handleUpdateOrder = (updatedOrder: Order) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === updatedOrder.id ? updatedOrder : o))
    );

    // Sync order updates with backend
    fetch(`/api/orders/${updatedOrder.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedOrder),
    }).catch(() => {});

    // If order was confirmed, commit its stock reservation
    if (updatedOrder.status === 'CONFIRMED' && updatedOrder.reservationId) {
      handleCommitReservation(updatedOrder.reservationId);
    }
  };

  // Webhook Paid Handler
  const handleOrderPaid = (orderId: string, transactionRef: string) => {
    setOrders((prev) =>
      prev.map((o) => {
        if (o.id === orderId) {
          return {
            ...o,
            status: 'CONFIRMED',
            isPaid: true,
            paymentTransactionRef: transactionRef,
            auditTrail: [
              ...o.auditTrail,
              {
                id: `aud-${Date.now()}`,
                timestamp: new Date().toISOString(),
                fromStatus: o.status,
                toStatus: 'CONFIRMED',
                actor: 'stripe-webhook',
                actorRole: 'SYSTEM',
                reason: `Payment confirmed via webhook (${transactionRef}). Stock reservation committed.`,
              },
            ],
          };
        }
        return o;
      })
    );

    // Commit reservation for ORD-000008
    handleCommitReservation('res-seed-008');
  };

  const handleLogin = (user: User) => {
    setCurrentUser(user);
    setCurrentRole(user.role);
    if (user.role === 'CUSTOMER') {
      setActiveTab('storefront');
    } else {
      setActiveTab('overview');
    }
  };

  const handleLogout = () => {
    setAuthMode('signin');
    setCurrentUser(null);
  };

  const handleOpenSignUp = () => {
    setAuthMode('signup');
    setCurrentUser(null);
  };

  const handleUpdateUserRole = (targetUserId: string, newRole: UserRole, reason?: string) => {
    if (!currentUser) return;
    const res = updateUserRole(currentUser, targetUserId, newRole, reason);
    if (res.success) {
      const refreshed = getDynamicUsers();
      setDynamicUsers(refreshed);
      if (currentUser.id === targetUserId) {
        setCurrentUser((prev) => (prev ? { ...prev, role: newRole } : null));
        setCurrentRole(newRole);
      }
    }
  };

  const handleSignUpSuccess = (newUser: User) => {
    setDynamicUsers(getDynamicUsers());
    handleLogin(newUser);
  };

  if (!currentUser) {
    return (
      <LoginView
        tenants={tenants}
        currentTenant={currentTenant}
        onSelectTenant={setCurrentTenant}
        onLogin={handleLogin}
        dynamicUsers={dynamicUsers}
        onSignUpSuccess={handleSignUpSuccess}
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
                inventories={inventories}
                inventoryEngine={inventoryEngine}
                existingOrdersCount={orders.length}
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
                  onUpdateUserRole={handleUpdateUserRole}
                  onSwitchUser={handleLogin}
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
                      inventoryEngine={inventoryEngine}
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
                inventoryEngine={inventoryEngine}
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
        inventoryEngine={inventoryEngine}
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
