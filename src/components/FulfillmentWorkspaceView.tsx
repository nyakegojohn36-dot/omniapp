import React, { useState } from 'react';
import {
  Package,
  Truck,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Barcode,
  Search,
  Filter,
  ArrowRight,
  ShieldAlert,
  Building,
  Printer,
  CheckSquare,
  Square,
  ExternalLink,
  ChevronRight,
  RefreshCw,
  Box,
} from 'lucide-react';
import { FulfillmentTask, Order, Tenant, UserRole, WarehouseInventory } from '../lib/types.ts';
import { SEED_FULFILLMENT_TASKS } from '../lib/sampleData.ts';
import { formatCurrency } from '../lib/pricingEngine.ts';

interface FulfillmentWorkspaceViewProps {
  tenant: Tenant;
  orders: Order[];
  inventories: WarehouseInventory[];
  currentRole: UserRole;
  onUpdateOrder?: (order: Order) => void;
}

export const FulfillmentWorkspaceView: React.FC<FulfillmentWorkspaceViewProps> = ({
  tenant,
  orders,
  inventories,
  currentRole,
  onUpdateOrder,
}) => {
  const [tasks, setTasks] = useState<FulfillmentTask[]>(SEED_FULFILLMENT_TASKS);
  const [activeStageFilter, setActiveStageFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>('ALL');
  const [activeTask, setActiveTask] = useState<FulfillmentTask | null>(tasks[0] || null);

  // Interactive Checklist and Barcode Verification State
  const [scannedBarcode, setScannedBarcode] = useState<string>('');
  const [barcodeVerified, setBarcodeVerified] = useState<boolean>(false);
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>({});
  const [packageWeightKg, setPackageWeightKg] = useState<string>('0.45');
  const [selectedBoxType, setSelectedBoxType] = useState<string>('Mailer Polybag #2');
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);
  const [showLabelModal, setShowLabelModal] = useState<boolean>(false);

  // Filter tasks
  const filteredTasks = tasks.filter((t) => {
    if (activeStageFilter !== 'ALL' && t.stage !== activeStageFilter) return false;
    if (selectedWarehouse !== 'ALL' && t.warehouseId !== selectedWarehouse) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        t.id.toLowerCase().includes(q) ||
        t.orderId.toLowerCase().includes(q) ||
        t.customerName.toLowerCase().includes(q) ||
        t.skuList.some((s) => s.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const matchingOrder = orders.find((o) => o.id === activeTask?.orderId);

  // Metrics
  const pickingCount = tasks.filter((t) => t.stage === 'PICKING').length;
  const packingCount = tasks.filter((t) => t.stage === 'PACKING').length;
  const readyCount = tasks.filter((t) => t.stage === 'READY_FOR_DISPATCH').length;
  const dispatchedCount = tasks.filter((t) => t.stage === 'DISPATCHED').length;

  const handleVerifyBarcode = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!activeTask) return;
    if (scannedBarcode.trim() === activeTask.barcode || scannedBarcode.trim() === activeTask.skuList[0]) {
      setBarcodeVerified(true);
      setActionSuccessMessage(`Barcode validated for ${activeTask.skuList[0]}`);
      setTimeout(() => setActionSuccessMessage(null), 3000);
    } else {
      setBarcodeVerified(false);
      alert(`Barcode mismatch! Expected ${activeTask.barcode}`);
    }
  };

  const handleSimulateScan = () => {
    if (!activeTask) return;
    setScannedBarcode(activeTask.barcode);
    setBarcodeVerified(true);
    setActionSuccessMessage(`Barcode automatically scanned: ${activeTask.barcode}`);
    setTimeout(() => setActionSuccessMessage(null), 3000);
  };

  const handleToggleItemCheck = (sku: string) => {
    setCheckedItems((prev) => ({ ...prev, [sku]: !prev[sku] }));
  };

  const handleAdvanceStage = () => {
    if (!activeTask) return;

    if (activeTask.stage === 'PICKING') {
      const updated: FulfillmentTask = {
        ...activeTask,
        stage: 'PACKING',
        slaTimeRemaining: '1h 10m',
      };
      setTasks((prev) => prev.map((t) => (t.id === activeTask.id ? updated : t)));
      setActiveTask(updated);
      setActionSuccessMessage(`Task ${activeTask.id} moved to Packing station`);
    } else if (activeTask.stage === 'PACKING') {
      const updated: FulfillmentTask = {
        ...activeTask,
        stage: 'READY_FOR_DISPATCH',
        packedAt: new Date().toISOString(),
        trackingNumber: `${activeTask.carrier.split(' ')[0].toUpperCase()}-${Math.floor(100000000 + Math.random() * 900000000)}`,
        slaTimeRemaining: '30 mins',
      };
      setTasks((prev) => prev.map((t) => (t.id === activeTask.id ? updated : t)));
      setActiveTask(updated);
      setActionSuccessMessage(`Order packed & labeled. Ready for carrier dispatch.`);
    } else if (activeTask.stage === 'READY_FOR_DISPATCH') {
      const updated: FulfillmentTask = {
        ...activeTask,
        stage: 'DISPATCHED',
        dispatchedAt: new Date().toISOString(),
        slaTimeRemaining: 'Handed Over',
      };
      setTasks((prev) => prev.map((t) => (t.id === activeTask.id ? updated : t)));
      setActiveTask(updated);

      // Also advance corresponding order state to SHIPPED if onUpdateOrder is available
      if (matchingOrder && onUpdateOrder) {
        const trk = activeTask.trackingNumber || `TRK-${Date.now()}`;
        const shippedOrder: Order = {
          ...matchingOrder,
          status: 'SHIPPED',
          shippingCarrier: activeTask.carrier,
          trackingNumber: trk,
          auditTrail: [
            ...matchingOrder.auditTrail,
            {
              id: `aud-ful-${Date.now()}`,
              timestamp: new Date().toISOString(),
              fromStatus: matchingOrder.status,
              toStatus: 'SHIPPED',
              actor: 'marcus.v@nordicpeak.com',
              actorRole: 'FULFILLMENT_STAFF',
              reason: `Order dispatched via ${activeTask.carrier}. Handover manifest signed.`,
              metadata: {
                carrier: activeTask.carrier,
                trackingNumber: trk,
                boxType: selectedBoxType,
                weightKg: packageWeightKg,
              },
            },
          ],
        };
        onUpdateOrder(shippedOrder);

        const isWhatsApp = matchingOrder.sourceChannel === 'WHATSAPP' || matchingOrder.whatsappSenderPhone;
        setActionSuccessMessage(
          isWhatsApp
            ? `Order ${activeTask.orderId} dispatched to ${activeTask.carrier}! Automated WhatsApp delivery notification sent to ${matchingOrder.whatsappSenderPhone || matchingOrder.customerPhone || 'customer'}.`
            : `Order ${activeTask.orderId} dispatched to ${activeTask.carrier}!`
        );
      } else {
        setActionSuccessMessage(`Order ${activeTask.orderId} dispatched to ${activeTask.carrier}!`);
      }
    }
    setTimeout(() => setActionSuccessMessage(null), 4000);
  };

  return (
    <div className="space-y-6">
      {/* Editorial Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Fulfilment & Warehouse Operations
            </h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
              Staff Portal
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Pick-list queues, barcode scan validation, packing station checklists, and carrier dispatch handover.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={selectedWarehouse}
            onChange={(e) => setSelectedWarehouse(e.target.value)}
            className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs focus:outline-none"
          >
            <option value="ALL">All Warehouse Nodes (2)</option>
            <option value="WH-MAIN-US">East Coast Distribution (WH-MAIN-US)</option>
            <option value="WH-EU-CENTRAL">Rotterdam Logistics Hub (WH-EU-CENTRAL)</option>
          </select>

          <button
            onClick={() => {
              setActionSuccessMessage('Warehouse inventory feed refreshed');
              setTimeout(() => setActionSuccessMessage(null), 2000);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors shadow-2xs"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
            <span className="hidden sm:inline">Refresh Queue</span>
          </button>
        </div>
      </div>

      {actionSuccessMessage && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center justify-between shadow-2xs animate-fade-in">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{actionSuccessMessage}</span>
          </div>
        </div>
      )}

      {/* Operational Stage KPI Ribbon */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <button
          onClick={() => setActiveStageFilter(activeStageFilter === 'PICKING' ? 'ALL' : 'PICKING')}
          className={`p-4 rounded-xl border text-left transition-all ${
            activeStageFilter === 'PICKING'
              ? 'bg-amber-50/70 border-amber-300 ring-2 ring-amber-400/20'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Orders to Pick</span>
            <CheckSquare className="w-4 h-4 text-amber-500" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-slate-900 tabular-nums">
            {pickingCount}
          </div>
          <div className="mt-1 text-[11px] text-amber-700 font-medium">Next SLA: 42 mins</div>
        </button>

        <button
          onClick={() => setActiveStageFilter(activeStageFilter === 'PACKING' ? 'ALL' : 'PACKING')}
          className={`p-4 rounded-xl border text-left transition-all ${
            activeStageFilter === 'PACKING'
              ? 'bg-blue-50/70 border-blue-300 ring-2 ring-blue-400/20'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Packing Station</span>
            <Box className="w-4 h-4 text-blue-500" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-slate-900 tabular-nums">
            {packingCount}
          </div>
          <div className="mt-1 text-[11px] text-blue-700 font-medium">Weighing & Carton sealing</div>
        </button>

        <button
          onClick={() => setActiveStageFilter(activeStageFilter === 'READY_FOR_DISPATCH' ? 'ALL' : 'READY_FOR_DISPATCH')}
          className={`p-4 rounded-xl border text-left transition-all ${
            activeStageFilter === 'READY_FOR_DISPATCH'
              ? 'bg-purple-50/70 border-purple-300 ring-2 ring-purple-400/20'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Ready to Dispatch</span>
            <Truck className="w-4 h-4 text-purple-500" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-slate-900 tabular-nums">
            {readyCount}
          </div>
          <div className="mt-1 text-[11px] text-purple-700 font-medium">Carrier manifest staged</div>
        </button>

        <button
          onClick={() => setActiveStageFilter(activeStageFilter === 'DISPATCHED' ? 'ALL' : 'DISPATCHED')}
          className={`p-4 rounded-xl border text-left transition-all ${
            activeStageFilter === 'DISPATCHED'
              ? 'bg-emerald-50/70 border-emerald-300 ring-2 ring-emerald-400/20'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Dispatched Today</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-slate-900 tabular-nums">
            {dispatchedCount}
          </div>
          <div className="mt-1 text-[11px] text-emerald-700 font-medium">100% on-time dispatch</div>
        </button>
      </div>

      {/* Main 2-Panel Fulfillment Operational Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Tasks Queue Table (7 cols) */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
          <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search order #, customer, SKU, or task ID..."
                className="w-full pl-9 pr-4 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </div>
            <div className="text-xs text-slate-500 whitespace-nowrap">
              Showing <strong>{filteredTasks.length}</strong> tasks
            </div>
          </div>

          <div className="overflow-x-auto divide-y divide-slate-100">
            {filteredTasks.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No fulfillment tasks match current filters.
              </div>
            ) : (
              filteredTasks.map((task) => {
                const isSelected = activeTask?.id === task.id;
                return (
                  <div
                    key={task.id}
                    onClick={() => {
                      setActiveTask(task);
                      setScannedBarcode('');
                      setBarcodeVerified(false);
                      setCheckedItems({});
                    }}
                    className={`p-4 cursor-pointer transition-colors flex items-center justify-between gap-4 ${
                      isSelected ? 'bg-slate-50 border-l-4 border-l-slate-900' : 'hover:bg-slate-50/50'
                    }`}
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-slate-900">
                          {task.orderId}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span className="text-xs text-slate-700 font-medium truncate">
                          {task.customerName}
                        </span>
                        {orders.find((o) => o.id === task.orderId)?.sourceChannel === 'WHATSAPP' && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                            WhatsApp
                          </span>
                        )}
                        {task.priority === 'RUSH' && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800">
                            RUSH
                          </span>
                        )}
                        {task.priority === 'HIGH' && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">
                            HIGH
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-slate-500 font-mono">
                        <span>SKUs: {task.skuList.join(', ')}</span>
                        <span aria-hidden="true">·</span>
                        <span>{task.carrier}</span>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          task.stage === 'PICKING'
                            ? 'bg-amber-100 text-amber-800'
                            : task.stage === 'PACKING'
                            ? 'bg-blue-100 text-blue-800'
                            : task.stage === 'READY_FOR_DISPATCH'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-emerald-100 text-emerald-800'
                        }`}
                      >
                        {task.stage.replace(/_/g, ' ')}
                      </span>
                      <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-end gap-1">
                        <Clock className="w-3 h-3" />
                        <span>{task.slaTimeRemaining}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Active Task Execution Station (5 cols) */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-5">
          {activeTask ? (
            <>
              <div className="flex items-center justify-between pb-3 border-b border-slate-200">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                      Fulfillment Station
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-100 text-slate-700">
                      {activeTask.id}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 mt-0.5 font-mono">
                    {activeTask.orderId}
                  </h3>
                </div>

                <button
                  onClick={() => setShowLabelModal(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
                >
                  <Printer className="w-3.5 h-3.5 text-slate-600" />
                  <span>Print Slip</span>
                </button>
              </div>

              {/* Warehouse & Destination */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1.5">
                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-500">Origin Warehouse:</span>
                  <span className="font-semibold text-slate-900">{activeTask.warehouseName}</span>
                </div>
                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-500">Assigned Staff:</span>
                  <span className="font-medium text-slate-800">{activeTask.assignedStaff}</span>
                </div>
                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-500">Shipping Carrier:</span>
                  <span className="font-semibold text-slate-900">{activeTask.carrier}</span>
                </div>
                {matchingOrder?.shippingAddress && (
                  <div className="pt-2 border-t border-slate-200 text-slate-600">
                    <span className="text-slate-500 block text-[11px]">Destination Address:</span>
                    <div className="font-medium text-slate-800">
                      {matchingOrder.shippingAddress.fullName} · {matchingOrder.shippingAddress.addressLine1},{' '}
                      {matchingOrder.shippingAddress.city}, {matchingOrder.shippingAddress.stateOrProvince}{' '}
                      {matchingOrder.shippingAddress.postalCode} ({matchingOrder.shippingAddress.countryCode})
                    </div>
                  </div>
                )}
              </div>

              {/* Stage-Specific Checklist */}
              <div>
                <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2">
                  Item Picking Checklist ({activeTask.skuList.length} items)
                </h4>
                <div className="space-y-2">
                  {activeTask.skuList.map((sku) => {
                    const isChecked = !!checkedItems[sku];
                    const matchedInv = inventories.find((i) => i.sku === sku);
                    return (
                      <div
                        key={sku}
                        onClick={() => handleToggleItemCheck(sku)}
                        className={`p-3 rounded-lg border cursor-pointer flex items-center justify-between text-xs transition-colors ${
                          isChecked
                            ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
                            : 'bg-white border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          {isChecked ? (
                            <CheckSquare className="w-4 h-4 text-emerald-600" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-400" />
                          )}
                          <div>
                            <div className="font-mono font-bold">{sku}</div>
                            <div className="text-[11px] text-slate-500">
                              Location: {matchedInv ? `Aisle 3, Bin ${sku.slice(-2)}` : 'Main Shelf'}
                            </div>
                          </div>
                        </div>
                        <span className="font-mono text-slate-600 text-xs font-medium">Qty: 1</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Barcode Scanner Simulator */}
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
                    <Barcode className="w-4 h-4 text-slate-600" />
                    <span>Barcode Verification</span>
                  </div>
                  {barcodeVerified ? (
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded text-[11px] font-bold flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Verified
                    </span>
                  ) : (
                    <span className="text-[11px] text-amber-700 font-medium">Pending Scan</span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={scannedBarcode}
                    onChange={(e) => setScannedBarcode(e.target.value)}
                    placeholder={`Expected: ${activeTask.barcode}`}
                    className="flex-1 px-3 py-1.5 bg-white border border-slate-200 rounded-md text-xs font-mono focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                  <button
                    onClick={handleSimulateScan}
                    className="px-2.5 py-1.5 bg-slate-200 text-slate-700 hover:bg-slate-300 rounded-md text-xs font-medium whitespace-nowrap"
                  >
                    Simulate Laser
                  </button>
                  <button
                    onClick={() => handleVerifyBarcode()}
                    className="px-3 py-1.5 bg-slate-900 text-white rounded-md text-xs font-semibold hover:bg-slate-800 whitespace-nowrap"
                  >
                    Verify
                  </button>
                </div>
              </div>

              {/* Packaging Station Specs */}
              {activeTask.stage === 'PACKING' && (
                <div className="space-y-3 pt-2 border-t border-slate-100 text-xs">
                  <h4 className="font-bold text-slate-900 uppercase tracking-wider text-[11px]">
                    Packing Specifications
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-slate-500 block text-[11px] mb-1">Carton Type</label>
                      <select
                        value={selectedBoxType}
                        onChange={(e) => setSelectedBoxType(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs"
                      >
                        <option>Mailer Polybag #2</option>
                        <option>Corrugated Box 10x8x4</option>
                        <option>Heavy Duty Carton 14x10x6</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-slate-500 block text-[11px] mb-1">Scale Weight (kg)</label>
                      <input
                        type="text"
                        value={packageWeightKg}
                        onChange={(e) => setPackageWeightKg(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Action Advancement Button */}
              <div className="pt-2">
                <button
                  onClick={handleAdvanceStage}
                  disabled={activeTask.stage === 'DISPATCHED'}
                  className={`w-full py-2.5 px-4 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-colors shadow-2xs ${
                    activeTask.stage === 'DISPATCHED'
                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                      : 'bg-slate-900 text-white hover:bg-slate-800'
                  }`}
                >
                  {activeTask.stage === 'PICKING' && (
                    <>
                      <span>Complete Picking &rarr; Send to Packing</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                  {activeTask.stage === 'PACKING' && (
                    <>
                      <span>Seal Carton &rarr; Generate Shipping Label</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                  {activeTask.stage === 'READY_FOR_DISPATCH' && (
                    <>
                      <span>Handover to {activeTask.carrier} &rarr; Mark Dispatched</span>
                      <Truck className="w-3.5 h-3.5 text-emerald-400" />
                    </>
                  )}
                  {activeTask.stage === 'DISPATCHED' && (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      <span>Order Dispatched & Tracking Active</span>
                    </>
                  )}
                </button>
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-slate-500 text-xs">
              Select a task from the queue to start fulfillment.
            </div>
          )}
        </div>
      </div>

      {/* Printable Shipping Slip Modal */}
      {showLabelModal && activeTask && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Printer className="w-4 h-4 text-slate-800" />
                <h3 className="font-bold text-slate-900 text-sm">Packing Slip & Carrier Label</h3>
              </div>
              <button
                onClick={() => setShowLabelModal(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-semibold"
              >
                &times;
              </button>
            </div>

            <div className="p-4 bg-slate-50 border-2 border-dashed border-slate-300 rounded-xl font-mono text-xs space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-900">{tenant.name}</span>
                <span className="text-[10px] bg-slate-200 px-2 py-0.5 rounded font-bold">
                  {activeTask.carrier}
                </span>
              </div>
              <div className="text-[11px] text-slate-600">
                SHIP TO:
                <br />
                {matchingOrder?.shippingAddress.fullName || activeTask.customerName}
                <br />
                {matchingOrder?.shippingAddress.addressLine1 || '742 Evergreen Terrace'}
                <br />
                {matchingOrder?.shippingAddress.city}, {matchingOrder?.shippingAddress.stateOrProvince}{' '}
                {matchingOrder?.shippingAddress.postalCode}
              </div>
              <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-[11px]">
                <span>Order: {activeTask.orderId}</span>
                <span>Box: {selectedBoxType}</span>
              </div>
              <div className="p-3 bg-white border border-slate-300 rounded text-center text-xs tracking-widest font-bold">
                ||| | |||| | |||||| || | |||| ||
                <div className="text-[10px] text-slate-500 font-sans mt-1">
                  {activeTask.trackingNumber || activeTask.barcode}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowLabelModal(false)}
                className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-200"
              >
                Close
              </button>
              <button
                onClick={() => {
                  setActionSuccessMessage('Shipping label & packing slip sent to Zebra ZT410 Thermal Printer (Nairobi Station 2).');
                  setShowLabelModal(false);
                  setTimeout(() => setActionSuccessMessage(null), 4000);
                }}
                className="px-4 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800"
              >
                Print to Thermal Station
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
