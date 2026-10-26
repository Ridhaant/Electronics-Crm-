import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "../api";
import { Spinner, EmptyState, ConfirmModal } from "../ui";
import { formatINR } from "../format";
import { useToast } from "../toast";

type Draft = { id?: string; model: string; sku: string; category: string; cost_price: string; sell_price: string; qty_on_hand: string };
const EMPTY: Draft = { model: "", sku: "", category: "Television", cost_price: "", sell_price: "", qty_on_hand: "0" };

export default function Products() {
  const { show } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data = [], isLoading, isError, refetch } = useQuery({ queryKey: ["products"], queryFn: () => apiGet<any[]>("/products") });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["products"] });
    qc.invalidateQueries({ queryKey: ["purchases"] });
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["reports"] });
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = { model: draft.model.trim(), sku: draft.sku.trim() || undefined, category: draft.category.trim() || "Television", cost_price: parseFloat(draft.cost_price) || 0, sell_price: parseFloat(draft.sell_price) || 0, qty_on_hand: parseFloat(draft.qty_on_hand) || 0 };
      return draft.id ? apiPut(`/products/${draft.id}`, body) : apiPost("/products", body);
    },
    onSuccess: () => { invalidate(); setOpen(false); show(draft.id ? "Product updated" : "Product added", "success"); },
    onError: (e: any) => show(e?.message || "Failed", "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/products/${id}`),
    onSuccess: () => { invalidate(); show("Product removed", "info"); },
    onError: (e: any) => show(e?.message || "Failed", "error"),
  });

  function openEdit(p: any) {
    setDraft({ id: p.id, model: p.model, sku: p.sku || "", category: p.category || "Television", cost_price: String(p.cost_price ?? ""), sell_price: String(p.sell_price ?? ""), qty_on_hand: String(p.qty_on_hand ?? 0) });
    setOpen(true);
  }

  function save() {
    if (!draft.model.trim()) { show("Enter a model name", "error"); return; }
    saveMutation.mutate();
  }

  return (
    <div>
      <div className="page-header">
        <div><h1>Products &amp; Cost Sheet</h1><p>SKUs, models &amp; costing for {data.length} products</p></div>
        <div className="page-header-actions">
          <button className="btn btn-primary btn-sm" onClick={() => { setDraft(EMPTY); setOpen(true); }}>+ Add Product</button>
          <button className="btn btn-outline btn-sm" onClick={() => refetch()}>↻</button>
        </div>
      </div>

      <div className="page-body">
        {isLoading ? <Spinner /> : isError ? (
          <div className="empty-state"><div className="empty-icon">⚠️</div><h3>Failed to load</h3><button className="btn btn-primary btn-sm" onClick={() => refetch()}>Retry</button></div>
        ) : data.length === 0 ? (
          <EmptyState icon="🏷️" title="No products yet" subtitle="Add your first product to start tracking." action="Add Product" onAction={() => { setDraft(EMPTY); setOpen(true); }} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th><th>SKU</th><th>Category</th>
                  <th style={{ textAlign: "right" }}>Cost (₹)</th>
                  <th style={{ textAlign: "right" }}>Sell (₹)</th>
                  <th style={{ textAlign: "right" }}>Stock</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.map((p: any) => (
                  <tr key={p.id} className="clickable" onClick={() => openEdit(p)}>
                    <td style={{ fontWeight: 700 }}>{p.model}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{p.sku}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{p.category}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatINR(p.cost_price)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatINR(p.sell_price)}</td>
                    <td style={{ textAlign: "right", fontWeight: 800 }}>{p.qty_on_hand}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setDeleteId(p.id)} style={{ color: "var(--error)" }}>🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Form Modal */}
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{draft.id ? "Edit Product" : "Add Product"}</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field"><label>Model Name *</label><input className="input" value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })} placeholder="e.g. 43 Worldtech BT" /></div>
              <div className="field"><label>SKU (optional)</label><input className="input" value={draft.sku} onChange={e => setDraft({ ...draft, sku: e.target.value })} placeholder="Auto-generated if blank" /></div>
              <div className="field"><label>Category</label><input className="input" value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} placeholder="Television" /></div>
              <div className="grid-2">
                <div className="field"><label>Cost / unit (₹)</label><input className="input" type="number" min={0} value={draft.cost_price} onChange={e => setDraft({ ...draft, cost_price: e.target.value })} placeholder="0" /></div>
                <div className="field"><label>Sell / unit (₹)</label><input className="input" type="number" min={0} value={draft.sell_price} onChange={e => setDraft({ ...draft, sell_price: e.target.value })} placeholder="0" /></div>
              </div>
              <div className="field">
                <label>Stock on hand</label>
                <input className="input" type="number" min={0} value={draft.qty_on_hand} onChange={e => setDraft({ ...draft, qty_on_hand: e.target.value })} placeholder="0" />
                <p style={{ fontSize: 12, color: "var(--muted)" }}>Stock auto-updates with orders. Edit here only for manual corrections.</p>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saveMutation.isPending}>{saveMutation.isPending ? "Saving…" : draft.id ? "Save Changes" : "Add Product"}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal open={!!deleteId} title="Remove product?" body="This will permanently remove the product from your catalog." onConfirm={() => { if (deleteId) { deleteMutation.mutate(deleteId); setDeleteId(null); } }} onCancel={() => setDeleteId(null)} />
    </div>
  );
}
