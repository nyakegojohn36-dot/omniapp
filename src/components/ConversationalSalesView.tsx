import React, { useState } from 'react';
import { Bot, MessageSquare } from 'lucide-react';
import { Order, Product, Tenant, WarehouseInventory } from '../lib/types.ts';
import { InventoryStore } from '../lib/inventoryEngine.ts';
import { AiAssistantView } from './AiAssistantView.tsx';
import { WhatsAppChannelView } from './WhatsAppChannelView.tsx';

interface ConversationalSalesViewProps {
  tenant: Tenant;
  inventoryEngine?: InventoryStore;
  products: Product[];
  inventories: WarehouseInventory[];
  orders: Order[];
  onOrderCreated?: (order: Order) => void;
  onNavigateToOrder?: (orderId: string) => void;
  onNavigateToSupport?: () => void;
  initialSubTab?: 'assistant' | 'whatsapp';
}

export const ConversationalSalesView: React.FC<ConversationalSalesViewProps> = ({
  tenant,
  inventoryEngine,
  products,
  inventories,
  orders,
  onOrderCreated,
  onNavigateToOrder,
  onNavigateToSupport,
  initialSubTab = 'assistant',
}) => {
  const [activeChannel, setActiveChannel] = useState<'assistant' | 'whatsapp'>(initialSubTab);

  // Fallback inventory store if not provided
  const storeInstance = React.useMemo(() => {
    return inventoryEngine || new InventoryStore([]);
  }, [inventoryEngine]);

  return (
    <div className="space-y-6">
      {/* Sub-channel switcher */}
      <div className="flex items-center justify-start">
        <div className="inline-flex p-1 bg-slate-100 rounded-xl border border-slate-200 shadow-2xs">
          <button
            type="button"
            onClick={() => setActiveChannel('assistant')}
            className={`flex items-center gap-2.5 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeChannel === 'assistant'
                ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <div className={`w-5 h-5 rounded-md flex items-center justify-center ${
              activeChannel === 'assistant' ? 'bg-purple-100 text-purple-700' : 'bg-slate-200 text-slate-600'
            }`}>
              <Bot className="w-3.5 h-3.5" />
            </div>
            <div className="text-left">
              <div className="leading-tight">AI Sales Assistant</div>
              <div className="text-[10px] text-slate-400 font-normal">Autonomous Advisor</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveChannel('whatsapp')}
            className={`flex items-center gap-2.5 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeChannel === 'whatsapp'
                ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <div className={`w-5 h-5 rounded-md flex items-center justify-center ${
              activeChannel === 'whatsapp' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
            }`}>
              <MessageSquare className="w-3.5 h-3.5" />
            </div>
            <div className="text-left">
              <div className="leading-tight">WhatsApp Channel</div>
              <div className="text-[10px] text-slate-400 font-normal">Cloud API Simulator</div>
            </div>
          </button>
        </div>
      </div>

      {/* Selected Channel View Content */}
      <div className="transition-all duration-200">
        {activeChannel === 'assistant' ? (
          <AiAssistantView
            tenant={tenant}
            products={products}
            inventories={inventories}
            orders={orders}
          />
        ) : (
          <WhatsAppChannelView
            tenant={tenant}
            inventoryEngine={storeInstance}
            products={products}
            orders={orders}
            onOrderCreated={onOrderCreated}
            onNavigateToOrder={onNavigateToOrder}
            onNavigateToSupport={onNavigateToSupport}
          />
        )}
      </div>
    </div>
  );
};
