import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  DollarSign,
  Package,
  RefreshCw,
  RotateCcw,
  Shield,
  Truck,
  XCircle,
} from 'lucide-react';
import type { Order, Tenant, UserRole } from '../lib/types.ts';
import type { ReturnReason, ReturnRequest, ReturnStatus } from '../lib/returns.ts';
import { formatCurrency } from '../lib/pricingEngine.ts';
import {
  inspectReturnAtWarehouse,
  listReturns,
  payRefund,
  raiseReturn,
  receiveReturnAtWarehouse,
} from '../lib/returnsClient.ts';

/**
 * The customer-facing surface of the returns pipeline.
 *
 * Every button here posts to the server and renders the state that comes back.
 * Nothing is optimistically faked: a claim is only "raised" once the API has
 * returned the case, and a refund is only "paid" once a reference is recorded.
 */

const WAREHOUSE_ROLES: UserRole[] = ['SUPER_ADMIN', 'BUSINESS_OWNER', 'FULFILLMENT_STAFF'];
const REFUND_ROLES: UserRole[] = ['SUPER_ADMIN', 'BUSINESS_OWNER'];

const REASON_LABELS: Record<ReturnReason, string> = {
  DAMAGED_IN_TRANSIT: 'Damaged in transit',
  WRONG_ITEM: 'Wrong item delivered',
  NOT_AS_DESCRIBED: 'Not as described',
  FAULTY: 'Faulty on arrival',
  CHANGED_MIND: 'Changed mind',
};

const STATUS_STYLES: Record<ReturnStatus, string> = {
  REQUESTED: 'bg-amber-100 text-amber-800 border-amber-200',
  RECEIVED: 'bg-blue-100 text-blue-800 border-blue-200',
  INSPECTED: 'bg-purple-100 text-purple-800 border-purple-200',
  REJECTED: 'bg-rose-100 text-rose-800 border-rose-200',
  CLOSED: 'bg-emerald-100 text-emerald-800 border-emerald-200',
};

const ACTION_BUTTON =
  'px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

interface ReturnsPanelProps {
  tenant: Tenant;
  currentRole: UserRole;
  /** Narrows the panel to a single order. Used by the support desk. */
  orderId?: string;
  /** 'flat' drops the outer card so it can sit inside an existing panel. */
  variant?: 'card' | 'flat';
  /** Bump to force a reload, e.g. after a claim is raised elsewhere on the page. */
  refreshToken?: number;
  onOrderUpdated?: (order: Order) => void;
}

