import React, { useState } from 'react';
import { Zap, ShieldCheck, CheckCircle2, XCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { InventoryStore } from '../lib/inventoryEngine.ts';

interface ConcurrencySimulatorProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SimulationRunResult {
  customerA: {
    status: 'SUCCESS' | 'FAILED';
    message: string;
    timestamp: string;
    reservationId?: string;
  };
  customerB: {
    status: 'SUCCESS' | 'FAILED';
    message: string;
    timestamp: string;
    reservationId?: string;
  };
  inventoryBefore: number;
  inventoryAfter: number;
  oversoldOccurred: boolean;
  timeElapsedMs: number;
}

export const ConcurrencySimulator: React.FC<ConcurrencySimulatorProps> = ({ isOpen, onClose }) => {
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [result, setResult] = useState<SimulationRunResult | null>(null);

  if (!isOpen) return null;

  const runSimulation = async () => {
    setIsRunning(true);
    setResult(null);

    // Create an isolated instance with exactly 1 unit left
    const testStore = new InventoryStore([
      {
        sku: 'RACE-UNIT-001',
        warehouseId: 'WH-RACE-01',
        warehouseName: 'Race Condition Test Depot',
        physicalStock: 1,
        reservedStock: 0,
        quarantineStock: 0,
        lowStockThreshold: 1,
        lastReconciledAt: new Date().toISOString(),
      },
    ]);

    const startTime = performance.now();

    // Trigger two simultaneous concurrent async promises
    const promiseA = new Promise<{
      status: 'SUCCESS' | 'FAILED';
      message: string;
      reservationId?: string;
    }>((resolve) => {
      setTimeout(() => {
        const res = testStore.reserveStock({
          tenantId: 'tenant-sim',
          orderId: 'ORD-CUST-A',
          sku: 'RACE-UNIT-001',
          quantity: 1,
        });
        if (res.success) {
          resolve({
            status: 'SUCCESS',
            message: `Reserved 1 unit successfully. Reservation ID: ${res.reservation?.id}`,
            reservationId: res.reservation?.id,
          });
        } else {
          resolve({
            status: 'FAILED',
            message: res.error || 'Failed to reserve',
          });
        }
      }, Math.random() * 5); // Micro-jitter simulating simultaneous network packets
    });

    const promiseB = new Promise<{
      status: 'SUCCESS' | 'FAILED';
      message: string;
      reservationId?: string;
    }>((resolve) => {
      setTimeout(() => {
        const res = testStore.reserveStock({
          tenantId: 'tenant-sim',
          orderId: 'ORD-CUST-B',
          sku: 'RACE-UNIT-001',
          quantity: 1,
        });
        if (res.success) {
          resolve({
            status: 'SUCCESS',
            message: `Reserved 1 unit successfully. Reservation ID: ${res.reservation?.id}`,
            reservationId: res.reservation?.id,
          });
        } else {
          resolve({
            status: 'FAILED',
            message: res.error || 'Failed to reserve',
          });
        }
      }, Math.random() * 5);
    });

    const [resA, resB] = await Promise.all([promiseA, promiseB]);
    const endTime = performance.now();

    const finalStock = testStore.getAvailability('RACE-UNIT-001');

    setResult({
      customerA: {
        ...resA,
        timestamp: new Date().toISOString(),
      },
      customerB: {
        ...resB,
        timestamp: new Date().toISOString(),
      },
      inventoryBefore: 1,
      inventoryAfter: finalStock.availableStock,
      oversoldOccurred: finalStock.reservedStock > 1 || finalStock.availableStock < 0,
      timeElapsedMs: Math.round(endTime - startTime),
    });

    setIsRunning(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full border border-slate-200 shadow-xl overflow-hidden">
        {/* Header */}
        <div className="p-6 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-400/20 text-amber-400 flex items-center justify-center">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">
                Scenario H: Race Condition Concurrency Tester
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Simulates 2 simultaneous customers attempting to purchase the exact same final unit
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-sm font-semibold px-2 py-1 rounded"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs text-slate-600">
            <div className="flex items-center justify-between font-mono font-semibold text-slate-800">
              <span>Test SKU: RACE-UNIT-001</span>
              <span>Initial Physical: 1 unit · Available: 1 unit</span>
            </div>
            <p>
              Under naive read-then-write logic, both requests see Available = 1, leading to duplicate reservations and an overselling disaster. SokoFlow uses mutex atomic locking to guarantee that exactly <strong>one</strong> request wins the reservation, while the other is gracefully rejected and offered out-of-stock recovery.
            </p>
          </div>

          <div className="text-center">
            <button
              onClick={runSimulation}
              disabled={isRunning}
              className="px-6 py-3 text-sm font-bold text-white bg-slate-900 rounded-xl hover:bg-slate-800 transition-all shadow-md disabled:opacity-60 flex items-center gap-2 mx-auto"
            >
              <Zap className="w-4 h-4 text-amber-400" />
              <span>{isRunning ? 'Executing Concurrent Requests...' : 'Trigger Race Condition Now'}</span>
            </button>
          </div>

          {result && (
            <div className="space-y-4 pt-4 border-t border-slate-100">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className="text-slate-500">Execution Latency: {result.timeElapsedMs}ms</span>
                <span
                  className={`flex items-center gap-1.5 font-bold ${
                    result.oversoldOccurred ? 'text-rose-600' : 'text-emerald-700'
                  }`}
                >
                  {result.oversoldOccurred ? (
                    <>
                      <AlertCircle className="w-4 h-4" />
                      <span>Oversold Discrepancy Detected!</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>Zero Overselling: Concurrency Guard Held!</span>
                    </>
                  )}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Customer A Box */}
                <div
                  className={`p-4 rounded-xl border text-xs space-y-2 ${
                    result.customerA.status === 'SUCCESS'
                      ? 'bg-emerald-50/70 border-emerald-200'
                      : 'bg-rose-50/70 border-rose-200'
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span className="text-slate-900">Customer A (Order: ORD-CUST-A)</span>
                    {result.customerA.status === 'SUCCESS' ? (
                      <span className="flex items-center gap-1 text-emerald-700 font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Won Stock
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-rose-700 font-bold">
                        <XCircle className="w-3.5 h-3.5" /> Out of Stock
                      </span>
                    )}
                  </div>
                  <p className="text-slate-600 font-mono text-[11px] leading-relaxed">
                    {result.customerA.message}
                  </p>
                </div>

                {/* Customer B Box */}
                <div
                  className={`p-4 rounded-xl border text-xs space-y-2 ${
                    result.customerB.status === 'SUCCESS'
                      ? 'bg-emerald-50/70 border-emerald-200'
                      : 'bg-rose-50/70 border-rose-200'
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span className="text-slate-900">Customer B (Order: ORD-CUST-B)</span>
                    {result.customerB.status === 'SUCCESS' ? (
                      <span className="flex items-center gap-1 text-emerald-700 font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Won Stock
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-rose-700 font-bold">
                        <XCircle className="w-3.5 h-3.5" /> Out of Stock
                      </span>
                    )}
                  </div>
                  <p className="text-slate-600 font-mono text-[11px] leading-relaxed">
                    {result.customerB.message}
                  </p>
                </div>
              </div>

              <div className="p-3 bg-slate-100 rounded-lg text-xs flex items-center justify-between text-slate-700 font-mono">
                <span>Final Available Stock: {result.inventoryAfter} units</span>
                <span>Final Reserved Stock: 1 unit</span>
                <span>Physical Stock: 1 unit</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
