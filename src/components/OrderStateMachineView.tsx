import React, { useState } from 'react';
import {
  GitCommit,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
  CreditCard,
  Truck,
  RotateCcw,
  Clock,
  User,
  XCircle,
  FileText,
} from 'lucide-react';
import { Order, OrderStatus, Tenant, UserRole } from '../lib/types.ts';
import { ALLOWED_TRANSITIONS, transitionOrder } from '../lib/orderStateMachine.ts';
import { formatCurrency } from '../lib/pricingEngine.ts';
import { KraTaxInvoiceModal } from './KraTaxInvoiceModal.tsx';

interface OrderStateMachineViewProps {
  tenant: Tenant;
  orders: Order[];
  currentRole: UserRole;
  onUpdateOrder: (updatedOrder: Order) => void;
}

export const OrderStateMachineView: React.FC<OrderStateMachineViewProps> = ({
  tenant,
  orders,
  currentRole,
  onUpdateOrder,
}) => {
  const [selectedOrderId, setSelectedOrderId] = useState<string>('ORD-000008');
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitionSuccess, setTransitionSuccess] = useState<string | null>(null);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);

  const selectedOrder = orders.find((o) => o.id === selectedOrderId) || orders[0];
  const allowedNextStates = ALLOWED_TRANSITIONS[selectedOrder?.status || 'DRAFT'] || [];

  const handleExecuteTransition = (
    targetStatus: OrderStatus,
    reason: string,
    metadata?: Record<string, unknown>
  ) => {
    setTransitionError(null);
    setTransitionSuccess(null);

    const isPrepaid = selectedOrder.paymentMethod !== 'CASH_ON_DELIVERY';
    const isPaymentConfirmed =
      targetStatus === 'CONFIRMED' ? true : selectedOrder.isPaid;

    const result = transitionOrder(selectedOrder, targetStatus, {
      actor: currentRole === 'CUSTOMER' ? selectedOrder.customerEmail : `staff-${currentRole.toLowerCase()}`,
      actorRole: currentRole,
      reason,
      paymentConfirmed: isPaymentConfirmed,
      trackingNumberProvided: !!metadata?.trackingNumber,
      carrierProvided: !!metadata?.shippingCarrier,
      itemReceivedAtWarehouse: targetStatus === 'RETURNED' ? true : false,
      metadata,
    });

    if (result.success) {
      onUpdateOrder(result.order);
      setTransitionSuccess(`Successfully transitioned order to ${targetStatus}`);
    } else {
      setTransitionError(result.error || 'Transition denied by state machine rules.');
    }
  };

  const handleTestIllegalJump = () => {
    setTransitionError(null);
    setTransitionSuccess(null);

    // Intentionally attempt invalid transition: skip from current to DELIVERED
    const result = transitionOrder(selectedOrder, 'DELIVERED', {
      actor: 'test-runner',
      actorRole: currentRole,
      reason: 'Illegal direct transition test',
    });

    if (!result.success) {
      setTransitionError(result.error || 'Illegal jump blocked by state machine!');
    }
  };

  return (
    <div className="space-y-8">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Deterministic Order State Machine
        </h1>
        <div className="flex items-center gap-2 text-xs text-slate-500 mt-1">
          <span>Authoritative Server-Enforced Invariants</span>
          <span aria-hidden="true">·</span>
          <span>No Invalid Skips</span>
          <span aria-hidden="true">·</span>
          <span>Immutable Audit Log</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Orders List */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-2xs overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/50">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Select Order to Inspect
            </h2>
          </div>

          <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
            {orders.map((order) => {
              const isSelected = order.id === selectedOrderId;
              return (
                <div
                  key={order.id}
                  onClick={() => {
                    setSelectedOrderId(order.id);
                    setTransitionError(null);
                    setTransitionSuccess(null);
                  }}
                  className={`p-4 cursor-pointer transition-colors text-xs space-y-1.5 ${
                    isSelected ? 'bg-slate-100/80 border-l-3 border-slate-900' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between font-mono font-bold">
                    <span className="text-slate-900">{order.id}</span>
                    <span className="text-slate-700">
                      {formatCurrency(order.totalCents, order.currency, tenant.locale)}
                    </span>
                  </div>
                  <div className="text-slate-600 truncate">{order.customerName}</div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-slate-400">
                      {order.items.length} item(s)
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide bg-slate-200/80 text-slate-800">
                      {order.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Center & Right: Selected Order Details & Transition Controls */}
        <div className="lg:col-span-2 space-y-6">
          {/* Order Header Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-2xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
              <div>
                <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                  <span>Order: {selectedOrder.id}</span>
                  <span aria-hidden="true">·</span>
                  <span>Placed: {new Date(selectedOrder.createdAt).toLocaleDateString()}</span>
                  <span aria-hidden="true">·</span>
                  <span>Paid: {selectedOrder.isPaid ? 'Yes (Verified)' : 'Pending'}</span>
                </div>
                <h2 className="text-xl font-bold text-slate-900 mt-1">
                  Customer: {selectedOrder.customerName}
                </h2>
                <div className="text-xs text-slate-600 mt-0.5">
                  Ship to: {selectedOrder.shippingAddress.addressLine1}, {selectedOrder.shippingAddress.city},{' '}
                  {selectedOrder.shippingAddress.countryCode}
                </div>
              </div>

              <div className="flex flex-col items-end gap-1.5">
                <div className="text-right">
                  <div className="text-xs text-slate-400 font-mono">Current Status</div>
                  <span className="inline-block mt-1 px-3 py-1 rounded-md text-xs font-bold tracking-wide bg-slate-900 text-white font-mono">
                    {selectedOrder.status}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowInvoiceModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5 text-emerald-700" />
                  <span>KRA eTIMS Invoice</span>
                </button>
              </div>
            </div>

            {/* Error or Success Alert */}
            {transitionError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-start gap-2">
                <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <strong>Transition Denied:</strong> {transitionError}
                </div>
              </div>
            )}

            {transitionSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <div>{transitionSuccess}</div>
              </div>
            )}

            {/* State Transition Actions */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900 flex items-center gap-1.5">
                  <GitCommit className="w-4 h-4 text-slate-600" />
                  <span>Valid Next State Transitions</span>
                </span>
                <span className="text-slate-500">Acting as: {currentRole}</span>
              </div>

              {allowedNextStates.length === 0 ? (
                <div className="p-4 bg-slate-50 rounded-lg text-xs text-slate-500 text-center">
                  This order is in terminal state ({selectedOrder.status}). No further state progression allowed.
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {/* Transition: AWAITING_PAYMENT -> CONFIRMED */}
                  {selectedOrder.status === 'AWAITING_PAYMENT' && (
                    <>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'CONFIRMED',
                            'Safaricom Daraja M-PESA STK push verified and captured.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors shadow-2xs"
                      >
                        Verify Payment &rarr; CONFIRMED
                      </button>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'PAYMENT_FAILED',
                            'Payment processor returned card decline code.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors"
                      >
                        Payment Declined &rarr; PAYMENT_FAILED
                      </button>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'CANCELLED',
                            'Customer abandoned payment session.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                      >
                        Cancel Order
                      </button>
                    </>
                  )}

                  {/* Transition: CONFIRMED -> PROCESSING */}
                  {selectedOrder.status === 'CONFIRMED' && (
                    <>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'PROCESSING',
                            'Sent to warehouse pack station 1.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors shadow-2xs"
                      >
                        Send to Pack Station &rarr; PROCESSING
                      </button>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'CANCELLATION_REQUESTED',
                            'Customer requested cancellation before pack.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                      >
                        Request Cancel
                      </button>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'ON_HOLD',
                            'Address verification needed.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
                      >
                        Put On Hold
                      </button>
                    </>
                  )}

                  {/* Transition: PROCESSING -> READY_FOR_DISPATCH */}
                  {selectedOrder.status === 'PROCESSING' && (
                    <>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'READY_FOR_DISPATCH',
                            'Package picked, weighed and sealed with packing slip.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors shadow-2xs"
                      >
                        Box Packed &rarr; READY_FOR_DISPATCH
                      </button>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'EXCEPTION_REVIEW',
                            'Packaging damaged during final inspection.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 transition-colors"
                      >
                        Flag Exception
                      </button>
                    </>
                  )}

                  {/* Transition: READY_FOR_DISPATCH -> SHIPPED */}
                  {selectedOrder.status === 'READY_FOR_DISPATCH' && (
                    <button
                      onClick={() =>
                        handleExecuteTransition(
                          'SHIPPED',
                          'Sendy / G4S courier driver loaded parcel onto outbound dispatch vehicle.',
                          {
                            shippingCarrier: 'Sendy Kenya Express',
                            trackingNumber: `SNDY-NBI-${Math.floor(100000 + Math.random() * 900000)}`,
                          }
                        )
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors shadow-2xs flex items-center gap-1.5"
                    >
                      <Truck className="w-3.5 h-3.5" />
                      <span>Scan Courier Label &rarr; SHIPPED</span>
                    </button>
                  )}

                  {/* Transition: SHIPPED -> DELIVERED or RETURN_REQUESTED */}
                  {selectedOrder.status === 'SHIPPED' && (
                    <>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'DELIVERED',
                            'Customer signed for parcel receipt.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors shadow-2xs"
                      >
                        Courier Confirmed Delivery &rarr; DELIVERED
                      </button>
                      <button
                        onClick={() =>
                          handleExecuteTransition(
                            'RETURN_REQUESTED',
                            'Customer requested return due to incorrect fit.'
                          )
                        }
                        className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                      >
                        Customer Return Request
                      </button>
                    </>
                  )}

                  {/* Transition: DELIVERED -> RETURN_REQUESTED */}
                  {selectedOrder.status === 'DELIVERED' && (
                    <button
                      onClick={() =>
                        handleExecuteTransition(
                          'RETURN_REQUESTED',
                          'Customer lodged return request within 30-day window.'
                        )
                      }
                      className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                    >
                      Start Return Request &rarr; RETURN_REQUESTED
                    </button>
                  )}

                  {/* Transition: RETURN_REQUESTED -> RETURNED */}
                  {selectedOrder.status === 'RETURN_REQUESTED' && (
                    <button
                      onClick={() =>
                        handleExecuteTransition(
                          'RETURNED',
                          'Item arrived at warehouse and passed QA inspection.'
                        )
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors shadow-2xs"
                    >
                      Inspect Received Goods &rarr; RETURNED
                    </button>
                  )}

                  {/* Transition: RETURNED -> REFUND_PENDING -> REFUNDED */}
                  {selectedOrder.status === 'RETURNED' && (
                    <button
                      onClick={() =>
                        handleExecuteTransition(
                          'REFUND_PENDING',
                          'Warehouse approved full return. Refund authorized for payment processor.'
                        )
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors shadow-2xs"
                    >
                      Authorize Refund &rarr; REFUND_PENDING
                    </button>
                  )}

                  {selectedOrder.status === 'REFUND_PENDING' && (
                    <button
                      onClick={() =>
                        handleExecuteTransition(
                          'REFUNDED',
                          'M-PESA / Pesapal reversal completed to customer mobile wallet.'
                        )
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors shadow-2xs"
                    >
                      Execute Payment Refund &rarr; REFUNDED
                    </button>
                  )}
                </div>
              )}

              {/* Illegal Jump Tester */}
              <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                <span className="text-slate-500">Test Invariant Enforcement:</span>
                <button
                  onClick={handleTestIllegalJump}
                  className="text-xs text-rose-700 hover:text-rose-900 font-medium underline"
                >
                  Attempt Illegal Direct Jump to DELIVERED
                </button>
              </div>
            </div>
          </div>

          {/* Immutable Audit Trail */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-2xs space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-600" />
              <span>Immutable State Transition Audit Trail</span>
            </h3>

            <div className="space-y-3">
              {selectedOrder.auditTrail.map((entry, idx) => (
                <div
                  key={entry.id || idx}
                  className="p-3 bg-slate-50/80 rounded-lg border border-slate-200/60 text-xs space-y-1 font-mono"
                >
                  <div className="flex items-center justify-between text-slate-500 text-[11px]">
                    <span className="flex items-center gap-1.5 font-sans font-semibold text-slate-800">
                      <User className="w-3.5 h-3.5 text-slate-400" />
                      {entry.actor} ({entry.actorRole})
                    </span>
                    <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                  </div>

                  <div className="flex items-center gap-2 pt-1 font-sans">
                    <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-mono text-[11px]">
                      {entry.fromStatus || 'INIT'}
                    </span>
                    <ArrowRight className="w-3 h-3 text-slate-400" />
                    <span className="px-1.5 py-0.5 rounded bg-slate-900 text-white font-mono text-[11px] font-bold">
                      {entry.toStatus}
                    </span>
                  </div>

                  <p className="text-slate-600 font-sans text-xs pt-1">
                    {entry.reason}
                  </p>

                  {entry.metadata && typeof entry.metadata.trackingNumber === 'string' && (
                    <div className="text-[11px] text-blue-700 font-mono pt-0.5">
                      Tracking: {String(entry.metadata.shippingCarrier || 'Carrier')} - {entry.metadata.trackingNumber}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Official KRA eTIMS Tax Invoice Modal */}
      {showInvoiceModal && selectedOrder && (
        <KraTaxInvoiceModal
          order={selectedOrder}
          tenant={tenant}
          onClose={() => setShowInvoiceModal(false)}
        />
      )}
    </div>
  );
};
