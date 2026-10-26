import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiGet, apiDelete, apiPatch } from "../api";
import { PayBadge, Spinner, EmptyState, ConfirmModal } from "../ui";
import { formatINR, formatDate, formatTime, shortDate } from "../format";
import { useToast } from "../toast";
import { type BillData, printTaxInvoice } from "../receipt";
import { WhatsAppModal } from "../WhatsAppModal";
import { InvoiceViewerModal } from "../InvoiceViewerModal";
import { InvoiceUploadModal } from "../InvoiceUploadModal";

type Kind = "sale" | "purchase";

interface OrderListProps { kind: Kind; title: string; }

export default function OrderList({ kind, title }: OrderListProps) {
  const navigate = useNavigate();
  const { show } = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [whatsAppBill, setWhatsAppBill] = useState<BillData | null>(null);

  // Quick payment status change state
  const [statusOrder, setStatusOrder] = useState<any | null>(null);
  const [targetStatus, setTargetStatus] = useState<"cleared" | "unpaid" | "partial">("cleared");
  const [statusPaidAmount, setStatusPaidAmount] = useState("");
  const [statusPayMethod, setStatusPayMethod] = useState("RTGS");

  // Quick credit days change state
  const [creditOrder, setCreditOrder] = useState<any | null>(null);
  const [creditDaysInput, setCreditDaysInput] = useState<number>(15);

  // Quick invoice viewing and uploading states
  const [viewingInvoiceOrder, setViewingInvoiceOrder] = useState<any | null>(null);
  const [uploadingInvoiceOrder, setUploadingInvoiceOrder] = useState<any | null>(null);

  function handleWhatsApp(o: any) {
    const phoneMatch = o.notes?.match(/\[Phone:\s*([+0-9\s-]+)\]/i);
    const bill: BillData = {
      refNo: o.ref_no || o.id,
      date: o.date,
      customerName: o.party_name,
      customerPhone: phoneMatch ? phoneMatch[1].trim() : "",
      items: (o.items || []).map((it: any) => ({
        model: it.model,
        qty: Number(it.qty) || 0,
        rate: Number(it.rate) || 0,
        amount: Number(it.amount) || ((Number(it.qty) || 0) * (Number(it.rate) || 0)),
        hsn: "85287219",
        description: "WORLDTECH 2 YEARS WARRANTY",
      })),
      total: Number(o.total) || 0,
      paid: Number(o.amount_paid ?? o.paid ?? 0),
      balance: Number(o.balance ?? 0),
      notes: o.notes,
    };
    setWhatsAppBill(bill);
    setShowWhatsAppModal(true);
  }

  function handlePrint(o: any) {
    const phoneMatch = o.notes?.match(/\[Phone:\s*([+0-9\s-]+)\]/i);
    const bill: BillData = {
      refNo: o.ref_no || (kind === "sale" ? `SE/${o.id.slice(-4).toUpperCase()}/2026-27` : `PO-${o.id.slice(-4).toUpperCase()}`),
      date: o.date,
      customerName: o.party_name,
      customerPhone: phoneMatch ? phoneMatch[1].trim() : "",
      isPurchase: kind === "purchase",
      supplierName: kind === "purchase" ? o.party_name : undefined,
      items: (o.items || []).map((it: any) => ({
        model: it.model,
        qty: Number(it.qty) || 0,
        rate: Number(it.rate) || 0,
        amount: Number(it.amount) || ((Number(it.qty) || 0) * (Number(it.rate) || 0)),
        hsn: "85287219",
        description: "WORLDTECH 2 YEARS WARRANTY",
      })),
      total: Number(o.total) || 0,
      paid: Number(o.amount_paid ?? o.paid ?? 0),
      balance: Number(o.balance ?? 0),
      payMethod: (o.notes?.match(/\[Payment:\s*(.*?)\]/)?.[1]) || (o.pay_status === "cleared" ? "RTGS" : "RTGS / Bank Transfer"),
      notes: o.notes,
    };
    printTaxInvoice(bill);
  }

  const endpoint = kind === "sale" ? "/sales" : "/purchases";
  const createRoute = kind === "sale" ? "/sales/new" : "/purchases/new";
  const detailBase = kind === "sale" ? "/sales" : "/purchases";

  const { data = [], isLoading, isError, refetch } = useQuery({
    queryKey: [kind === "sale" ? "sales" : "purchases"],
    queryFn: () => apiGet<any[]>(endpoint),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/orders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [kind === "sale" ? "sales" : "purchases"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["reports"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      show("Order deleted and stock adjusted", "info");
    },
    onError: (e: any) => show(e?.message || "Failed to delete order", "error"),
  });

  const statusMutation = useMutation({
    mutationFn: () => {
      if (!statusOrder) return Promise.reject(new Error("No order selected"));
      const amt = targetStatus === "partial" ? parseFloat(statusPaidAmount) || 0 : undefined;
      const note = targetStatus !== "unpaid" ? `Settled via ${statusPayMethod}` : undefined;
      return apiPatch(`/orders/${statusOrder.id}/payment-status`, {
        status: targetStatus,
        amount_paid: amt,
        note,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [kind === "sale" ? "sales" : "purchases"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["reports"] });
      setStatusOrder(null);
      show("Payment status updated", "success");
    },
    onError: (e: any) => show(e?.message || "Status update failed", "error"),
  });

  const creditMutation = useMutation({
    mutationFn: () => {
      if (!creditOrder) return Promise.reject(new Error("No order selected"));
      return apiPatch(`/orders/${creditOrder.id}/credit-days`, {
        credit_days: Math.max(0, creditDaysInput || 0),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [kind === "sale" ? "sales" : "purchases"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["reports"] });
      setCreditOrder(null);
      show("Credit terms updated", "success");
    },
    onError: (e: any) => show(e?.message || "Failed to update credit terms", "error"),
  });

  function openQuickStatus(o: any) {
    setStatusOrder(o);
    const cur = o.pay_status || "unpaid";
    setTargetStatus(cur === "cleared" ? "cleared" : cur === "partial" ? "partial" : "unpaid");
    setStatusPaidAmount(String(o.amount_paid || ""));
  }

  function openQuickCredit(o: any) {
    setCreditOrder(o);
    setCreditDaysInput(typeof o.credit_days === "number" ? o.credit_days : 15);
  }

  const filtered = useMemo(() => {
    let rows = data;
    if (filter !== "all") rows = rows.filter((o: any) => o.pay_status === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((o: any) =>
        o.party_name?.toLowerCase().includes(q) || o.ref_no?.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [data, filter, search]);

  const partyLabel = kind === "sale" ? "Dealer" : "Supplier";

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{title}</h1>
          <p>{partyLabel} orders &amp; payments · {data.length} total</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-primary btn-sm" onClick={() => navigate(createRoute)}>+ New {kind === "sale" ? "Sale" : "Purchase"}</button>
          <button className="btn btn-outline btn-sm" onClick={() => refetch()}>↻</button>
        </div>
      </div>

      <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
        {/* Filters */}
        <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap", alignItems: "center" }}>
          <div className="search-bar" style={{ flex: "0 0 280px" }}>
            <span className="search-icon">🔍</span>
            <input className="input" style={{ paddingLeft: 36 }} placeholder={`Search ${partyLabel.toLowerCase()}, ref…`} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="chip-bar">
            {[{ key: "all", label: "All" }, { key: "unpaid", label: "Unpaid" }, { key: "partial", label: "Partial" }, { key: "cleared", label: "Cleared" }].map(f => (
              <button key={f.key} className={`chip${filter === f.key ? " active" : ""}`} onClick={() => setFilter(f.key)}>{f.label}</button>
            ))}
          </div>
        </div>

        {isLoading ? <Spinner /> : isError ? (
          <div className="empty-state"><div className="empty-icon">⚠️</div><h3>Failed to load</h3><button className="btn btn-primary btn-sm" onClick={() => refetch()}>Retry</button></div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={kind === "sale" ? "🧾" : "📦"} title={`No ${title.toLowerCase()} found`} subtitle="Try adjusting your filters or create a new order." action={`New ${kind === "sale" ? "Sale" : "Purchase"}`} onAction={() => navigate(createRoute)} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{partyLabel}</th>
                  <th className="hide-mobile">Ref No.</th>
                  <th className="hide-mobile">Date</th>
                  {kind === "sale" && <th>Credit / Due Terms</th>}
                  <th>{kind === "sale" ? "Invoice Doc" : "Bill / Challan"}</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                  <th className="hide-mobile" style={{ textAlign: "right" }}>Paid</th>
                  <th className="hide-mobile" style={{ textAlign: "right" }}>Balance</th>
                  <th>Status</th>
                  <th className="hide-mobile">Age</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o: any) => (
                  <tr key={o.id} className="clickable" onClick={() => navigate(`${detailBase}/${o.id}`)}>
                    <td>
                      <div style={{ fontWeight: 700 }}>{o.party_name}</div>
                      <div className="show-mobile" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                        {o.ref_no ? `${o.ref_no} · ` : ""}{shortDate(o.date)}
                        {o.balance > 0 && <span style={{ color: "var(--error)", marginLeft: 6, fontWeight: 600 }}>Bal: {formatINR(o.balance)}</span>}
                      </div>
                      {kind === "sale" && (
                        <div className="show-mobile" style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          {o.is_due_passed ? (
                            <span className="badge" style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #f87171", fontWeight: 800, fontSize: 11 }}>
                              🔴 Due date passed ({Math.abs(o.days_left)}d overdue)
                            </span>
                          ) : o.balance <= 0.5 ? (
                            <span className="badge badge-success" style={{ fontSize: 10 }}>✓ Paid</span>
                          ) : (
                            <span style={{ fontSize: 11, color: o.days_left <= 3 ? "var(--warning)" : "var(--muted)", fontWeight: 600 }}>
                              ⏳ {o.days_left}d left · Due {shortDate(o.due_date)}
                            </span>
                          )}
                          {o.invoice_file && (
                            <span
                              className="badge badge-brand"
                              style={{ fontSize: 10, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3 }}
                              onClick={(e) => { e.stopPropagation(); setViewingInvoiceOrder(o); }}
                            >
                              📄 Invoice Attached
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="hide-mobile" style={{ color: "var(--muted)", fontSize: 13 }}>{o.ref_no || "—"}</td>
                    <td className="hide-mobile" style={{ fontSize: 13 }}>
                      <div style={{ fontWeight: 600, color: "var(--on-surface)" }}>{formatDate(o.date)}</div>
                      {formatTime(o.date) && <div style={{ fontSize: 11, color: "var(--muted)" }}>{formatTime(o.date)}</div>}
                    </td>
                    {kind === "sale" && (
                      <td onClick={e => { e.stopPropagation(); openQuickCredit(o); }} style={{ cursor: "pointer" }} title="Click to edit credit terms">
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ fontWeight: 700, fontSize: 12 }}>{o.credit_days ?? 15} Days</span>
                            <span style={{ fontSize: 11, color: "var(--brand)" }}>✏️</span>
                          </div>
                          {o.balance <= 0.5 ? (
                            <span className="badge badge-success" style={{ fontSize: 11, padding: "2px 6px" }}>✓ Paid</span>
                          ) : o.is_due_passed ? (
                            <span
                              className="badge"
                              style={{
                                background: "#fee2e2",
                                color: "#b91c1c",
                                border: "1px solid #f87171",
                                fontWeight: 800,
                                fontSize: 11,
                                padding: "2px 6px",
                                whiteSpace: "nowrap",
                              }}
                            >
                              🔴 Due date passed ({Math.abs(o.days_left)}d overdue)
                            </span>
                          ) : o.days_left === 0 ? (
                            <span className="badge" style={{ background: "#fef3c7", color: "#b45309", fontWeight: 700, fontSize: 11, padding: "2px 6px" }}>
                              ⚠️ Due today
                            </span>
                          ) : (
                            <span className="badge" style={{ background: "#eff6ff", color: "#1d4ed8", fontWeight: 700, fontSize: 11, padding: "2px 6px" }}>
                              ⏳ {o.days_left}d left ({shortDate(o.due_date)})
                            </span>
                          )}
                        </div>
                      </td>
                    )}
                    <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                      {o.invoice_file ? (
                        <button
                          type="button"
                          className="btn btn-outline btn-xs"
                          style={{
                            borderColor: "var(--brand)",
                            color: "var(--brand)",
                            fontWeight: 700,
                            fontSize: 11,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "3px 8px",
                          }}
                          onClick={() => setViewingInvoiceOrder(o)}
                          title={`Click to view attached invoice: ${o.invoice_file.name}`}
                        >
                          <span>📄</span>
                          <span>View</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          style={{
                            color: "var(--muted)",
                            fontSize: 11,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 3,
                            padding: "2px 6px",
                          }}
                          onClick={() => setUploadingInvoiceOrder(o)}
                          title={kind === "sale" ? "Attach invoice copy (PDF / Image)" : "Attach supplier bill / challan"}
                        >
                          <span>📤</span>
                          <span>+ Attach</span>
                        </button>
                      )}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{formatINR(o.total)}</td>
                    <td className="hide-mobile" style={{ textAlign: "right", color: "var(--success)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatINR(o.amount_paid)}</td>
                    <td className="hide-mobile" style={{ textAlign: "right", color: o.balance > 0 ? "var(--error)" : "var(--muted)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatINR(o.balance)}</td>
                    <td onClick={e => { e.stopPropagation(); openQuickStatus(o); }}>
                      <span title="Click to change payment status" style={{ cursor: "pointer" }}>
                        <PayBadge status={o.pay_status} />
                      </span>
                    </td>
                    <td className="hide-mobile" style={{ color: "var(--muted)", fontSize: 13 }}>{o.age_days > 0 ? `${o.age_days}d` : "—"}</td>
                    <td onClick={e => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        onClick={() => handlePrint(o)}
                        title="Print Official A4 Tax Invoice"
                        style={{ marginRight: 4 }}
                      >
                        🖨
                      </button>
                      {kind === "sale" && (
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => handleWhatsApp(o)}
                          title="Send bill on WhatsApp"
                          style={{ marginRight: 4, color: "#10b981", fontSize: 13 }}
                        >
                          💬
                        </button>
                      )}
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={() => navigate(`${detailBase}/${o.id}/edit`)} title="Edit order" style={{ marginRight: 4 }}>✏️</button>
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setDeleteId(o.id)} title="Delete order" style={{ color: "var(--error)" }}>🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Quick Status Modal */}
      {statusOrder && (
        <div className="modal-overlay" onClick={() => setStatusOrder(null)}>
          <div className="modal" style={{ maxWidth: 440, width: "100%" }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Change Payment Status</h3>
              <button className="modal-close" onClick={() => setStatusOrder(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
              <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
                {partyLabel}: <strong>{statusOrder.party_name}</strong> · Total: <strong>{formatINR(statusOrder.total)}</strong>
              </p>

              <div className="field">
                <label>Status</label>
                <div style={{ display: "flex", gap: "var(--s2)", marginTop: 4 }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${targetStatus === "cleared" ? "btn-primary" : "btn-outline"}`}
                    style={{ flex: 1 }}
                    onClick={() => setTargetStatus("cleared")}
                  >
                    ✓ Cleared
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${targetStatus === "partial" ? "btn-primary" : "btn-outline"}`}
                    style={{ flex: 1 }}
                    onClick={() => setTargetStatus("partial")}
                  >
                    ⏳ Partial
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${targetStatus === "unpaid" ? "btn-primary" : "btn-outline"}`}
                    style={{ flex: 1 }}
                    onClick={() => setTargetStatus("unpaid")}
                  >
                    ✕ Unpaid
                  </button>
                </div>
              </div>

              {targetStatus !== "unpaid" && (
                <div className="field">
                  <label>Payment Mode</label>
                  <select
                    className="input"
                    value={statusPayMethod}
                    onChange={e => setStatusPayMethod(e.target.value)}
                  >
                    <option value="RTGS">RTGS (Real Time Gross Settlement)</option>
                    <option value="NEFT / Bank Transfer">NEFT / Bank Transfer</option>
                    <option value="IMPS">IMPS</option>
                    <option value="UPI">UPI / GPay / PhonePe</option>
                    <option value="Cheque">Cheque</option>
                    <option value="Cash">Cash</option>
                  </select>
                </div>
              )}

              {targetStatus === "partial" && (
                <div className="field">
                  <label>Amount Paid (₹)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={statusOrder.total}
                    value={statusPaidAmount}
                    onChange={e => setStatusPaidAmount(e.target.value)}
                    placeholder="0"
                  />
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                    Remaining: {formatINR(Math.max(0, statusOrder.total - (parseFloat(statusPaidAmount) || 0)))}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setStatusOrder(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => statusMutation.mutate()} disabled={statusMutation.isPending}>
                {statusMutation.isPending ? "Updating…" : "Update Status"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Credit Days Modal */}
      {creditOrder && (
        <div className="modal-overlay" onClick={() => setCreditOrder(null)}>
          <div className="modal" style={{ maxWidth: 440, width: "100%" }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit Credit Terms</h3>
              <button className="modal-close" onClick={() => setCreditOrder(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
              <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
                Invoice: <strong>{creditOrder.ref_no || creditOrder.id}</strong> · {creditOrder.party_name}
              </p>

              <div className="field">
                <label>Credit Period Presets</label>
                <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap", marginTop: 4 }}>
                  {[0, 7, 15, 30, 45, 60].map(days => (
                    <button
                      key={days}
                      type="button"
                      className={`btn btn-sm ${creditDaysInput === days ? "btn-primary" : "btn-outline"}`}
                      onClick={() => setCreditDaysInput(days)}
                    >
                      {days === 0 ? "Immediate (0d)" : `${days} Days`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>Custom Number of Credit Days</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={365}
                  value={creditDaysInput}
                  onChange={e => setCreditDaysInput(Math.max(0, parseInt(e.target.value) || 0))}
                  placeholder="e.g. 15"
                />
              </div>

              {/* Calculated preview */}
              {(() => {
                const baseDt = new Date(creditOrder.date || Date.now());
                const previewDue = new Date(baseDt.getTime() + creditDaysInput * 86400000);
                const now = new Date();
                const dueMidnight = new Date(previewDue.getFullYear(), previewDue.getMonth(), previewDue.getDate()).getTime();
                const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                const previewDaysLeft = Math.round((dueMidnight - nowMidnight) / 86400000);
                const isOverdue = creditOrder.balance > 0.5 && previewDaysLeft < 0;

                return (
                  <div style={{ background: "var(--surface-2)", padding: "var(--s3) var(--s4)", borderRadius: "var(--r-sm)", fontSize: 13 }}>
                    <div><strong>Calculated Due Date:</strong> {previewDue.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</div>
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                      <span><strong>Status:</strong></span>
                      {creditOrder.balance <= 0.5 ? (
                        <span className="badge badge-success">✓ Already Paid (₹0 Balance)</span>
                      ) : isOverdue ? (
                        <span className="badge" style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #f87171", fontWeight: 800 }}>
                          🔴 Due date passed ({Math.abs(previewDaysLeft)} days overdue)
                        </span>
                      ) : previewDaysLeft === 0 ? (
                        <span className="badge" style={{ background: "#fef3c7", color: "#b45309", fontWeight: 700 }}>
                          ⚠️ Due today
                        </span>
                      ) : (
                        <span className="badge" style={{ background: "#eff6ff", color: "#1d4ed8", fontWeight: 700 }}>
                          ⏳ {previewDaysLeft} days left
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setCreditOrder(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => creditMutation.mutate()} disabled={creditMutation.isPending}>
                {creditMutation.isPending ? "Saving…" : "Save Credit Terms"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!deleteId}
        title="Delete this order?"
        body="Stock changes from this order will be reversed. This cannot be undone."
        onConfirm={() => { if (deleteId) { deleteMutation.mutate(deleteId); setDeleteId(null); } }}
        onCancel={() => setDeleteId(null)}
      />

      <WhatsAppModal
        open={showWhatsAppModal}
        onClose={() => setShowWhatsAppModal(false)}
        bill={whatsAppBill}
      />

      {/* Invoice Viewer Modal */}
      {viewingInvoiceOrder && (
        <InvoiceViewerModal
          order={viewingInvoiceOrder}
          onClose={() => setViewingInvoiceOrder(null)}
          onInvoiceUpdated={() => {
            qc.invalidateQueries({ queryKey: [kind === "sale" ? "sales" : "purchases"] });
            qc.invalidateQueries({ queryKey: ["orders"] });
            qc.invalidateQueries({ queryKey: ["dashboard"] });
            qc.invalidateQueries({ queryKey: ["reports"] });
            setViewingInvoiceOrder(null);
          }}
          onOpenReplace={() => {
            const ord = viewingInvoiceOrder;
            setViewingInvoiceOrder(null);
            setUploadingInvoiceOrder(ord);
          }}
        />
      )}

      {/* Invoice Upload Modal */}
      {uploadingInvoiceOrder && (
        <InvoiceUploadModal
          order={uploadingInvoiceOrder}
          onClose={() => setUploadingInvoiceOrder(null)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: [kind === "sale" ? "sales" : "purchases"] });
            qc.invalidateQueries({ queryKey: ["orders"] });
            qc.invalidateQueries({ queryKey: ["dashboard"] });
            qc.invalidateQueries({ queryKey: ["reports"] });
            setUploadingInvoiceOrder(null);
          }}
        />
      )}

      <button className="fab" onClick={() => navigate(createRoute)} title={`New ${kind}`}>+</button>
    </div>
  );
}

