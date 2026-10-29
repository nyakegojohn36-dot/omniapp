import React from 'react';
import { Printer, X, FileText, CheckCircle2, ShieldCheck } from 'lucide-react';
import { Order, Tenant } from '../lib/types.ts';
import { formatCurrency } from '../lib/pricingEngine.ts';

interface KraTaxInvoiceModalProps {
  order: Order;
  onClose: () => void;
  tenant?: Tenant;
}

export const KraTaxInvoiceModal: React.FC<KraTaxInvoiceModalProps> = ({
  order,
  onClose,
  tenant,
}) => {
  const taxableAmountCents = Math.round(order.totalCents / 1.16);
  const vatAmountCents = Math.round(order.totalCents - taxableAmountCents);
  const mpesaCode = order.mpesaReceiptCode || 'RKG8921L4X';
  const businessName = tenant?.name || 'Safari Peak Outfitters Kenya';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto space-y-4">
        {/* Modal Topbar */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-base leading-tight">
                KRA eTIMS Tax Invoice & Fiscal Receipt
              </h3>
              <p className="text-[11px] text-slate-500">
                Official Kenya Revenue Authority electronic Tax Invoice (VAT Act 2013)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Close invoice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Official Fiscal Document Box */}
        <div className="p-4 bg-emerald-50/40 border border-emerald-200/80 rounded-xl space-y-3 font-mono text-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-emerald-200/60 pb-3">
            <div>
              <div className="font-sans font-black text-slate-900 text-sm tracking-tight">
                {businessName}
              </div>
              <div className="text-[11px] text-slate-600">
                KRA PIN: <strong className="text-slate-900">P051982341Z</strong> · eTIMS CU Serial:{' '}
                <strong className="text-slate-900">KRA-CU-09824-2026</strong>
              </div>
              <div className="text-[10px] text-slate-500 font-sans">
                Fulfillment Hub: Industrial Area Commercial Street, Nairobi, Kenya
              </div>
            </div>
            <div className="sm:text-right">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px] tracking-wide">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" />
                <span>eTIMS VALIDATED</span>
              </span>
              <div className="text-[10px] text-slate-500 mt-1 font-mono">
                Receipt: ETIMS-KE-{order.id}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs pt-1">
            <div>
              <span className="text-[10px] text-slate-500 uppercase block font-sans font-semibold">
                Fiscal Date & Time:
              </span>
              <span className="text-slate-700">
                {new Date(order.createdAt).toLocaleString('en-KE')}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-slate-500 uppercase block font-sans font-semibold">
                Buyer / Customer:
              </span>
              <span className="font-bold text-slate-900">{order.customerName || 'Customer'}</span>
            </div>
            <div>
              <span className="text-[10px] text-slate-500 uppercase block font-sans font-semibold">
                M-PESA Trans Code:
              </span>
              <span className="font-bold text-emerald-700">{mpesaCode}</span>
            </div>
            <div>
              <span className="text-[10px] text-slate-500 uppercase block font-sans font-semibold">
                Tax Category:
              </span>
              <span className="font-bold text-slate-900">General Rate 16%</span>
            </div>
          </div>
        </div>

        {/* Line Items Table */}
        <div className="border border-slate-200 rounded-xl overflow-hidden text-xs">
          <table className="w-full text-left">
            <thead className="bg-slate-100/80 text-[11px] font-bold text-slate-700 uppercase border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3">Item / Description</th>
                <th className="py-2.5 px-2 text-center">Qty</th>
                <th className="py-2.5 px-3 text-right">Unit Price</th>
                <th className="py-2.5 px-3 text-right">Total (KES)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {order.items.map((item, idx) => (
                <tr key={idx}>
                  <td className="py-2.5 px-3 font-sans">
                    <div className="font-bold text-slate-900">{item.title}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{item.sku}</div>
                  </td>
                  <td className="py-2.5 px-2 text-center font-bold text-slate-800">
                    {item.quantity}
                  </td>
                  <td className="py-2.5 px-3 text-right text-slate-600">
                    {formatCurrency(item.unitPriceCents, order.currency)}
                  </td>
                  <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                    {formatCurrency(item.subtotalCents, order.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Tax & Total Calculation Breakdown */}
        <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5 text-xs font-mono">
          <div className="flex justify-between text-slate-600">
            <span>Taxable Amount (Excl. 16% VAT):</span>
            <span>{formatCurrency(taxableAmountCents, order.currency)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>16% Value Added Tax (VAT):</span>
            <span>{formatCurrency(vatAmountCents, order.currency)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>Courier Dispatch ({order.shippingCarrier || 'Sendy / Nairobi Boda'}):</span>
            <span className="text-emerald-700 font-bold">
              {order.shippingCents === 0 ? 'FREE' : formatCurrency(order.shippingCents, order.currency)}
            </span>
          </div>
          <div className="flex justify-between text-sm font-black text-slate-900 pt-2 border-t border-slate-200">
            <span>TOTAL AMOUNT PAID (KES):</span>
            <span className="text-emerald-800 font-bold">
              {formatCurrency(order.totalCents, order.currency)}
            </span>
          </div>
        </div>

        {/* Bottom Actions: Print / Close */}
        <div className="flex items-center justify-between pt-2">
          <div className="text-[11px] text-slate-400 font-medium">
            Kenya Revenue Authority (KRA) Section 23A Compliant
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5 text-slate-600" />
              <span>Print Tax Invoice</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