export const ReturnsPanel: React.FC<ReturnsPanelProps> = ({
  tenant,
  currentRole,
  orderId,
  variant = 'card',
  refreshToken = 0,
  onOrderUpdated,
}) => {
  const [records, setRecords] = useState<ReturnRequest[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Inspection is a grading exercise, so one case is open at a time.
  const [inspectionId, setInspectionId] = useState<string | null>(null);
  const [restockDraft, setRestockDraft] = useState<Record<string, number>>({});
  const [inspectionNote, setInspectionNote] = useState<string>('');

  const [refundId, setRefundId] = useState<string | null>(null);
  const [refundReference, setRefundReference] = useState<string>('');

  const canHandleGoods = WAREHOUSE_ROLES.includes(currentRole);
  const canReleaseRefund = REFUND_ROLES.includes(currentRole);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setRecords(await listReturns());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Loading return cases failed.');
    } finally {
      setIsLoading(false);
    }
  }, [refreshToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timeout);
  }, [notice]);

  const visible = useMemo(
    () => (orderId ? records.filter((record) => record.orderId === orderId) : records),
    [records, orderId]
  );

  const runAction = async (
    returnId: string,
    successText: string,
    action: () => Promise<{ order: Order; returnRequest: ReturnRequest }>
  ) => {
    setBusyId(returnId);
    try {
      const result = await action();
      setRecords((previous) =>
        previous.map((record) =>
          record.id === result.returnRequest.id ? result.returnRequest : record
        )
      );
      onOrderUpdated?.(result.order);
      setInspectionId(null);
      setRefundId(null);
      setRefundReference('');
      setInspectionNote('');
      setNotice({ tone: 'ok', text: successText });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'The action failed.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const openInspection = (record: ReturnRequest) => {
    setInspectionId(record.id);
    setInspectionNote('');
    setRestockDraft(
      Object.fromEntries(record.lines.map((line) => [line.sku, line.quantity]))
    );
  };

  const submitInspection = (record: ReturnRequest, decision: 'APPROVE' | 'REJECT') => {
    const restock =
      decision === 'APPROVE'
        ? Object.fromEntries(
            record.lines.map((line) => {
              const raw = Number(restockDraft[line.sku] ?? line.quantity);
              const bounded = Number.isFinite(raw) ? Math.floor(raw) : line.quantity;
              return [line.sku, Math.min(line.quantity, Math.max(0, bounded))];
            })
          )
        : undefined;

    void runAction(
      record.id,
      decision === 'APPROVE'
        ? `Return ${record.id} graded. Sellable units are back on the shelf; the rest is written off.`
        : `Return ${record.id} rejected. Its units have gone back to the customer.`,
      () =>
        inspectReturnAtWarehouse(record.id, {
          decision,
          restock,
          note: inspectionNote.trim() || undefined,
        })
    );
  };

  const submitRefund = (record: ReturnRequest) => {
    const reference = refundReference.trim();
    if (!reference) {
      setNotice({
        tone: 'error',
        text: 'Enter the M-PESA reversal reference before recording the refund.',
      });
      return;
    }
    void runAction(record.id, `Refund recorded against ${reference}.`, () =>
      payRefund(record.id, reference)
    );
  };

  const renderActions = (record: ReturnRequest) => {
    if (record.status === 'REQUESTED') {
      if (!canHandleGoods) {
        return (
          <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-slate-400" />
            Waiting for the warehouse to book these units in.
          </p>
        );
      }
      return (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyId === record.id}
            onClick={() =>
              void runAction(
                record.id,
                `Return ${record.id} booked into quarantine. The units are counted but not sellable until graded.`,
                () => receiveReturnAtWarehouse(record.id)
              )
            }
            className={`${ACTION_BUTTON} bg-blue-600 hover:bg-blue-700 text-white border-blue-600`}
          >
            {busyId === record.id ? 'Booking in…' : 'Receive at warehouse'}
          </button>
          <span className="text-[11px] text-slate-500">
            Goes into quarantine, not onto the shelf.
          </span>
        </div>
      );
    }

    if (record.status === 'RECEIVED') {
      if (!canHandleGoods) {
        return (
          <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-slate-400" />
            In quarantine, awaiting a warehouse inspection.
          </p>
        );
      }
      if (inspectionId !== record.id) {
        return (
          <button
            type="button"
            onClick={() => openInspection(record)}
            className={`${ACTION_BUTTON} bg-slate-900 hover:bg-slate-800 text-white border-slate-900`}
          >
            Grade & inspect
          </button>
        );
      }
      return (
        <div className="space-y-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg">
          <p className="text-[11px] text-slate-600">
            Enter how many of each line are fit to sell again. The remainder is written off.
          </p>
          {record.lines.map((line) => (
            <div key={line.sku} className="flex items-center justify-between gap-2 text-xs">
              <span className="font-mono text-slate-700">{line.sku}</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={line.quantity}
                  value={restockDraft[line.sku] ?? line.quantity}
                  onChange={(event) => {
                    const next = event.target.value === '' ? 0 : Number(event.target.value);
                    setRestockDraft((previous) => ({ ...previous, [line.sku]: next }));
                  }}
                  className="w-16 px-2 py-1 border border-slate-200 rounded text-right font-mono focus:outline-none focus:ring-1 focus:ring-slate-400"
                />
                <span className="text-slate-500">of {line.quantity} sellable</span>
              </div>
            </div>
          ))}
          <input
            type="text"
            value={inspectionNote}
            onChange={(event) => setInspectionNote(event.target.value)}
            placeholder="Inspection note (optional)"
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-slate-400"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busyId === record.id}
              onClick={() => submitInspection(record, 'APPROVE')}
              className={`${ACTION_BUTTON} bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600`}
            >
              Approve & restock
            </button>
            <button
              type="button"
              disabled={busyId === record.id}
              onClick={() => submitInspection(record, 'REJECT')}
              className={`${ACTION_BUTTON} bg-white hover:bg-rose-50 text-rose-700 border-rose-200`}
            >
              Reject return
            </button>
            <button
              type="button"
              onClick={() => setInspectionId(null)}
              className={`${ACTION_BUTTON} bg-white hover:bg-slate-100 text-slate-600 border-slate-200`}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    if (record.status === 'INSPECTED') {
      if (!canReleaseRefund) {
        return (
          <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
            <Shield className="w-3 h-3 text-slate-400" />
            Inspection passed. The refund needs an owner to release it.
          </p>
        );
      }
      if (refundId !== record.id) {
        return (
          <button
            type="button"
            onClick={() => {
              setRefundId(record.id);
              setRefundReference('');
            }}
            className={`${ACTION_BUTTON} bg-slate-900 hover:bg-slate-800 text-white border-slate-900 flex items-center gap-1`}
          >
            <DollarSign className="w-3 h-3" />
            Record refund
          </button>
        );
      }
      return (
        <div className="space-y-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
          <p className="text-[11px] text-slate-600">
            Reverse {formatCurrency(record.refundCents, tenant.currency)} in Daraja, then record the
            reference here. SokoFlow does not move the money itself.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={refundReference}
              onChange={(event) => setRefundReference(event.target.value)}
              placeholder="e.g. SLK7Q2X9YZ"
              className="flex-1 min-w-40 px-2.5 py-1.5 border border-slate-200 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-slate-400"
            />
            <button
              type="button"
              disabled={busyId === record.id}
              onClick={() => submitRefund(record)}
              className={`${ACTION_BUTTON} bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600`}
            >
              Confirm paid
            </button>
            <button
              type="button"
              onClick={() => setRefundId(null)}
              className={`${ACTION_BUTTON} bg-white hover:bg-slate-100 text-slate-600 border-slate-200`}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    if (record.status === 'REJECTED') {
      return (
        <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
          <XCircle className="w-3 h-3 text-rose-500" />
          Rejected at inspection. The units went back to the customer.
        </p>
      );
    }

    return (
      <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
        Case closed. Stock and refund are reconciled.
      </p>
    );
  };

  const shell =
    variant === 'card'
      ? 'bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs space-y-3'
      : 'pt-3 border-t border-slate-100 space-y-3';

  return (
    <div className={shell}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <RotateCcw className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-bold text-slate-900">Returns & Quarantine</h3>
          {visible.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
              {visible.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {notice && (
        <div
          className={`p-2.5 rounded-lg border text-[11px] flex items-start gap-2 ${
            notice.tone === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          {notice.tone === 'ok' ? (
            <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          ) : (
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          )}
          <span className="font-medium">{notice.text}</span>
        </div>
      )}

      {loadError && (
        <div className="p-2.5 rounded-lg border border-rose-200 bg-rose-50 text-[11px] text-rose-800 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="font-medium">{loadError}</span>
        </div>
      )}

      {isLoading && visible.length === 0 && !loadError && (
        <p className="text-[11px] text-slate-500">Loading return cases…</p>
      )}

      {!isLoading && visible.length === 0 && !loadError && (
        <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
          <Package className="w-3.5 h-3.5 text-slate-400" />
          {orderId
            ? 'No return has been raised against this order.'
            : 'No returns have been raised. Goods only appear here once a customer claims one.'}
        </p>
      )}

      <div className="space-y-2.5">
        {visible.map((record) => (
          <div
            key={record.id}
            className="border border-slate-200 rounded-xl p-3 space-y-2.5 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-slate-900">{record.id}</span>
                <span className="text-slate-300">·</span>
                <span className="font-mono text-slate-500">{record.orderId}</span>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${STATUS_STYLES[record.status]}`}
              >
                {record.status}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
              <span className="font-semibold text-slate-800">
                {REASON_LABELS[record.reason]}
              </span>
              <span className="text-slate-300">·</span>
              <span>
                Refund {formatCurrency(record.refundCents, tenant.currency)}
              </span>
              {record.note && (
                <>
                  <span className="text-slate-300">·</span>
                  <span className="italic">“{record.note}”</span>
                </>
              )}
            </div>

            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {record.lines.map((line) => (
                <div
                  key={`${record.id}-${line.sku}`}
                  className="py-1.5 flex items-center justify-between gap-2 font-mono text-[11px]"
                >
                  <span className="text-slate-700">
                    {line.sku} × {line.quantity}
                  </span>
                  <span className="text-slate-500 flex items-center gap-1.5">
                    <Truck className="w-3 h-3" />
                    {line.warehouseId}
                    {typeof line.restockQuantity === 'number' && (
                      <span className="text-emerald-700 font-semibold">
                        {line.restockQuantity} sellable
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>

            {renderActions(record)}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400 font-mono">
              <span>raised {new Date(record.requestedAt).toLocaleString()}</span>
              {record.receivedAt && <span>received {new Date(record.receivedAt).toLocaleString()}</span>}
              {record.inspectedAt && (
                <span>inspected {new Date(record.inspectedAt).toLocaleString()}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

interface ReturnRequestActionProps {
  tenant: Tenant;
  order: Order;
  /** Called once the server has accepted the claim, with the updated order. */
  onOrderUpdated?: (order: Order) => void;
}

/**
 * The claimant's side: raise a return against one order.
 *
 * Only delivered orders can be claimed, and the server refuses a second open
 * case, so this renders a status line instead of a button once a case exists.
 */
export const ReturnRequestAction: React.FC<ReturnRequestActionProps> = ({
  tenant,
  order,
  onOrderUpdated,
}) => {
  const claimable = useMemo(() => {
    // Two order lines can share a SKU; the API judges claims per SKU, so merge
    // them here rather than sending a payload it will reject as a duplicate.
    const bySku = new Map<string, number>();
    for (const item of order.items) {
      bySku.set(item.sku, (bySku.get(item.sku) ?? 0) + item.quantity);
    }
    return [...bySku.entries()].map(([sku, quantity]) => ({ sku, quantity }));
  }, [order.items]);

  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [reason, setReason] = useState<ReturnReason>('DAMAGED_IN_TRANSIT');
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(claimable.map((line) => [line.sku, line.quantity]))
  );
  const [note, setNote] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [raised, setRaised] = useState<string | null>(null);

  const submit = async () => {
    const lines = claimable
      .map((line) => {
        const raw = Number(quantities[line.sku] ?? line.quantity);
        const bounded = Number.isFinite(raw) ? Math.floor(raw) : line.quantity;
        return { sku: line.sku, quantity: Math.min(line.quantity, Math.max(0, bounded)) };
      })
      .filter((line) => line.quantity > 0);

    if (lines.length === 0) {
      setError('Choose at least one unit to return.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const result = await raiseReturn({
        orderId: order.id,
        lines,
        reason,
        note: note.trim() || undefined,
      });
      setRaised(result.returnRequest.id);
      setIsOpen(false);
      onOrderUpdated?.(result.order);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : 'Raising the return failed.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (raised) {
    return (
      <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-900 flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">
          Return {raised} raised. {formatCurrency(order.totalCents, tenant.currency)} is refundable
          once the warehouse inspects the goods.
        </span>
      </div>
    );
  }

  if (order.status === 'RETURN_REQUESTED') {
    return (
      <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-900 flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">
          A return is already open on this order and is being handled by the warehouse.
        </span>
      </div>
    );
  }

  if (order.status !== 'DELIVERED') {
    return null;
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => {
          setIsOpen(true);
          setError(null);
        }}
        className="w-full sm:w-auto px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
      >
        <RotateCcw className="w-3.5 h-3.5" />
        <span>Request a return</span>
      </button>
    );
  }

  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-bold text-slate-900">
        <RotateCcw className="w-3.5 h-3.5" />
        <span>Return request for {order.id}</span>
      </div>

      <div className="space-y-1.5">
        {claimable.map((line) => (
          <div key={line.sku} className="flex items-center justify-between gap-2">
            <span className="font-mono text-slate-700">{line.sku}</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={line.quantity}
                value={quantities[line.sku] ?? line.quantity}
                onChange={(event) => {
                  const next = event.target.value === '' ? 0 : Number(event.target.value);
                  setQuantities((previous) => ({ ...previous, [line.sku]: next }));
                }}
                className="w-16 px-2 py-1 border border-slate-200 rounded text-right font-mono focus:outline-none focus:ring-1 focus:ring-slate-400"
              />
              <span className="text-slate-500">of {line.quantity}</span>
            </div>
          </div>
        ))}
      </div>

      <select
        value={reason}
        onChange={(event) => setReason(event.target.value as ReturnReason)}
        className="w-full px-2.5 py-1.5 border border-slate-200 rounded bg-white focus:outline-none"
      >
        {(Object.keys(REASON_LABELS) as ReturnReason[]).map((value) => (
          <option key={value} value={value}>
            {REASON_LABELS[value]}
          </option>
        ))}
      </select>

      <input
        type="text"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What went wrong? (optional)"
        className="w-full px-2.5 py-1.5 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-slate-400"
      />

      <p className="text-[11px] text-slate-500">
        The refund is calculated from what you actually paid, not from today's prices.
      </p>

      {error && (
        <div className="p-2 bg-rose-50 border border-rose-200 rounded text-[11px] text-rose-800 flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="font-medium">{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => void submit()}
          className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-[11px] font-semibold disabled:opacity-50"
        >
          {isSubmitting ? 'Raising…' : 'Submit return request'}
        </button>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 rounded-lg text-[11px] font-semibold"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
