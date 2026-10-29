import React, { useState } from 'react';
import {
  Webhook,
  Layers,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Play,
  RotateCw,
  Cpu,
} from 'lucide-react';
import { Order, Tenant, WebhookEventRecord } from '../lib/types.ts';
import { IdempotencyStore } from '../lib/idempotency.ts';

interface AutomationHubViewProps {
  tenant: Tenant;
  orders: Order[];
  onOrderPaid: (orderId: string, transactionRef: string) => void;
}

export const AutomationHubView: React.FC<AutomationHubViewProps> = ({
  tenant,
  orders,
  onOrderPaid,
}) => {
  const [idempotencyStore] = useState(() => new IdempotencyStore());
  const [testIdempotencyKey, setTestIdempotencyKey] = useState<string>('evt_daraja_stk_99182');
  const [events, setEvents] = useState<WebhookEventRecord[]>([
    {
      id: 'evt-init-1',
      tenantId: tenant.id,
      provider: 'MPESA_DARAJA' as any,
      eventType: 'stk_push.succeeded',
      idempotencyKey: 'evt_daraja_seed_7712',
      processed: true,
      status: 'SUCCESS',
      receivedAt: new Date(Date.now() - 3600000).toISOString(),
      payload: { orderId: 'ORD-000008', mpesaReceiptCode: 'QKD73HD892', amount: 1143600, currency: 'KES' },
    },
  ]);
  const [lastResult, setLastResult] = useState<{
    status: 'SUCCESS' | 'DUPLICATE_IGNORED';
    message: string;
  } | null>(null);

  const simulateDarajaWebhook = () => {
    const acquireResult = idempotencyStore.acquire(
      tenant.id,
      'PAYMENT_WEBHOOK',
      testIdempotencyKey
    );

    const now = new Date().toISOString();

    if (acquireResult.status === 'CACHED') {
      const record: WebhookEventRecord = {
        id: `evt-${Date.now()}`,
        tenantId: tenant.id,
        provider: 'MPESA_DARAJA' as any,
        eventType: 'stk_push.succeeded',
        idempotencyKey: testIdempotencyKey,
        processed: true,
        status: 'DUPLICATE_IGNORED',
        receivedAt: now,
        payload: { orderId: 'ORD-000008', note: 'Duplicate Safaricom Daraja callback replay' },
      };

      setEvents((prev) => [record, ...prev]);
      setLastResult({
        status: 'DUPLICATE_IGNORED',
        message: `Idempotency guard triggered! Safaricom callback key "${testIdempotencyKey}" already processed. Safely returned HTTP 200 { "ResultCode": 0, "ResultDesc": "Success" } without double-crediting merchant ledger or releasing stock twice.`,
      });
      return;
    }

    // Process new payment
    idempotencyStore.resolve(tenant.id, 'PAYMENT_WEBHOOK', testIdempotencyKey, {
      orderId: 'ORD-000008',
      amount: 1143600,
      processed: true,
    });

    onOrderPaid('ORD-000008', testIdempotencyKey);

    const record: WebhookEventRecord = {
      id: `evt-${Date.now()}`,
      tenantId: tenant.id,
      provider: 'MPESA_DARAJA' as any,
      eventType: 'stk_push.succeeded',
      idempotencyKey: testIdempotencyKey,
      processed: true,
      status: 'SUCCESS',
      receivedAt: now,
      payload: { orderId: 'ORD-000008', mpesaReceiptCode: `QK${Math.floor(10000000 + Math.random() * 90000000)}`, amount: 1143600, currency: 'KES' },
    };

    setEvents((prev) => [record, ...prev]);
    setLastResult({
      status: 'SUCCESS',
      message: `Verified Safaricom Daraja STK Push callback for ORD-000008 (KSh 11,436.00). KRA eTIMS invoice generated and order transitioned to CONFIRMED.`,
    });
  };

  const generateNewKey = () => {
    setTestIdempotencyKey(`evt_daraja_stk_${Math.floor(10000 + Math.random() * 90000)}`);
    setLastResult(null);
  };

  return (
    <div className="space-y-8">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Integration Hub & n8n Workflow Automation (Kenya)
        </h1>
        <div className="flex items-center gap-2 text-xs text-slate-500 mt-1">
          <span>Safaricom Daraja STK Push</span>
          <span aria-hidden="true">·</span>
          <span>Idempotent Webhook Processing</span>
          <span aria-hidden="true">·</span>
          <span>KRA eTIMS & Boda Dispatch Event Orchestration</span>
        </div>
      </div>

      {/* Connected Adapters Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 bg-white border border-slate-200 rounded-xl shadow-2xs space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-slate-900 flex items-center gap-1.5">
              <Webhook className="w-4 h-4 text-emerald-600" />
              <span>Safaricom Daraja M-PESA</span>
            </span>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
              Active C2B & STK
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Paybill 247247 & Till 542910 webhook callback sync. Idempotency window: 60 minutes.
          </p>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-xl shadow-2xs space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-slate-900 flex items-center gap-1.5">
              <Cpu className="w-4 h-4 text-blue-600" />
              <span>n8n Kenya Orchestrator</span>
            </span>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800">
              Workflow Active
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Automates WhatsApp order receipts, KRA eTIMS invoice generation, and low-stock supplier reorders.
          </p>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-xl shadow-2xs space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-slate-900 flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-violet-600" />
              <span>Sendy & Fargo Courier Adapter</span>
            </span>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-violet-100 text-violet-800">
              Connected
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Nairobi same-day Boda rider dispatch and upcountry G4S/Fargo tracking milestone webhook sync.
          </p>
        </div>
      </div>

      {/* Webhook Testing Sandbox */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-2xs space-y-6">
        <div>
          <h2 className="text-sm font-bold text-slate-900">
            Safaricom M-PESA Daraja Callback Idempotency & Replay Simulator
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Simulate receiving an STK Push payment callback from Safaricom. Trigger it once, then trigger it again with the same key to verify that the platform safely returns HTTP 200 without double-crediting or duplicate stock deduction!
          </p>
        </div>

        <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-500 font-medium">Daraja Callback Key:</span>
              <span className="font-mono font-bold text-slate-900 bg-white px-2.5 py-1 rounded border border-slate-200">
                {testIdempotencyKey}
              </span>
            </div>

            <button
              onClick={generateNewKey}
              className="text-xs font-medium text-slate-600 hover:text-slate-900 flex items-center gap-1"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>Generate Fresh Key</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={simulateDarajaWebhook}
              className="px-4 py-2 text-xs font-bold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors shadow-2xs flex items-center gap-2"
            >
              <Play className="w-3.5 h-3.5 text-emerald-400" />
              <span>Fire Daraja M-PESA Callback (Target: ORD-000008 · KSh 11,436.00)</span>
            </button>
          </div>

          {lastResult && (
            <div
              className={`p-3.5 rounded-lg border text-xs flex items-start gap-2.5 ${
                lastResult.status === 'SUCCESS'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              {lastResult.status === 'SUCCESS' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              )}
              <div>
                <strong className="font-semibold">
                  {lastResult.status === 'SUCCESS' ? 'New Event Processed: ' : 'Duplicate Replay Blocked: '}
                </strong>
                {lastResult.message}
              </div>
            </div>
          )}
        </div>

        {/* Webhook Event Ingestion Stream */}
        <div>
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            Webhook Event Ingestion Audit Trail
          </h3>

          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3">Event ID</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Event Type</th>
                  <th className="px-4 py-3 font-mono">Idempotency Key</th>
                  <th className="px-4 py-3 text-right">Result</th>
                  <th className="px-4 py-3 text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                {events.map((evt) => (
                  <tr key={evt.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-4 py-3 font-bold text-slate-900">{evt.id}</td>
                    <td className="px-4 py-3 font-sans text-slate-700">{evt.provider}</td>
                    <td className="px-4 py-3 font-sans text-slate-600">{evt.eventType}</td>
                    <td className="px-4 py-3 text-slate-500">{evt.idempotencyKey}</td>
                    <td className="px-4 py-3 text-right font-sans">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          evt.status === 'SUCCESS'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {evt.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-400">
                      {new Date(evt.receivedAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
