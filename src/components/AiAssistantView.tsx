import React, { useState, useRef, useEffect } from 'react';
import { Bot, Send, User, Sparkles } from 'lucide-react';
import type { Tenant } from '../lib/types.ts';
import { apiFetch, firebaseAuth } from '../lib/firebaseClient.ts';

interface Message {
  id: string;
  sender: 'USER' | 'AI';
  text: string;
  timestamp: string;
}

interface AiAssistantViewProps {
  tenant: Tenant;
}

export const AiAssistantView: React.FC<AiAssistantViewProps> = ({
  tenant,
}) => {
  const [input, setInput] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'msg-welcome',
      sender: 'AI',
      text: `Welcome! Ask Gemini about ${tenant.name}'s catalogue, current stock, or recent order statuses. I am read-only and cannot place orders, take payments, or issue refunds. Each question uses a fresh workspace snapshot.`,
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  useEffect(() => () => { requestRef.current?.abort(); }, []);

  const processUserMessage = async (userText: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    requestRef.current = controller;
    const identity = firebaseAuth?.currentUser ?? null;
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(), sender: 'USER', text: userText,
      timestamp: new Date().toLocaleTimeString(),
    }]);
    setIsProcessing(true);
    setError(null);
    try {
      const response = await apiFetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: userText }),
        signal: controller.signal,
      }, identity);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The assistant is unavailable.');
      if (typeof data.reply !== 'string') throw new Error('The assistant returned no answer.');
      if (!controller.signal.aborted) setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), sender: 'AI', text: data.reply,
        timestamp: new Date().toLocaleTimeString(),
      }]);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not reach Gemini.');
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) setIsProcessing(false);
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isProcessing) return;
    const txt = input.trim();
    setInput('');
    processUserMessage(txt);
  };

  const handleQuickPrompt = (promptText: string) => {
    processUserMessage(promptText);
  };

  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          AI Customer Service & Sales Assistant
        </h1>
        <div className="flex items-center gap-2 text-xs text-slate-500 mt-1">
          <span>Gemini · server-side Google Cloud connection</span>
          <span aria-hidden="true">·</span>
          <span>Read-only · verify AI answers before acting</span>
          <span aria-hidden="true">·</span>
          <span>No fiscal receipts are issued here</span>
        </div>
      </div>

      {/* Suggested Customer Inquiries */}
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-2xs space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
          <Sparkles className="w-4 h-4 text-emerald-600" />
          <span>Frequently Asked Inquiries (Quick Inbound Test Prompts):</span>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <button
            disabled={isProcessing}
            onClick={() => handleQuickPrompt('Summarize the products and available stock in this workspace.')}
            className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 transition-colors font-medium"
          >
            Catalogue and Stock
          </button>
          <button
            disabled={isProcessing}
            onClick={() => handleQuickPrompt('Which products are out of stock in this snapshot?')}
            className="px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 transition-colors font-medium"
          >
            Out-of-Stock Products
          </button>
          <button
            disabled={isProcessing}
            onClick={() => handleQuickPrompt('Summarize the listed prices and tax settings. Do not calculate a checkout total.')}
            className="px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 transition-colors font-medium"
          >
            Prices and Tax Settings
          </button>
          <button
            disabled={isProcessing}
            onClick={() => handleQuickPrompt('Summarize recent order statuses in this workspace.')}
            className="px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-800 border border-blue-200 transition-colors font-medium"
          >
            Recent Orders
          </button>
          <button
            disabled={isProcessing}
            onClick={() => handleQuickPrompt('What can you help with, and which actions require a person?')}
            className="px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 transition-colors font-medium"
          >
            Assistant Capabilities
          </button>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {/* Chat Window */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-2xs overflow-hidden flex flex-col h-[600px]">
        {/* Messages Scroll Area */}
        <div className="flex-1 p-6 overflow-y-auto space-y-5">
          {messages.map((msg) => {
            const isUser = msg.sender === 'USER';
            return (
              <div
                key={msg.id}
                className={`flex gap-3 max-w-3xl ${isUser ? 'ml-auto flex-row-reverse' : ''}`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${
                    isUser ? 'bg-slate-900 text-white' : 'bg-violet-100 text-violet-700'
                  }`}
                >
                  {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                </div>

                <div className={`space-y-2 ${isUser ? 'text-right' : 'text-left'}`}>
                  <div
                    className={`inline-block p-4 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap ${
                      isUser
                        ? 'bg-slate-900 text-white rounded-tr-xs'
                        : 'bg-slate-100/80 text-slate-900 rounded-tl-xs'
                    }`}
                  >
                    {msg.text}
                  </div>

                  <div className="text-[10px] text-slate-400 font-mono">
                    {msg.timestamp}
                  </div>
                </div>
              </div>
            );
          })}

          {isProcessing && (
            <div className="flex gap-3 max-w-3xl">
              <div className="w-8 h-8 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4" />
              </div>
              <div className="bg-slate-100 p-3 rounded-2xl rounded-tl-xs text-xs text-slate-500 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" />
                <span className="text-slate-500 font-sans">Asking Gemini...</span>
              </div>
            </div>
          )}
        </div>

        {/* Input Bar */}
        <form onSubmit={handleSend} className="p-4 border-t border-slate-200 bg-slate-50/50 flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={2000}
            disabled={isProcessing}
            placeholder="Ask about this workspace's products, stock, or recent orders..."
            className="flex-1 bg-white border border-slate-300 rounded-xl px-4 py-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 placeholder:text-slate-400"
          />
          <button
            type="submit"
            disabled={!input.trim() || isProcessing}
            className="px-5 py-2.5 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 transition-colors disabled:opacity-50 flex items-center gap-2 shrink-0 shadow-2xs"
          >
            <span>Send</span>
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
