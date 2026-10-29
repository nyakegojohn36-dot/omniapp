import React, { useState, useRef } from 'react';
import {
  Package,
  Layers,
  Plus,
  Minus,
  AlertTriangle,
  Clock,
  Warehouse,
  CheckCircle2,
  XCircle,
  ShieldAlert,
  ShoppingBag,
  ArrowRight,
  ShieldCheck,
  Truck,
  X,
  UploadCloud,
  Image as ImageIcon,
  Trash2,
  FileUp,
  Link as LinkIcon,
} from 'lucide-react';
import { Product, StockReservation, Tenant, WarehouseInventory, UserRole } from '../lib/types.ts';
import { formatCurrency } from '../lib/pricingEngine.ts';

interface InventoryCatalogViewProps {
  tenant: Tenant;
  products: Product[];
  inventories: WarehouseInventory[];
  reservations: StockReservation[];
  currentRole?: UserRole;
  onNavigateToStorefront?: (sku?: string) => void;
  onAdjustStock: (
    sku: string,
    warehouseId: string,
    deltaPhysical: number,
    quarantineDelta: number,
    reason: string
  ) => void;
  onCancelReservation: (reservationId: string) => void;
  onCommitReservation: (reservationId: string) => void;
  onTriggerReservation: (sku: string, qty: number) => void;
  onAddProduct?: (product: Product, initialStockUS: number, initialStockEU: number) => void;
}

