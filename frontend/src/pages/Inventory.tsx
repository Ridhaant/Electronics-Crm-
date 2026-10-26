import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "../api";
import { Spinner, EmptyState, ConfirmModal } from "../ui";
import { formatINR } from "../format";
import { useToast } from "../toast";
import { exportInventoryStockPdf } from "../inventoryPdf";

type DraftProduct = {
  id?: string;
  model: string;
  sku: string;
  category: string;
  cost_price: string;
  sell_price: string;
  qty_on_hand: string;
};

const EMPTY_DRAFT: DraftProduct = {
  model: "",
  sku: "",
  category: "Television",
  cost_price: "",
  sell_price: "",
  qty_on_hand: "0",
};

export default function Inventory() {
  const { show } = useToast();
  const qc = useQueryClient();

  const [query, setQuery] = useState("");
  const [stockFilter, setStockFilter] = useState<"all" | "in_stock" | "low_stock" | "out" | "negative">("all");

  // Modals state
  const [openAdd, setOpenAdd] = useState(false);
  const [editProduct, setEditProduct] = useState<DraftProduct | null>(null);
  const [adjustItem, setAdjustItem] = useState<{ id: string; model: string; current_qty: number; new_qty: number; reason: string } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [newDraft, setNewDraft] = useState<DraftProduct>(EMPTY_DRAFT);

  const { data = [], isLoading, isError, refetch } = useQuery({
    queryKey: ["products"],
    queryFn: () => apiGet<any[]>("/products"),
  });

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ["products"] });
    qc.invalidateQueries({ queryKey: ["purchases"] });
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["reports"] });
  }

  // Create Product Mutation
  const createMutation = useMutation({
    mutationFn: () => {
      const body = {
        model: newDraft.model.trim(),
        sku: newDraft.sku.trim() || undefined,
        category: newDraft.category.trim() || "Television",
        cost_price: parseFloat(newDraft.cost_price) || 0,
        sell_price: parseFloat(newDraft.sell_price) || 0,
        qty_on_hand: Math.max(0, parseFloat(newDraft.qty_on_hand) || 0),
      };
      return apiPost("/products", body);
    },
    onSuccess: () => {
      invalidateAll();
      setOpenAdd(false);
      setNewDraft(EMPTY_DRAFT);
      show("Inventory item added successfully", "success");
    },
    onError: (e: any) => show(e?.message || "Failed to add inventory item", "error"),
  });

  // Edit Product Mutation
  const editMutation = useMutation({
    mutationFn: () => {
      if (!editProduct || !editProduct.id) return Promise.reject(new Error("No product selected"));
      const body = {
        model: editProduct.model.trim(),
        sku: editProduct.sku.trim() || undefined,
        category: editProduct.category.trim() || "Television",
        cost_price: parseFloat(editProduct.cost_price) || 0,
        sell_price: parseFloat(editProduct.sell_price) || 0,
        qty_on_hand: Math.max(0, parseFloat(editProduct.qty_on_hand) || 0),
      };
      return apiPut(`/products/${editProduct.id}`, body);
    },
    onSuccess: () => {
      invalidateAll();
      setEditProduct(null);
      show("Product details & stock updated", "success");
    },
    onError: (e: any) => show(e?.message || "Failed to update product", "error"),
  });

  // Quick Stock Adjustment Mutation
  const adjustMutation = useMutation({
    mutationFn: () => {
      if (!adjustItem) return Promise.reject(new Error("No item selected"));
      return apiPost(`/products/${adjustItem.id}/adjust-stock`, {
        new_qty: Math.max(0, adjustItem.new_qty),
        reason: adjustItem.reason.trim(),
      });
    },
    onSuccess: () => {
      invalidateAll();
      const updatedQty = adjustItem ? Math.max(0, adjustItem.new_qty) : 0;
      setAdjustItem(null);
      show(`Stock updated to ${updatedQty} units`, "success");
    },
    onError: (e: any) => show(e?.message || "Failed to adjust stock", "error"),
  });

  // Delete Mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/products/${id}`),
    onSuccess: () => {
      invalidateAll();
      setDeleteId(null);
      show("Product removed from inventory", "info");
    },
    onError: (e: any) => show(e?.message || "Failed to remove product", "error"),
  });

  const totalUnits = data.reduce((a: number, p: any) => a + Math.max(0, Number(p.qty_on_hand) || 0), 0);
  const totalPurchased = data.reduce((a: number, p: any) => a + (Number(p.purchased_qty) || 0), 0);
  const totalSold = data.reduce((a: number, p: any) => a + (Number(p.sold_qty) || 0), 0);
  const totalValue = data.reduce((a: number, p: any) => a + Math.max(0, Number(p.qty_on_hand) || 0) * (Number(p.cost_price) || 0), 0);
  const lowStockCount = data.filter((p: any) => (Number(p.qty_on_hand) || 0) > 0 && (Number(p.qty_on_hand) || 0) <= 2).length;
  const outOfStockCount = data.filter((p: any) => (Number(p.qty_on_hand) || 0) === 0).length;
  const negativeStockCount = data.filter((p: any) => (Number(p.qty_on_hand) || 0) < 0).length;

  const filtered = useMemo(() => {
    let list = data;
    if (stockFilter === "in_stock") {
      list = list.filter((p: any) => (Number(p.qty_on_hand) || 0) > 2);
    } else if (stockFilter === "low_stock") {
      list = list.filter((p: any) => (Number(p.qty_on_hand) || 0) > 0 && (Number(p.qty_on_hand) || 0) <= 2);
    } else if (stockFilter === "out") {
      list = list.filter((p: any) => (Number(p.qty_on_hand) || 0) === 0);
    } else if (stockFilter === "negative") {
      list = list.filter((p: any) => (Number(p.qty_on_hand) || 0) < 0);
    }

    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter((p: any) =>
      p.model?.toLowerCase().includes(q) ||
      p.sku?.toLowerCase().includes(q) ||
      p.category?.toLowerCase().includes(q)
    );
  }, [data, stockFilter, query]);

  function handleOpenEdit(p: any) {
    setEditProduct({
      id: p.id,
      model: p.model || "",
      sku: p.sku || "",
      category: p.category || "Television",
      cost_price: String(p.cost_price ?? ""),
      sell_price: String(p.sell_price ?? ""),
      qty_on_hand: String(Number(p.qty_on_hand) || 0),
    });
  }

  function handleOpenAdjust(p: any) {
    const current = Number(p.qty_on_hand) || 0;
    setAdjustItem({
      id: p.id,
      model: p.model,
      current_qty: current,
      new_qty: current,
      reason: "Physical godown count correction",
    });
  }

  function submitAdd() {
    if (!newDraft.model.trim()) {
      show("Please enter a model name", "error");
      return;
    }
    createMutation.mutate();
  }

  function submitEdit() {
    if (!editProduct || !editProduct.model.trim()) {
      show("Please enter a model name", "error");
      return;
    }
    editMutation.mutate();
  }

  function handleExportPdf() {
    const itemsToExport = filtered.length > 0 ? filtered : data;
    if (itemsToExport.length === 0) {
      show("No inventory items to export", "error");
      return;
    }
    const success = exportInventoryStockPdf(itemsToExport);
    if (!success) {
      show("Popup blocked by browser. Please allow popups to export the stock PDF.", "error");
    } else {
      show(`Preparing PDF export for ${itemsToExport.length} models...`, "info");
    }
  }

  const isFiltered = filtered.length !== data.length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Inventory &amp; Stock Master</h1>
          <p>{data.length} models · {totalUnits} units in godown · {formatINR(totalValue)} inventory valuation</p>
        </div>
        <div className="page-header-actions" style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap", alignItems: "center" }}>
          <button
            className="btn btn-outline btn-sm"
            onClick={handleExportPdf}
            title="Export inventory details (Model Name & In-Stock Quantity only) as PDF"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            📄 {isFiltered ? `Export Stock PDF (${filtered.length})` : "Export Stock PDF"}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => { setNewDraft(EMPTY_DRAFT); setOpenAdd(true); }}>
            + Add Inventory Item
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => refetch()} title="Refresh inventory">
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
        {/* KPI Summary Cards */}
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-icon" style={{ background: "rgba(15, 76, 92, 0.12)", color: "var(--brand)" }}>📦</div>
            <div className="kpi-value" style={{ color: "var(--brand)" }}>{totalUnits}</div>
            <div className="kpi-label">Units in Godown (Stock)</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon" style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--success)" }}>💰</div>
            <div className="kpi-value" style={{ color: "var(--success)" }}>{formatINR(totalValue)}</div>
            <div className="kpi-label">Inventory Valuation</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon" style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}>📥</div>
            <div className="kpi-value" style={{ color: "#3b82f6" }}>{totalPurchased}</div>
            <div className="kpi-label">Total Purchased (Units)</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon" style={{ background: "rgba(139, 92, 246, 0.12)", color: "#8b5cf6" }}>📤</div>
            <div className="kpi-value" style={{ color: "#8b5cf6" }}>{totalSold}</div>
            <div className="kpi-label">Total Sold (Units)</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-icon" style={{ background: "rgba(245, 158, 11, 0.12)", color: "var(--warning)" }}>⚠️</div>
            <div className="kpi-value" style={{ color: "var(--warning)" }}>{lowStockCount + outOfStockCount}</div>
            <div className="kpi-label">Reorder Alerts ({lowStockCount} Low · {outOfStockCount} Out)</div>
          </div>
        </div>

        {/* Filters and Search Bar */}
        <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div className="search-bar" style={{ flex: "0 0 320px", maxWidth: "100%" }}>
            <span className="search-icon">🔍</span>
            <input
              className="input"
              style={{ paddingLeft: 36 }}
              placeholder="Search model, SKU, category…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="chip-bar" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              className={`chip${stockFilter === "all" ? " active" : ""}`}
              onClick={() => setStockFilter("all")}
            >
              All ({data.length})
            </button>
            <button
              className={`chip${stockFilter === "in_stock" ? " active" : ""}`}
              onClick={() => setStockFilter("in_stock")}
            >
              In Stock ({data.filter((p: any) => (Number(p.qty_on_hand) || 0) > 2).length})
            </button>
            <button
              className={`chip${stockFilter === "low_stock" ? " active" : ""}`}
              onClick={() => setStockFilter("low_stock")}
            >
              Low Stock ({lowStockCount})
            </button>
            <button
              className={`chip${stockFilter === "out" ? " active" : ""}`}
              onClick={() => setStockFilter("out")}
            >
              Out of Stock ({outOfStockCount})
            </button>
            {negativeStockCount > 0 && (
              <button
                className={`chip${stockFilter === "negative" ? " active" : ""}`}
                style={stockFilter === "negative" ? { background: "var(--error)", color: "#fff", borderColor: "var(--error)" } : { color: "var(--error)", borderColor: "var(--error)" }}
                onClick={() => setStockFilter("negative")}
              >
                🔴 Deficit / Sales &gt; Purchases ({negativeStockCount})
              </button>
            )}
          </div>
        </div>

        {/* Inventory Table */}
        {isLoading ? (
          <Spinner />
        ) : isError ? (
          <div className="empty-state">
            <div className="empty-icon">⚠️</div>
            <h3>Failed to load inventory</h3>
            <button className="btn btn-primary btn-sm" onClick={() => refetch()}>Retry</button>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="📦"
            title="No inventory matching filter"
            subtitle="Try resetting search or add a new inventory item."
            action="+ Add Inventory Item"
            onAction={() => { setNewDraft(EMPTY_DRAFT); setOpenAdd(true); }}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="hide-mobile">SKU</th>
                  <th className="hide-mobile">Category</th>
                  <th className="hide-mobile" style={{ textAlign: "right" }}>Purchased</th>
                  <th className="hide-mobile" style={{ textAlign: "right" }}>Sold</th>
                  <th style={{ textAlign: "right" }}>In Stock</th>
                  <th className="hide-mobile" style={{ textAlign: "right" }}>Cost Price</th>
                  <th className="hide-mobile" style={{ textAlign: "right" }}>Sell Price</th>
                  <th className="hide-mobile" style={{ textAlign: "right" }}>Margin</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p: any) => {
                  const qty = Number(p.qty_on_hand) || 0;
                  const purchasedQty = Number(p.purchased_qty) || 0;
                  const soldQty = Number(p.sold_qty) || 0;
                  const cost = Number(p.cost_price) || 0;
                  const sell = Number(p.sell_price) || 0;
                  const margin = sell && cost ? (((sell - cost) / cost) * 100).toFixed(1) : "—";
                  const isNegative = qty < 0;
                  const low = qty > 0 && qty <= 2;
                  const isZero = qty === 0;

                  return (
                    <tr
                      key={p.id}
                      className="clickable"
                      onClick={() => handleOpenEdit(p)}
                      style={isNegative ? { background: "rgba(239, 68, 68, 0.06)" } : undefined}
                    >
                      <td>
                        <div style={{ fontWeight: 700 }}>{p.model}</div>
                        <div className="show-mobile" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                          {p.sku ? `${p.sku} · ` : ""}{formatINR(sell)} · In: {purchasedQty} / Out: {soldQty}
                        </div>
                      </td>
                      <td className="hide-mobile">
                        <span className="badge" style={{ background: "var(--surface-2)", color: "var(--on-surface)", fontSize: 12 }}>
                          {p.sku || "—"}
                        </span>
                      </td>
                      <td className="hide-mobile" style={{ color: "var(--muted)", fontSize: 13 }}>{p.category || "Television"}</td>
                      <td className="hide-mobile" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#3b82f6", fontWeight: 600 }}>
                        {purchasedQty}
                      </td>
                      <td className="hide-mobile" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#8b5cf6", fontWeight: 600 }}>
                        {soldQty}
                      </td>
                      <td style={{
                        textAlign: "right",
                        fontWeight: 800,
                        fontSize: 16,
                        fontVariantNumeric: "tabular-nums",
                        color: isNegative ? "var(--error)" : isZero ? "var(--muted)" : low ? "var(--warning)" : "var(--brand)",
                      }}>
                        {qty}
                      </td>
                      <td className="hide-mobile" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatINR(cost)}</td>
                      <td className="hide-mobile" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatINR(sell)}</td>
                      <td className="hide-mobile" style={{ textAlign: "right", color: "var(--success)", fontWeight: 600 }}>{margin}%</td>
                      <td>
                        {isNegative ? (
                          <span
                            className="badge badge-error"
                            style={{ fontWeight: 700 }}
                            title={`Sold before purchase bill entered. Deficit of ${Math.abs(qty)} unit(s) pending purchase.`}
                          >
                            🔴 Deficit ({qty})
                          </span>
                        ) : isZero ? (
                          <span className="badge badge-error">Out of Stock</span>
                        ) : low ? (
                          <span className="badge badge-warning">Low ({qty})</span>
                        ) : (
                          <span className="badge badge-success">In Stock</span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ marginRight: 6, fontWeight: 600 }}
                          onClick={() => handleOpenAdjust(p)}
                          title="Quick stock adjustment"
                        >
                          ⚡ Stock
                        </button>
                        <button
                          className="btn btn-outline btn-sm"
                          style={{ marginRight: 6 }}
                          onClick={() => handleOpenEdit(p)}
                          title="Edit product details & pricing"
                        >
                          ✏️ Edit
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          style={{ color: "var(--error)" }}
                          onClick={() => setDeleteId(p.id)}
                          title="Remove product"
                        >
                          🗑
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal 1: + Add Inventory Item */}
      {openAdd && (
        <div className="modal-overlay" onClick={() => setOpenAdd(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>+ Add Inventory Item</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setOpenAdd(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Model Name *</label>
                <input
                  className="input"
                  value={newDraft.model}
                  onChange={(e) => setNewDraft({ ...newDraft, model: e.target.value })}
                  placeholder="e.g. 50 Worldtech 4K WebOS Frameless"
                  autoFocus
                />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label>SKU (optional)</label>
                  <input
                    className="input"
                    value={newDraft.sku}
                    onChange={(e) => setNewDraft({ ...newDraft, sku: e.target.value })}
                    placeholder="Auto-generated if blank"
                  />
                </div>
                <div className="field">
                  <label>Category</label>
                  <input
                    className="input"
                    value={newDraft.category}
                    onChange={(e) => setNewDraft({ ...newDraft, category: e.target.value })}
                    placeholder="Television"
                  />
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label>Cost Price (₹) *</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={newDraft.cost_price}
                    onChange={(e) => setNewDraft({ ...newDraft, cost_price: e.target.value })}
                    placeholder="e.g. 21500"
                  />
                </div>
                <div className="field">
                  <label>Sell Price (₹) *</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={newDraft.sell_price}
                    onChange={(e) => setNewDraft({ ...newDraft, sell_price: e.target.value })}
                    placeholder="e.g. 23800"
                  />
                </div>
              </div>
              <div className="field">
                <label>Opening Stock Quantity (Units)</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={newDraft.qty_on_hand}
                  onChange={(e) => setNewDraft({ ...newDraft, qty_on_hand: e.target.value })}
                  placeholder="0"
                />
                <span style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                  Initial physical count in warehouse/godown.
                </span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setOpenAdd(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitAdd} disabled={createMutation.isPending}>
                {createMutation.isPending ? "Adding Item…" : "✓ Add to Inventory"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Edit Product Details & Stock */}
      {editProduct && (
        <div className="modal-overlay" onClick={() => setEditProduct(null)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Edit Inventory Item</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setEditProduct(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Model Name *</label>
                <input
                  className="input"
                  value={editProduct.model}
                  onChange={(e) => setEditProduct({ ...editProduct, model: e.target.value })}
                  placeholder="Model name"
                />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label>SKU</label>
                  <input
                    className="input"
                    value={editProduct.sku}
                    onChange={(e) => setEditProduct({ ...editProduct, sku: e.target.value })}
                    placeholder="SKU"
                  />
                </div>
                <div className="field">
                  <label>Category</label>
                  <input
                    className="input"
                    value={editProduct.category}
                    onChange={(e) => setEditProduct({ ...editProduct, category: e.target.value })}
                    placeholder="Television"
                  />
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label>Cost Price (₹)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={editProduct.cost_price}
                    onChange={(e) => setEditProduct({ ...editProduct, cost_price: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Sell Price (₹)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={editProduct.sell_price}
                    onChange={(e) => setEditProduct({ ...editProduct, sell_price: e.target.value })}
                  />
                </div>
              </div>
              <div className="field">
                <label>Stock on Hand (Units)</label>
                <input
                  className="input"
                  type="number"
                  value={editProduct.qty_on_hand}
                  onChange={(e) => setEditProduct({ ...editProduct, qty_on_hand: e.target.value })}
                />
                <span style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                  Modifying stock here overrides the godown balance directly.
                </span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setEditProduct(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitEdit} disabled={editMutation.isPending}>
                {editMutation.isPending ? "Saving Changes…" : "💾 Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 3: ⚡ Quick Stock Adjustment */}
      {adjustItem && (
        <div className="modal-overlay" onClick={() => setAdjustItem(null)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>⚡ Adjust Stock Count</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setAdjustItem(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ gap: "var(--s4)" }}>
              <div>
                <div style={{ fontSize: 13, color: "var(--muted)" }}>Product Model</div>
                <div style={{ fontWeight: 800, fontSize: 18, color: "var(--on-surface)", marginTop: 2 }}>{adjustItem.model}</div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-2)", padding: "var(--s3) var(--s4)", borderRadius: "var(--r-md)" }}>
                <div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>Current Godown Stock</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "var(--on-surface)" }}>{adjustItem.current_qty} units</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>New Updated Stock</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: adjustItem.new_qty === adjustItem.current_qty ? "var(--brand)" : adjustItem.new_qty > adjustItem.current_qty ? "var(--success)" : "var(--error)" }}>
                    {adjustItem.new_qty} units
                  </div>
                </div>
              </div>

              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: "var(--muted)", marginBottom: 8, display: "block" }}>Quick Adjust (+ / -)</label>
                <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
                  {[-10, -5, -1, 1, 5, 10].map((delta) => (
                    <button
                      key={delta}
                      type="button"
                      className="btn btn-outline btn-sm"
                      style={{ flex: 1, minWidth: 50, fontWeight: 700 }}
                      onClick={() => setAdjustItem({ ...adjustItem, new_qty: Math.max(0, adjustItem.new_qty + delta) })}
                    >
                      {delta > 0 ? `+${delta}` : delta}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>Direct Count Override</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={adjustItem.new_qty}
                  onChange={(e) => setAdjustItem({ ...adjustItem, new_qty: Math.max(0, parseInt(e.target.value) || 0) })}
                />
              </div>

              <div className="field">
                <label>Reason / Audit Note</label>
                <input
                  className="input"
                  value={adjustItem.reason}
                  onChange={(e) => setAdjustItem({ ...adjustItem, reason: e.target.value })}
                  placeholder="e.g. Physical inventory count correction"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setAdjustItem(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => adjustMutation.mutate()} disabled={adjustMutation.isPending}>
                {adjustMutation.isPending ? "Updating Stock…" : "✓ Update Stock"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Delete Modal */}
      <ConfirmModal
        open={!!deleteId}
        title="Remove Product from Inventory?"
        body="This will remove the product model from your active inventory list."
        onConfirm={() => { if (deleteId) deleteMutation.mutate(deleteId); }}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
