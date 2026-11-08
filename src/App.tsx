import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { onAuthStateChanged, signOut, type User as FirebaseUser } from '@firebase/auth';
import { TopBar } from './components/TopBar.tsx';
import { LoginView, WorkspaceSetupView } from './components/LoginView.tsx';
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
import { SEED_TENANTS } from './lib/sampleData.ts';
import { availabilityFromMap, type AvailabilityMap } from './lib/availabilitySource.ts';
import { Order, Product, Tenant, UserRole, WarehouseInventory, StockReservation, User, PendingBusinessWorkspace } from './lib/types.ts';
import { isTabPermitted, getSafeDefaultTab, TabId } from './lib/permissions.ts';
import { apiFetch, firebaseAuth } from './lib/firebaseClient.ts';
import { createSessionCoordinator, loadWorkspaceSession, type WorkspaceSession } from './lib/workspaceSession.ts';

export default function App() {
  const [currentTenant, setCurrentTenant] = useState<Tenant>(SEED_TENANTS[0]);
  const [dynamicUsers, setDynamicUsers] = useState<User[]>([]);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [pendingWorkspace, setPendingWorkspace] = useState<PendingBusinessWorkspace | null>(null);
  const [setupRequested, setSetupRequested] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const sessionScope = useRef(0);
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
    if (!currentUser || !workspaceReady) return;
    const scope = sessionScope.current;
    const identity = firebaseAuth?.currentUser;
    try {
      const [productsResponse, inventoryResponse] = await Promise.all([
        apiFetch('/api/products', {}, identity),
        apiFetch('/api/inventory', {}, identity),
      ]);
      const productData = await productsResponse.json().catch(() => ({}));
      const inventoryData = await inventoryResponse.json().catch(() => ({}));

      if (!productsResponse.ok || !Array.isArray(productData?.products)) {
        throw new Error(productData?.error || `Loading the catalogue failed (HTTP ${productsResponse.status}).`);
      }
      if (!inventoryResponse.ok || !inventoryData?.availability) {
        throw new Error(inventoryData?.error || `Loading stock levels failed (HTTP ${inventoryResponse.status}).`);
      }

      if (scope !== sessionScope.current) return;
      setProducts(productData.products);
      setAvailabilityMap(inventoryData.availability);
      // Staff receive per-warehouse rows and reservations; customers receive only
      // the summary, so these stay empty for them.
      setInventories(Array.isArray(inventoryData.inventories) ? inventoryData.inventories : []);
      setReservations(Array.isArray(inventoryData.reservations) ? inventoryData.reservations : []);
      hasLoggedInventoryError.current = false;
    } catch (error) {
      if (scope !== sessionScope.current) return;
      if (!hasLoggedInventoryError.current) {
        console.error('Inventory synchronization failed:', error);
        hasLoggedInventoryError.current = true;
      }
    }
  }, [currentUser, workspaceReady]);

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
    if (!currentUser || !workspaceReady) {
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

  const sessionCoordinator = useMemo(() => createSessionCoordinator<FirebaseUser, WorkspaceSession>(
    (identity) => loadWorkspaceSession(
      (path, init) => apiFetch(path, init, identity),
      import.meta.env.VITE_REQUIRE_EMAIL_VERIFIED === 'true'
    ),
    (session) => {
      sessionScope.current++;
      setProducts([]); setOrders([]); setAvailabilityMap({});
      setInventories([]); setReservations([]); setDynamicUsers([]);
      setOrderSyncStatus('loading'); setUserSyncStatus('loading');
      setSessionError(null);
      setCurrentUser(session?.user ?? null);
      setPendingWorkspace(session?.pendingWorkspace ?? null);
      setWorkspaceReady(Boolean(session?.tenant));
      if (session) {
        if (session.tenant) setCurrentTenant(session.tenant);
        setCurrentRole(session.user.role);
        setActiveTab(session.user.role === 'CUSTOMER' ? 'storefront' : 'overview');
        if (session.user.role !== 'CUSTOMER') setSetupRequested(false);
      } else {
        setSetupRequested(false); setSessionNotice(null);
      }
      setAuthReady(true);
    },
    (error) => {
      sessionScope.current++;
      setCurrentUser(null); setWorkspaceReady(false);
      setSessionError(error instanceof Error ? error.message : 'Could not load your workspace.');
      setAuthReady(true);
    },
    (identity) => {
      // Stop old workspace views and mirror responses before loading another account.
      sessionScope.current++;
      if (identity) setAuthReady(false);
    }
  ), []);

  const beginAuthOperation = () => {
    sessionCoordinator.suspend();
    sessionScope.current++;
  };
  const resumeSession = async (startBusiness = false, notice: string | null = null) => {
    if (startBusiness) setSetupRequested(true);
    setSessionNotice(notice);
    setSessionError(null);
    await sessionCoordinator.resume(firebaseAuth?.currentUser ?? null);
  };

  useEffect(() => {
    const auth = firebaseAuth;
    if (!auth) {
      setAuthReady(true);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (identity) => {
      void sessionCoordinator.restore(identity);
    });
    return () => { unsubscribe(); sessionCoordinator.invalidate(); sessionScope.current++; };
  }, [sessionCoordinator]);

  // Synchronize orders across WhatsApp webhooks and system UI in real time
  useEffect(() => {
    if (!currentUser || !workspaceReady) {
      setOrders([]);
      setOrderSyncStatus('loading');
      return;
    }
    let hasLoggedSyncError = false;
    let cancelled = false;
    const scope = sessionScope.current;
    const identity = firebaseAuth?.currentUser;
    const fetchSyncedOrders = async () => {
      try {
        const response = await apiFetch('/api/orders', {}, identity);
        if (!response.ok) {
          throw new Error(`Order sync failed with HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data?.orders)) {
          throw new Error('Order sync returned an invalid response.');
        }
        if (cancelled || scope !== sessionScope.current) return;
        setOrders(data.orders);
        setOrderSyncStatus('connected');
        hasLoggedSyncError = false;
      } catch (error) {
        if (cancelled || scope !== sessionScope.current) return;
        setOrderSyncStatus('error');
        if (!hasLoggedSyncError) {
          console.error('Order synchronization failed:', error);
          hasLoggedSyncError = true;
        }
      }
    };

    fetchSyncedOrders();
    const syncInterval = setInterval(fetchSyncedOrders, 3000);
    return () => { cancelled = true; clearInterval(syncInterval); };
  }, [currentUser, workspaceReady]);

  const fetchSyncedUsers = async () => {
    if (!currentUser || !workspaceReady || !['BUSINESS_OWNER', 'SUPER_ADMIN'].includes(currentRole)) return;
    const scope = sessionScope.current;
    const identity = firebaseAuth?.currentUser;
    try {
      const response = await apiFetch('/api/users', {}, identity);
      const data = await response.json();
      if (!response.ok || !Array.isArray(data?.users)) {
        throw new Error(data?.error || `Could not load customer accounts (HTTP ${response.status}).`);
      }
      if (scope !== sessionScope.current) return;
      setDynamicUsers(data.users);
      setUserSyncStatus('connected');
    } catch (error) {
      if (scope !== sessionScope.current) return;
      setDynamicUsers([]);
      setUserSyncStatus('error');
      throw error;
    }
  };

  useEffect(() => {
    if (!currentUser || !workspaceReady || !['BUSINESS_OWNER', 'SUPER_ADMIN'].includes(currentRole)) return;
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
  }, [currentUser, currentRole, workspaceReady]);

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

  const handleLogout = async () => {
    beginAuthOperation();
    setAuthMode('signin');
    try {
      if (firebaseAuth) await signOut(firebaseAuth);
    } finally {
      await resumeSession();
    }
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

  if (sessionError && firebaseAuth?.currentUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-lg rounded-2xl border bg-white p-6 space-y-4">
          <h1 className="text-xl font-bold">Workspace could not be loaded</h1>
          <p role="alert">{sessionError}</p>
          <button onClick={() => void resumeSession()} className="px-4 py-2 bg-slate-900 text-white rounded-lg">Retry</button>
          <button onClick={() => void handleLogout()} className="px-4 py-2">Sign out</button>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginView onAuthOperationStart={beginAuthOperation} onAuthOperationEnd={resumeSession} initialMode={authMode} />;
  }

  if (!workspaceReady || setupRequested) {
    return <WorkspaceSetupView
      user={currentUser} pendingWorkspace={pendingWorkspace} notice={sessionNotice}
      businessSetup={Boolean(setupRequested || pendingWorkspace)}
      onAuthOperationStart={beginAuthOperation} onAuthOperationEnd={resumeSession}
      onLogout={handleLogout}
      onCancel={workspaceReady && !pendingWorkspace ? () => setSetupRequested(false) : undefined}
    />;
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

      {currentRole === 'CUSTOMER' && (
        <div className="bg-white border-b px-6 py-3 text-sm flex items-center justify-between">
          <span>Want to sell with your own workspace?</span>
          <button onClick={() => setSetupRequested(true)} className="font-semibold text-emerald-700">Create business workspace</button>
        </div>
      )}

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
                  key={`${currentUser.id}:${currentTenant.id}`}
                  canManageSharedWhatsApp={currentUser.canManageSharedWhatsApp === true}
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
                      key={`${currentUser.id}:${currentTenant.id}`}
                      tenant={currentTenant}
                    />
                  )}
                  renderWhatsAppView={() => (
                    <WhatsAppChannelView
                      canManageSharedWhatsApp={currentUser.canManageSharedWhatsApp === true}
                      tenant={currentTenant}
                      products={products}
                      orders={orders}
                      onOrderCreated={handleCustomerOrderCreated}
                      onNavigateToOrder={() => handleSelectTab('orders')}
                    />
                  )}
                  renderSupportView={() => (
                    <CustomerSupportWorkspaceView
                      key={`${currentUser.id}:${currentTenant.id}`}
                      canManageSharedWhatsApp={currentUser.canManageSharedWhatsApp === true}
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
                canManageSharedWhatsApp={currentUser.canManageSharedWhatsApp === true}
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
                key={`${currentUser.id}:${currentTenant.id}`}
                canManageSharedWhatsApp={currentUser.canManageSharedWhatsApp === true}
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
            <span>Shop invoices, not KRA fiscal receipts</span>
            <span aria-hidden="true">·</span>
            <span>M-PESA STK Push when Daraja is configured</span>
            <span aria-hidden="true">·</span>
            <span>Web storefront and WhatsApp channel</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