export const InventoryCatalogView: React.FC<InventoryCatalogViewProps> = ({
  tenant,
  products,
  inventories,
  reservations,
  currentRole = 'BUSINESS_OWNER',
  onNavigateToStorefront,
  onAdjustStock,
  onCancelReservation,
  onCommitReservation,
  onTriggerReservation,
  onAddProduct,
}) => {
  const [selectedSku, setSelectedSku] = useState<string>('TSHIRT001');
  const [isAddProductModalOpen, setIsAddProductModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSku, setNewSku] = useState('');
  const [newCategory, setNewCategory] = useState('Apparel');
  const [newDescription, setNewDescription] = useState('');
  const [newPrice, setNewPrice] = useState('49.99');
  const [newStockUS, setNewStockUS] = useState('25');
  const [newStockEU, setNewStockEU] = useState('15');
  const [newImageUrl, setNewImageUrl] = useState('https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800&auto=format&fit=crop&q=80');
  const [imageInputMode, setImageInputMode] = useState<'upload' | 'url'>('upload');
  const [uploadedImageDataUrl, setUploadedImageDataUrl] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadedFileSize, setUploadedFileSize] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const canAddProducts = currentRole === 'BUSINESS_OWNER' || currentRole === 'SUPER_ADMIN';

  const isCustomer = currentRole === 'CUSTOMER';
  const selectedProduct = products.find((p) => p.sku === selectedSku) || products[0];
  const relatedInventories = inventories.filter((i) => i.sku.startsWith(selectedSku));

  const handleFileProcess = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setFormError('Please select a valid image file (PNG, JPG, WEBP, or GIF).');
      return;
    }
    // Limit to 8MB
    if (file.size > 8 * 1024 * 1024) {
      setFormError('Image file is too large. Please select an image under 8MB.');
      return;
    }
    setFormError(null);
    const sizeStr = file.size > 1024 * 1024
      ? `${(file.size / (1024 * 1024)).toFixed(2)} MB`
      : `${Math.round(file.size / 1024)} KB`;

    setUploadedFileName(file.name);
    setUploadedFileSize(sizeStr);

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setUploadedImageDataUrl(result);
    };
    reader.onerror = () => {
      setFormError('Failed to read image file from your device. Please try another file.');
    };
    reader.readAsDataURL(file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileProcess(file);
    }
  };

  const handleClearUploadedImage = () => {
    setUploadedImageDataUrl(null);
    setUploadedFileName(null);
    setUploadedFileSize(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleCreateProduct = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedSku = newSku.trim().toUpperCase();
    const trimmedTitle = newTitle.trim();
    const priceNum = parseFloat(newPrice);
    const stockUS = parseInt(newStockUS, 10) || 0;
    const stockEU = parseInt(newStockEU, 10) || 0;

    if (!trimmedTitle) {
      setFormError('Please enter a product title.');
      return;
    }
    if (!trimmedSku) {
      setFormError('Please enter a unique SKU code.');
      return;
    }
    if (products.some((p) => p.sku.toLowerCase() === trimmedSku.toLowerCase())) {
      setFormError(`SKU "${trimmedSku}" already exists in the catalog.`);
      return;
    }
    if (isNaN(priceNum) || priceNum <= 0) {
      setFormError('Please enter a valid price greater than 0.');
      return;
    }

    const finalImageUrl =
      (imageInputMode === 'upload' && uploadedImageDataUrl)
        ? uploadedImageDataUrl
        : (newImageUrl.trim() || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800&auto=format&fit=crop&q=80');

    const newProduct: Product = {
      id: `prod-${Date.now()}`,
      tenantId: tenant.id,
      sku: trimmedSku,
      title: trimmedTitle,
      description: newDescription.trim() || 'Premium retail product crafted with sustainable materials.',
      category: newCategory,
      basePriceCents: Math.round(priceNum * 100),
      currency: tenant.currency || 'USD',
      status: 'ACTIVE',
      imageUrl: finalImageUrl,
      createdAt: new Date().toISOString(),
      variants: [
        {
          id: `var-${trimmedSku}-std`,
          sku: trimmedSku,
          name: 'Standard Edition',
          priceCents: Math.round(priceNum * 100),
          attributes: { Edition: 'Standard' },
        },
      ],
    };

    if (onAddProduct) {
      onAddProduct(newProduct, stockUS, stockEU);
    }

    setSelectedSku(trimmedSku);
    setIsAddProductModalOpen(false);
    setNewTitle('');
    setNewSku('');
    setNewDescription('');
    handleClearUploadedImage();
    setImageInputMode('upload');
    setSuccessBanner(`Product "${trimmedTitle}" (${trimmedSku}) added successfully with device photo!`);
    setTimeout(() => setSuccessBanner(null), 5000);
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {isCustomer ? 'Product Catalog & Stock Availability' : 'Product Catalogue & Atomic Inventory Engine'}
          </h1>
          <div className="flex items-center gap-2 text-xs text-slate-500 mt-1">
            {isCustomer ? (
              <>
                <span className="text-emerald-700 font-semibold flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" /> Verified In-Stock Guarantee
                </span>
                <span aria-hidden="true">·</span>
                <span>Real-Time Warehouse Stock</span>
                <span aria-hidden="true">·</span>
                <span>Immediate Cart Hold Reservation</span>
              </>
            ) : (
              <>
                <span>Concurrency-Safe Reservations</span>
                <span aria-hidden="true">·</span>
                <span>Multi-Warehouse Allocations</span>
                <span aria-hidden="true">·</span>
                <span>Optimistic Locking & Audit</span>
              </>
            )}
          </div>
        </div>

        {isCustomer ? (
          <div className="flex items-center gap-3">
            <span className="px-3 py-1.5 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg text-xs font-semibold flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Live Customer Catalog
            </span>
            {onNavigateToStorefront && (
              <button
                onClick={() => onNavigateToStorefront(selectedSku)}
                className="flex items-center gap-2 px-3.5 py-2 text-xs font-bold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors shadow-2xs"
              >
                <ShoppingBag className="w-3.5 h-3.5 text-emerald-400" />
                <span>Go to Storefront & Cart</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-2.5 py-1.5 bg-slate-100 rounded-lg text-slate-700 text-xs font-semibold font-mono">
              {currentRole === 'BUSINESS_OWNER'
                ? 'Admin Catalog Control'
                : currentRole === 'FULFILLMENT_STAFF'
                ? 'Warehouse Staff View'
                : 'Support Catalog View'}
            </span>

            {canAddProducts && (
              <button
                onClick={() => setIsAddProductModalOpen(true)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors shadow-2xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Product</span>
              </button>
            )}
          </div>
        )}
      </div>

      {successBanner && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-semibold">{successBanner}</span>
          </div>
          <button onClick={() => setSuccessBanner(null)} className="text-slate-400 hover:text-slate-700">
            &times;
          </button>
        </div>
      )}

      {/* Product Selector Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {products.map((product) => {
          const isSelected = selectedSku === product.sku;
          const matchingInvs = inventories.filter((i) => i.sku === product.sku || i.sku.startsWith(`${product.sku}-`));
          const totalPhysical = matchingInvs.reduce((acc, i) => acc + i.physicalStock, 0);
          const totalReserved = matchingInvs.reduce((acc, i) => acc + i.reservedStock, 0);
          const totalQuarantine = matchingInvs.reduce((acc, i) => acc + i.quarantineStock, 0);
          const totalAvailable = Math.max(0, totalPhysical - (totalReserved + totalQuarantine));

          return (
            <div
              key={product.id}
              onClick={() => setSelectedSku(product.sku)}
              className={`cursor-pointer rounded-xl border p-4 transition-all bg-white shadow-2xs ${
                isSelected
                  ? 'border-slate-900 ring-2 ring-slate-900/10'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex gap-4">
                {product.imageUrl ? (
                  <img
                    src={product.imageUrl}
                    alt={product.title}
                    referrerPolicy="no-referrer"
                    className="w-20 h-20 rounded-lg object-cover bg-slate-100 shrink-0 border border-slate-100"
                  />
                ) : (
                  <div className="w-20 h-20 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                    <Package className="w-8 h-8 text-slate-400" />
                  </div>
                )}

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold text-slate-500">
                      {product.sku}
                    </span>
                    <span className="font-mono font-bold text-sm text-slate-900 tabular-nums">
                      {formatCurrency(product.basePriceCents, product.currency, tenant.locale)}
                    </span>
                  </div>

                  <h3 className="font-semibold text-slate-900 text-sm truncate">
                    {product.title}
                  </h3>

                  <div className="flex items-center gap-2 pt-1 text-xs">
                    <span
                      className={`font-semibold tabular-nums px-2 py-0.5 rounded text-[11px] ${
                        totalAvailable === 0
                          ? 'bg-rose-50 text-rose-700'
                          : totalAvailable <= 5
                          ? 'bg-amber-50 text-amber-700'
                          : 'bg-emerald-50 text-emerald-700'
                      }`}
                    >
                      {totalAvailable === 0
                        ? 'Out of Stock'
                        : totalAvailable <= 5
                        ? `Only ${totalAvailable} left!`
                        : `${totalAvailable} in stock`}
                    </span>

                    {/* Only show internal reservation count to admin/staff */}
                    {!isCustomer && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="text-slate-400 font-mono text-[11px]">
                          {totalReserved} reserved
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Selected Product Deep Dive */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-2xs space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
              <span>SKU: {selectedProduct.sku}</span>
              <span aria-hidden="true">·</span>
              <span>Category: {selectedProduct.category}</span>
              <span aria-hidden="true">·</span>
              <span className="text-emerald-700 font-semibold">{selectedProduct.status}</span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 mt-1">
              {selectedProduct.title}
            </h2>
            <p className="text-xs text-slate-600 mt-1 max-w-2xl">
              {selectedProduct.description}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {isCustomer ? (
              onNavigateToStorefront && (
                <button
                  onClick={() => onNavigateToStorefront(selectedProduct.sku)}
                  className="px-4 py-2.5 text-xs font-bold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors shadow-2xs flex items-center gap-2"
                >
                  <ShoppingBag className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Order Now in Storefront</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )
            ) : (
              <button
                onClick={() => onTriggerReservation(selectedProduct.sku, 1)}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors shadow-2xs whitespace-nowrap"
              >
                Simulate 1-Unit Cart Hold
              </button>
            )}
          </div>
        </div>

        {/* Warehouse Stock Matrix or Customer Availability List */}
        <div>
          <h3 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
            {isCustomer ? (
              <>
                <Truck className="w-4 h-4 text-emerald-600" />
                <span>Regional Availability & Delivery Estimates</span>
              </>
            ) : (
              <>
                <Warehouse className="w-4 h-4 text-slate-600" />
                <span>Warehouse Stock Allocation & Audit State</span>
              </>
            )}
          </h3>

          {isCustomer ? (
            /* Customer-Facing Clean Warehouse Table */
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3">Fulfillment Center / Region</th>
                    <th className="px-4 py-3">Available Stock</th>
                    <th className="px-4 py-3">Standard Dispatch Time</th>
                    <th className="px-4 py-3 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {relatedInventories.map((inv) => {
                    const available = Math.max(0, inv.physicalStock - (inv.reservedStock + inv.quarantineStock));
                    const isOutOfStock = available === 0;

                    return (
                      <tr key={`${inv.sku}-${inv.warehouseId}`} className="hover:bg-slate-50/60 transition-colors">
                        <td className="px-4 py-3 font-semibold text-slate-900">
                          {inv.warehouseName}
                        </td>
                        <td className="px-4 py-3 font-mono font-bold text-slate-800">
                          {isOutOfStock ? (
                            <span className="text-rose-600">0 units</span>
                          ) : (
                            <span className="text-emerald-700">{available} units available</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {isOutOfStock ? 'Replenishment pending' : '1 - 2 business days'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                              isOutOfStock
                                ? 'bg-rose-100 text-rose-800'
                                : available <= 5
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {isOutOfStock ? 'Sold Out' : available <= 5 ? 'Low Stock' : 'Ready to Ship'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            /* Internal Admin / Staff Stock Table */
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3">Variant / SKU</th>
                    <th className="px-4 py-3">Warehouse Location</th>
                    <th className="px-4 py-3 text-right">Physical</th>
                    <th className="px-4 py-3 text-right">Active Holds</th>
                    <th className="px-4 py-3 text-right">Quarantine</th>
                    <th className="px-4 py-3 text-right">Available for Sale</th>
                    <th className="px-4 py-3 text-right">Status</th>
                    <th className="px-4 py-3 text-right">Quick Stock Adj</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {relatedInventories.map((inv) => {
                    const available = Math.max(0, inv.physicalStock - (inv.reservedStock + inv.quarantineStock));
                    const isOutOfStock = available === 0;
                    const isLow = available > 0 && available <= inv.lowStockThreshold;

                    return (
                      <tr key={`${inv.sku}-${inv.warehouseId}`} className="hover:bg-slate-50/60 transition-colors">
                        <td className="px-4 py-3 font-semibold text-slate-900">
                          {inv.sku}
                        </td>
                        <td className="px-4 py-3 font-sans text-slate-600">
                          {inv.warehouseName}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-800 tabular-nums">
                          {inv.physicalStock}
                        </td>
                        <td className="px-4 py-3 text-right text-amber-700 font-medium tabular-nums">
                          {inv.reservedStock}
                        </td>
                        <td className="px-4 py-3 text-right text-rose-700 font-medium tabular-nums">
                          {inv.quarantineStock}
                        </td>
                        <td className="px-4 py-3 text-right font-bold tabular-nums">
                          <span
                            className={`px-2 py-0.5 rounded text-xs ${
                              isOutOfStock
                                ? 'bg-rose-100 text-rose-800'
                                : isLow
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {available}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-sans">
                          {isOutOfStock ? (
                            <span className="text-rose-600 font-medium">Out of Stock</span>
                          ) : isLow ? (
                            <span className="text-amber-600 font-medium">Low Stock</span>
                          ) : (
                            <span className="text-emerald-600 font-medium">Healthy</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5 font-sans">
                            <button
                              onClick={() =>
                                onAdjustStock(
                                  inv.sku,
                                  inv.warehouseId,
                                  5,
                                  0,
                                  'Restock batch delivery'
                                )
                              }
                              className="px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100"
                              title="Add 5 units physical stock"
                            >
                              +5
                            </button>
                            <button
                              onClick={() =>
                                onAdjustStock(
                                  inv.sku,
                                  inv.warehouseId,
                                  -1,
                                  1,
                                  'Damaged in transit moved to quarantine'
                                )
                              }
                              className="px-2 py-1 text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded hover:bg-rose-100"
                              title="Quarantine 1 unit"
                            >
                              QA 1
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Live Active Reservations Table (Strictly Admin / Staff only) */}
        {!isCustomer && (
          <div className="pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-500" />
                <span>Active Stock Reservations (TTL Concurrency Locks)</span>
              </h3>
              <span className="text-xs text-slate-500 font-mono">
                Auto-expires after {tenant.reservationTTLMinutes} mins
              </span>
            </div>

            {reservations.length === 0 ? (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-center text-xs text-slate-500">
                No active reservations currently in flight. Add an item in checkout to create one.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                {reservations.map((res) => {
                  const isExpired = new Date(res.expiresAt).getTime() <= Date.now();
                  return (
                    <div
                      key={res.id}
                      className="p-3 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-mono font-bold text-slate-900">{res.id}</span>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="font-mono text-slate-700">{res.sku}</span>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="text-slate-500">Qty: {res.quantity}</span>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="font-mono text-[11px] text-slate-400">Order: {res.orderId}</span>
                      </div>

                      <div className="flex items-center gap-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                            res.status === 'COMMITTED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : isExpired || res.status === 'EXPIRED'
                              ? 'bg-rose-100 text-rose-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {isExpired && res.status === 'ACTIVE' ? 'EXPIRED (PENDING SWEEP)' : res.status}
                        </span>

                        {res.status === 'ACTIVE' && (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => onCommitReservation(res.id)}
                              className="px-2.5 py-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100"
                            >
                              Commit
                            </button>
                            <button
                              onClick={() => onCancelReservation(res.id)}
                              className="px-2.5 py-1 text-[11px] font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded hover:bg-slate-100"
                            >
                              Release
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add Product Modal (Business Owner / Admin exclusive) */}
      {isAddProductModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-lg w-full overflow-hidden max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center">
                  <Package className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">Add New Product to Catalog</h3>
                  <p className="text-[11px] text-slate-500">Business Owner Authority · Synchronized across all channels</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setIsAddProductModalOpen(false);
                  setFormError(null);
                  handleClearUploadedImage();
                }}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateProduct} className="p-6 space-y-4 overflow-y-auto flex-1">
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Product Title <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. Merino Wool Beanie"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 shadow-2xs"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    SKU Code <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={newSku}
                    onChange={(e) => setNewSku(e.target.value)}
                    placeholder="e.g. BEANIE001"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs font-mono text-slate-900 uppercase focus:outline-none focus:ring-2 focus:ring-slate-900 shadow-2xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Category</label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 shadow-2xs bg-white"
                  >
                    <option value="Apparel">Apparel</option>
                    <option value="Footwear">Footwear</option>
                    <option value="Accessories">Accessories</option>
                    <option value="Electronics">Electronics</option>
                    <option value="Home & Living">Home & Living</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Base Price ({tenant.currency || 'USD'}) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value)}
                    placeholder="49.99"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 shadow-2xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Description</label>
                <textarea
                  rows={2}
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Describe key features, sizing, and material composition..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 shadow-2xs resize-none"
                />
              </div>

              {/* Product Photo: Upload from Device as primary */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold text-slate-700">
                    Product Image
                  </label>
                  <div className="flex items-center gap-1 text-[11px] p-0.5 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setImageInputMode('upload')}
                      className={`px-2 py-0.5 rounded-md font-semibold transition-all flex items-center gap-1 ${
                        imageInputMode === 'upload'
                          ? 'bg-white text-slate-900 shadow-2xs'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      <UploadCloud className="w-3 h-3 text-indigo-600" />
                      <span>Upload from Device</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setImageInputMode('url')}
                      className={`px-2 py-0.5 rounded-md font-semibold transition-all flex items-center gap-1 ${
                        imageInputMode === 'url'
                          ? 'bg-white text-slate-900 shadow-2xs'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      <LinkIcon className="w-3 h-3" />
                      <span>Web URL</span>
                    </button>
                  </div>
                </div>

                {imageInputMode === 'upload' ? (
                  <div>
                    {/* Hidden file input */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={handleFileInputChange}
                      className="hidden"
                    />

                    {uploadedImageDataUrl ? (
                      /* Live Preview of device uploaded image */
                      <div className="border border-emerald-200 bg-emerald-50/40 rounded-xl p-3 flex items-center justify-between gap-3 shadow-2xs">
                        <div className="flex items-center gap-3 min-w-0">
                          <img
                            src={uploadedImageDataUrl}
                            alt="Uploaded preview"
                            className="w-16 h-16 rounded-lg object-cover border border-emerald-300 shadow-xs shrink-0 bg-white"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-bold text-slate-900 truncate">
                                {uploadedFileName || 'device_image.jpg'}
                              </span>
                              <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                                Loaded
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {uploadedFileSize || 'Ready'} · Stored directly in catalog
                            </div>
                            <button
                              type="button"
                              onClick={() => fileInputRef.current?.click()}
                              className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:underline mt-1 flex items-center gap-1"
                            >
                              <FileUp className="w-3 h-3" />
                              <span>Choose another photo</span>
                            </button>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={handleClearUploadedImage}
                          title="Remove image"
                          className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      /* Device file dropzone */
                      <div
                        onDragOver={(e) => {
                          e.preventDefault();
                          setIsDraggingFile(true);
                        }}
                        onDragLeave={() => setIsDraggingFile(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setIsDraggingFile(false);
                          const file = e.dataTransfer.files?.[0];
                          if (file) handleFileProcess(file);
                        }}
                        onClick={() => fileInputRef.current?.click()}
                        className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all ${
                          isDraggingFile
                            ? 'border-indigo-600 bg-indigo-50/70 ring-2 ring-indigo-500/20'
                            : 'border-slate-300 hover:border-indigo-400 hover:bg-slate-50/90 bg-slate-50/40'
                        }`}
                      >
                        <div className="w-10 h-10 rounded-full bg-white shadow-2xs border border-slate-200 mx-auto flex items-center justify-center text-slate-600 mb-2">
                          <UploadCloud className="w-5 h-5 text-indigo-600" />
                        </div>
                        <div className="text-xs font-bold text-slate-900">
                          Click to select a photo from your device
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Drag & drop or browse from phone or computer (PNG, JPG, WEBP, GIF up to 8MB)
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Web Image URL fallback */
                  <div className="space-y-2">
                    <input
                      type="url"
                      value={newImageUrl}
                      onChange={(e) => setNewImageUrl(e.target.value)}
                      placeholder="https://images.unsplash.com/..."
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 shadow-2xs"
                    />
                    <div className="flex gap-2 items-center overflow-x-auto text-[11px] text-slate-500 pt-0.5">
                      <span className="font-semibold text-slate-600">Sample Photos:</span>
                      <button
                        type="button"
                        onClick={() => setNewImageUrl('https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800&auto=format&fit=crop&q=80')}
                        className="text-indigo-600 hover:underline"
                      >
                        T-Shirt
                      </button>
                      <span>·</span>
                      <button
                        type="button"
                        onClick={() => setNewImageUrl('https://images.unsplash.com/photo-1576566588028-4147f3842f27?w=800&auto=format&fit=crop&q=80')}
                        className="text-indigo-600 hover:underline"
                      >
                        Sweater
                      </button>
                      <span>·</span>
                      <button
                        type="button"
                        onClick={() => setNewImageUrl('https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800&auto=format&fit=crop&q=80')}
                        className="text-indigo-600 hover:underline"
                      >
                        Watch
                      </button>
                      <span>·</span>
                      <button
                        type="button"
                        onClick={() => setNewImageUrl('https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800&auto=format&fit=crop&q=80')}
                        className="text-indigo-600 hover:underline"
                      >
                        Sneaker
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Initial Warehouse Stock Allocation */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
                  <Warehouse className="w-3.5 h-3.5 text-slate-600" />
                  <span>Initial Stock Allocation by Warehouse</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-0.5">Nairobi Hub (Industrial Area)</label>
                    <input
                      type="number"
                      min="0"
                      value={newStockUS}
                      onChange={(e) => setNewStockUS(e.target.value)}
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-mono font-semibold"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-0.5">Mombasa Depot (Nyali Hub)</label>
                    <input
                      type="number"
                      min="0"
                      value={newStockEU}
                      onChange={(e) => setNewStockEU(e.target.value)}
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-mono font-semibold"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setIsAddProductModalOpen(false);
                    setFormError(null);
                    handleClearUploadedImage();
                  }}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors shadow-2xs flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create & Publish Product</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
