import React, { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from "../api";
import { Spinner, PayBadge, ConfirmModal } from "../ui";
import { formatINR, formatDate, formatDateTime } from "../format";
import { useToast } from "../toast";
import { type BillData, printTaxInvoice } from "../receipt";
import { WhatsAppModal } from "../WhatsAppModal";
import { InvoiceViewerModal } from "../InvoiceViewerModal";
import { InvoiceUploadModal } from "../InvoiceUploadModal";
import { formatFileSize } from "../invoiceStorage";

type Kind = "sale" | "purchase";

export default function OrderDetail({ kind }: { kind: Kind }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { show } = useToast();
  const qc = useQueryClient();
  const isSale = kind === "sale";
  const listKey = isSale ? "sales" : "purchases";
  const balanceLabel = isSale ? "Receivable" : "Payable";

  const [payAmount, setPayAmount] = useState("");
  const [payNote, setPayNote] = useState("");
  const [payMethod, setPayMethod] = useState("RTGS");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [whatsAppBill, setWhatsAppBill] = useState<BillData | null>(null);

  // Credit Terms Modal State
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [creditDaysVal, setCreditDaysVal] = useState<number>(15);

  // Status Change Modal State
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<"cleared" | "unpaid" | "partial">("cleared");
  const [customPaidAmount, setCustomPaidAmount] = useState("");
  const [statusChangeNote, setStatusChangeNote] = useState("");
  const [statusPayMethod, setStatusPayMethod] = useState("RTGS");

  // Payment item editing
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editNote, setEditNote] = useState("");
  const [deletePaymentId, setDeletePaymentId] = useState<string | null>(null);

  // Invoice attachment states
  const [showInvoiceViewer, setShowInvoiceViewer] = useState(false);
  const [showInvoiceUpload, setShowInvoiceUpload] = useState(false);

  const { data: o, isLoading, isError, refetch } = useQuery({
    queryKey: [listKey, id],
    queryFn: () => apiGet(`${isSale ? "/sales" : "/purchases"}/${id}`),
  });

  const creditMutation = useMutation({
    mutationFn: (days: number) => apiPatch(`/orders/${id}/credit-days`, { credit_days: days }),
    onSuccess: () => {
      invalidateAll();
      refetch();
      setShowCreditModal(false);
      show("Credit terms updated", "success");
    },
    onError: (e: any) => show(e?.message || "Failed to update credit terms", "error"),
  });

  const { data: dealers = [] } = useQuery({
    queryKey: ["dealers"],
    queryFn: () => apiGet<any[]>("/dealers"),
    enabled: isSale,
  });

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: [listKey] });
    qc.invalidateQueries({ queryKey: [listKey, id] });
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["reports"] });
    qc.invalidateQueries({ queryKey: ["products"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
  }

  const payMutation = useMutation({
    mutationFn: () => {
      const fullNote = payNote.trim() ? `[${payMethod}] ${payNote.trim()}` : `Paid via ${payMethod}`;
      return apiPost(`/orders/${id}/payments`, {
        amount: parseFloat(payAmount) || 0,
        note: fullNote,
        method: payMethod,
      });
    },
    onSuccess: () => {
      setPayAmount(""); setPayNote("");
      invalidateAll(); refetch();
      show("Payment recorded", "success");
    },
    onError: (e: any) => show(e?.message || "Failed to record payment", "error"),
  });

  const statusMutation = useMutation({
    mutationFn: () => {
      const amt = selectedStatus === "partial" ? parseFloat(customPaidAmount) || 0 : undefined;
      const combinedNote = selectedStatus !== "unpaid"
        ? (statusChangeNote.trim() ? `[${statusPayMethod}] ${statusChangeNote.trim()}` : `Settled via ${statusPayMethod}`)
        : (statusChangeNote.trim() || undefined);
      return apiPatch(`/orders/${id}/payment-status`, {
        status: selectedStatus,
        amount_paid: amt,
        note: combinedNote,
      });
    },
    onSuccess: () => {
      invalidateAll(); refetch();
      setShowStatusModal(false);
      show("Payment status updated", "success");
    },
    onError: (e: any) => show(e?.message || "Failed to update payment status", "error"),
  });

  const editPayMutation = useMutation({
    mutationFn: ({ pid, amount, note }: { pid: string; amount: number; note: string }) =>
      apiPut(`/orders/${id}/payments/${pid}`, { amount, note }),
    onSuccess: () => {
      setEditingPaymentId(null);
      invalidateAll(); refetch();
      show("Payment record updated", "success");
    },
    onError: (e: any) => show(e?.message || "Failed to update payment", "error"),
  });

  const deletePayMutation = useMutation({
    mutationFn: (pid: string) => apiDelete(`/orders/${id}/payments/${pid}`),
    onSuccess: () => {
      setDeletePaymentId(null);
      invalidateAll(); refetch();
      show("Payment record removed", "info");
    },
    onError: (e: any) => show(e?.message || "Failed to delete payment", "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/orders/${id}`),
    onSuccess: () => {
      invalidateAll();
      show("Order deleted, stock reversed", "info");
      navigate(isSale ? "/sales" : "/purchases");
    },
    onError: (e: any) => show(e?.message || "Failed", "error"),
  });

  function addPayment() {
    const amt = parseFloat(payAmount) || 0;
    if (amt <= 0) { show("Enter a valid amount", "error"); return; }
    payMutation.mutate();
  }

  function openStatusModal() {
    if (!o) return;
    const current = o.pay_status || "unpaid";
    setSelectedStatus(current === "cleared" ? "cleared" : current === "partial" ? "partial" : "unpaid");
    setCustomPaidAmount(String(o.amount_paid || ""));
    setStatusChangeNote("");
    setShowStatusModal(true);
  }

  function startEditPayment(p: any) {
    setEditingPaymentId(p.id);
    setEditAmount(String(p.amount || 0));
    setEditNote(p.note || "");
  }

  function saveEditPayment(pid: string) {
    const amt = parseFloat(editAmount);
    if (isNaN(amt) || amt <= 0) {
      show("Enter a valid payment amount", "error");
      return;
    }
    editPayMutation.mutate({ pid, amount: amt, note: editNote.trim() });
  }

  function toBillData(): BillData | null {
    if (!o) return null;
    const matchedDealer = isSale && o.party_id ? dealers.find((d: any) => d.id === o.party_id) : null;
    const phoneMatch = o.notes?.match(/\[Phone:\s*([+0-9\s-]+)\]/i);
    const phone = matchedDealer?.phone || matchedDealer?.whatsapp || (phoneMatch ? phoneMatch[1].trim() : "");

    return {
      refNo: o.ref_no || (isSale ? `SE/${o.id.slice(-4).toUpperCase()}/2026-27` : `PO-${o.id.slice(-4).toUpperCase()}`),
      date: o.date,
      customerName: o.party_name,
      customerPhone: phone,
      customerAddress: matchedDealer?.address || matchedDealer?.area || "",
      customerGstin: matchedDealer?.gstin || "",
      customerState: "Maharashtra",
      customerStateCode: "27",
      isPurchase: !isSale,
      supplierName: !isSale ? o.party_name : undefined,
      items: (o.items || []).map((it: any) => ({
        model: it.model,
        qty: Number(it.qty) || 0,
        rate: Number(it.rate) || 0,
        amount: Number(it.amount) || (Number(it.qty) * Number(it.rate)),
        hsn: "85287219",
        description: "WORLDTECH 2 YEARS WARRANTY",
      })),
      total: Number(o.total) || 0,
      paid: Number(o.amount_paid ?? o.paid ?? 0),
      balance: Number(o.balance ?? 0),
      creditDays: o.credit_days,
      dueDate: o.due_date,
      daysLeft: o.days_left,
      isDuePassed: o.is_due_passed,
      payMethod: o.payments?.[0]?.method || (o.payments?.[0]?.note?.match(/\[(.*?)\]/)?.[1]) || o.payments?.[0]?.note || (o.notes?.match(/\[Payment:\s*(.*?)\]/)?.[1]) || (o.pay_status === "cleared" ? "RTGS" : "RTGS / Bank Transfer"),
      notes: o.notes,
    };
  }

  function printInvoice() {
    const bill = toBillData();
    if (bill) printTaxInvoice(bill);
  }

  function handleWhatsApp() {
    const bill = toBillData();
    if (bill) {
      setWhatsAppBill(bill);
      setShowWhatsAppModal(true);
    }
  }

  function badgeClass(status: string) {
    if (status === "cleared") return "badge-success";
    if (status === "partial") return "badge-warning";
    return "badge-danger";
  }

  if (isLoading) return <div className="page-body"><Spinner /></div>;
  if (isError || !o) return <div className="page-body"><div className="empty-state"><div className="empty-icon">⚠️</div><h3>Order not found</h3><button className="btn btn-outline btn-sm" onClick={() => navigate(-1)}>← Back</button></div></div>;

  const matchedDealer = isSale && o.party_id ? dealers.find((d: any) => d.id === o.party_id) : null;

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <button className="btn btn-outline btn-sm btn-icon" onClick={() => navigate(isSale ? "/sales" : "/purchases")}>
            ←
          </button>
          <div>
            <h1>{isSale ? "Sale Invoice" : "Purchase Order"}: {o.ref_no || o.id}</h1>
            <p>{formatDateTime(o.date)} · {o.party_name}</p>
          </div>
        </div>
        <div className="page-header-actions">
          {/* Credit Terms Action */}
          {isSale && (
            <button
              className="btn btn-outline btn-sm"
              onClick={() => {
                setCreditDaysVal(typeof o.credit_days === "number" ? o.credit_days : 15);
                setShowCreditModal(true);
              }}
            >
              📅 Credit Terms ({o.credit_days ?? 15}d)
            </button>
          )}
          {/* View / Upload Invoice Action */}
          {isSale && (
            o.invoice_file ? (
              <button
                className="btn btn-outline btn-sm"
                style={{ borderColor: "var(--brand)", color: "var(--brand)", fontWeight: 700 }}
                onClick={() => setShowInvoiceViewer(true)}
              >
                📄 View Invoice
              </button>
            ) : (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setShowInvoiceUpload(true)}
              >
                📤 Upload Invoice
              </button>
            )
          )}
          {/* Change Status Action */}
          <button className="btn btn-outline btn-sm" onClick={openStatusModal}>
            ✏️ Change Status
          </button>
          <button className="btn btn-outline btn-sm" onClick={printInvoice}>
            🖨 Print Tax Invoice (A4)
          </button>
          <button className="btn btn-primary btn-sm" style={{ background: "#25D366" }} onClick={handleWhatsApp}>
            📲 WhatsApp Bill
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => navigate(`${isSale ? "/sales" : "/purchases"}/${id}/edit`)}>
            Edit
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" style={{ color: "var(--error)" }} onClick={() => setConfirmDelete(true)}>
            🗑
          </button>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "var(--s4)", alignItems: "start" }}>
        {/* Left Column: Details & Items */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
          {/* Party & Order Info */}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Party Details</div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
                <span className={`badge ${badgeClass(o.pay_status)}`} style={{ textTransform: "capitalize", fontSize: 13, padding: "4px 10px" }}>
                  {o.pay_status}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11, padding: "2px 8px" }}
                  onClick={openStatusModal}
                  title="Click to edit payment status"
                >
                  ✏️ Edit
                </button>
              </div>
            </div>

            <div style={{ fontSize: 14 }}>
              <strong>{isSale ? "Dealer / Buyer:" : "Supplier:"}</strong> {o.party_name}
            </div>

            {matchedDealer && (
              <div style={{ fontSize: 13, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 3 }}>
                {matchedDealer.gstin && <div><strong>GSTIN:</strong> {matchedDealer.gstin}</div>}
                {(matchedDealer.address || matchedDealer.area) && <div><strong>Address:</strong> {matchedDealer.address || matchedDealer.area}</div>}
                {(matchedDealer.whatsapp || matchedDealer.phone) && <div><strong>Phone:</strong> {matchedDealer.whatsapp || matchedDealer.phone}</div>}
              </div>
            )}

            {o.notes && (
              <div style={{ fontSize: 13, background: "var(--surface-2)", padding: "var(--s2) var(--s3)", borderRadius: "var(--r-sm)" }}>
                <strong>Notes:</strong> {o.notes}
              </div>
            )}

            {isSale && (
              <div style={{ marginTop: "var(--s2)", padding: "var(--s3)", background: "var(--surface-2)", borderRadius: "var(--r-sm)", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>Credit Terms &amp; Due Date</span>
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    onClick={() => {
                      setCreditDaysVal(typeof o.credit_days === "number" ? o.credit_days : 15);
                      setShowCreditModal(true);
                    }}
                  >
                    ✏️ Edit Credit Days
                  </button>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span style={{ color: "var(--muted)" }}>Credit Period:</span>
                  <span style={{ fontWeight: 700 }}>{o.credit_days ?? 15} Days</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span style={{ color: "var(--muted)" }}>Due Date:</span>
                  <span style={{ fontWeight: 700 }}>{formatDate(o.due_date)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, borderTop: "1px dashed var(--border)", paddingTop: 4 }}>
                  <span style={{ color: "var(--muted)" }}>Due Status:</span>
                  {o.balance <= 0.5 ? (
                    <span className="badge badge-success">✓ Fully Cleared</span>
                  ) : o.is_due_passed ? (
                    <span className="badge" style={{ background: "#fee2e2", color: "#b91c1c", border: "1px solid #f87171", fontWeight: 800 }}>
                      🔴 Due date passed ({Math.abs(o.days_left)} days overdue)
                    </span>
                  ) : o.days_left === 0 ? (
                    <span className="badge" style={{ background: "#fef3c7", color: "#b45309", fontWeight: 700 }}>
                      ⚠️ Due today
                    </span>
                  ) : (
                    <span className="badge" style={{ background: "#eff6ff", color: "#1d4ed8", fontWeight: 700 }}>
                      ⏳ {o.days_left} days left
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Attached Invoice Document Card */}
          {isSale && (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 800, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>📄</span>
                  <span>Attached Invoice Document</span>
                </div>
                {o.invoice_file ? (
                  <span className="badge badge-success" style={{ fontSize: 11, padding: "3px 8px" }}>
                    ✓ Document Attached
                  </span>
                ) : (
                  <span className="badge" style={{ background: "var(--surface-2)", color: "var(--muted)", fontSize: 11, padding: "3px 8px" }}>
                    No file attached
                  </span>
                )}
              </div>

              {o.invoice_file ? (
                <div
                  style={{
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-md)",
                    padding: "var(--s3) var(--s4)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--s3)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                      <span style={{ fontSize: 32 }}>
                        {o.invoice_file.name?.toLowerCase().endsWith(".pdf") || o.invoice_file.type?.includes("pdf") ? "📄" : "🖼️"}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {o.invoice_file.name}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                          {formatFileSize(o.invoice_file.size)}
                          {o.invoice_file.uploaded_at && ` · Attached ${formatDateTime(o.invoice_file.uploaded_at)}`}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => setShowInvoiceViewer(true)}
                        style={{ display: "flex", alignItems: "center", gap: 6 }}
                      >
                        👁️ View Invoice
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => setShowInvoiceUpload(true)}
                        title="Upload a new replacement invoice"
                      >
                        🔄 Replace
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    border: "1px dashed var(--border)",
                    borderRadius: "var(--r-md)",
                    padding: "var(--s4)",
                    textAlign: "center",
                    background: "var(--surface-2)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <div style={{ fontSize: 32, color: "var(--brand)" }}>📤</div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>No invoice file attached yet</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 380 }}>
                    Upload signed tax invoice copy, delivery challan, or scanned bill (PDF or image) for quick reference.
                  </div>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ marginTop: 6 }}
                    onClick={() => setShowInvoiceUpload(true)}
                  >
                    📤 Upload Invoice Document
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Line Items Table */}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Items &amp; Products ({o.items?.length || 0})</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product / Model</th>
                    <th style={{ textAlign: "center" }}>Qty</th>
                    <th style={{ textAlign: "right" }}>Rate</th>
                    <th style={{ textAlign: "right" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(o.items || []).map((it: any, i: number) => {
                    const lineTotal = it.amount || (it.qty * it.rate);
                    return (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{it.model}</td>
                        <td style={{ textAlign: "center" }}>{it.qty}</td>
                        <td style={{ textAlign: "right" }}>{formatINR(it.rate)}</td>
                        <td style={{ textAlign: "right", fontWeight: 700, color: "var(--brand)" }}>{formatINR(lineTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "2px solid var(--border)", paddingTop: "var(--s3)", marginTop: "var(--s2)" }}>
              <span style={{ fontWeight: 800, fontSize: 16 }}>Order Total:</span>
              <span style={{ fontWeight: 800, fontSize: 20, color: "var(--brand)", fontVariantNumeric: "tabular-nums" }}>{formatINR(o.total)}</span>
            </div>
          </div>
        </div>

        {/* Right Column: Payment Ledger & Add Payment */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
          {/* Payment Summary Card */}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Payment Summary</div>
              <button className="btn btn-outline btn-sm" onClick={openStatusModal}>
                ✏️ Change Status
              </button>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px dashed var(--border)" }}>
              <span style={{ color: "var(--muted)" }}>Total Bill Amount:</span>
              <span style={{ fontWeight: 700 }}>{formatINR(o.total)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px dashed var(--border)" }}>
              <span style={{ color: "var(--muted)" }}>Total Paid to Date:</span>
              <span style={{ fontWeight: 700, color: "var(--success)" }}>{formatINR(o.amount_paid ?? o.paid ?? 0)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", alignItems: "center" }}>
              <span style={{ fontWeight: 800, fontSize: 15 }}>{balanceLabel} Balance:</span>
              <span style={{ fontWeight: 800, fontSize: 20, color: o.balance > 0 ? "var(--error)" : "var(--success)", fontVariantNumeric: "tabular-nums" }}>
                {formatINR(o.balance)}
              </span>
            </div>
            {isSale && o.balance > 0.5 && (
              <div style={{ marginTop: 2, display: "flex", justifyContent: "flex-end" }}>
                {o.is_due_passed ? (
                  <span className="badge" style={{ background: "#fee2e2", color: "#b91c1c", border: "1px solid #f87171", fontWeight: 800, padding: "4px 8px" }}>
                    🔴 Due date passed ({Math.abs(o.days_left)} days overdue)
                  </span>
                ) : (
                  <span className="badge" style={{ background: "#eff6ff", color: "#1d4ed8", fontWeight: 700, padding: "4px 8px" }}>
                    ⏳ {o.days_left} days left (Due {formatDate(o.due_date)})
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Payment History Card with Edit and Delete options */}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Payment History &amp; Receipts</div>
            {o.payments && o.payments.length > 0 ? o.payments.map((p: any) => {
              const isEditing = editingPaymentId === p.id;
              return (
                <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "var(--s3)", background: "var(--surface-2)", borderRadius: "var(--r-sm)" }}>
                  {isEditing ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
                      <div className="grid-2">
                        <div className="field">
                          <label style={{ fontSize: 11 }}>Amount (₹)</label>
                          <input
                            className="input"
                            type="number"
                            value={editAmount}
                            onChange={(e) => setEditAmount(e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label style={{ fontSize: 11 }}>Note / Ref</label>
                          <input
                            className="input"
                            value={editNote}
                            onChange={(e) => setEditNote(e.target.value)}
                          />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "var(--s2)", justifyContent: "flex-end" }}>
                        <button className="btn btn-outline btn-sm" onClick={() => setEditingPaymentId(null)}>Cancel</button>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={editPayMutation.isPending}
                          onClick={() => {
                            const val = parseFloat(editAmount);
                            if (!(val >= 0)) { show("Invalid amount", "error"); return; }
                            editPayMutation.mutate({ pid: p.id, amount: val, note: editNote.trim() });
                          }}
                        >
                          {editPayMutation.isPending ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontWeight: 800, color: "var(--success)", fontSize: 15 }}>
                          +{formatINR(p.amount)}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
                          <span style={{ fontSize: 12, color: "var(--muted)" }}>{formatDateTime(p.date)}</span>
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            title="Edit this payment"
                            onClick={() => {
                              setEditingPaymentId(p.id);
                              setEditAmount(String(p.amount));
                              setEditNote(p.note || "");
                            }}
                          >
                            ✏️
                          </button>
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            style={{ color: "var(--error)" }}
                            title="Delete this payment"
                            onClick={() => setDeletePaymentId(p.id)}
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                      {p.note && (
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>
                          Note: {p.note}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            }) : (
              <div style={{ padding: "var(--s4)", color: "var(--muted)", fontSize: 14 }}>
                No payments recorded yet (Status: <strong>{o.pay_status}</strong>).
              </div>
            )}
          </div>

          {/* Add Additional Payment Box */}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Record {isSale ? "Payment Received" : "Payment Made"}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "var(--s3)" }}>
              <div className="field">
                <label>Amount (₹)</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder={o.balance > 0 ? `Up to ${formatINR(o.balance)}` : "Enter amount"}
                />
              </div>
              <div className="field">
                <label>Payment Mode</label>
                <select
                  className="input"
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                >
                  <option value="RTGS">RTGS (Bank Transfer)</option>
                  <option value="NEFT / Bank Transfer">NEFT / Bank Transfer</option>
                  <option value="IMPS">IMPS</option>
                  <option value="UPI">UPI / GPay / PhonePe</option>
                  <option value="Cheque">Cheque</option>
                  <option value="Cash">Cash</option>
                </select>
              </div>
              <div className="field">
                <label>Reference / Note (optional)</label>
                <input
                  className="input"
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="e.g. UTR / Cheque No."
                />
              </div>
            </div>
            <button className="btn btn-primary" onClick={addPayment} disabled={payMutation.isPending}>
              {payMutation.isPending ? "Recording…" : `💰 Add Payment via ${payMethod}`}
            </button>
          </div>
        </div>
      </div>

      {/* Payment Status Change Modal */}
      {showStatusModal && (
        <div className="modal-overlay" onClick={() => setShowStatusModal(false)}>
          <div className="modal" style={{ maxWidth: 480, width: "100%" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Change Payment Status</h3>
              <button className="modal-close" onClick={() => setShowStatusModal(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
              <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
                Update the payment status for <strong>{o.party_name}</strong> ({o.ref_no || id}).
                Order Total: <strong>{formatINR(o.total)}</strong>.
              </p>

              <div className="field">
                <label>Target Status</label>
                <div style={{ display: "flex", gap: "var(--s2)", marginTop: 4 }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${selectedStatus === "cleared" ? "btn-primary" : "btn-outline"}`}
                    style={{ flex: 1 }}
                    onClick={() => setSelectedStatus("cleared")}
                  >
                    ✓ Cleared (Paid)
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${selectedStatus === "partial" ? "btn-primary" : "btn-outline"}`}
                    style={{ flex: 1 }}
                    onClick={() => setSelectedStatus("partial")}
                  >
                    ⏳ Partial
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${selectedStatus === "unpaid" ? "btn-primary" : "btn-outline"}`}
                    style={{ flex: 1 }}
                    onClick={() => setSelectedStatus("unpaid")}
                  >
                    ✕ Unpaid
                  </button>
                </div>
              </div>

              {selectedStatus !== "unpaid" && (
                <div className="field">
                  <label>Payment Mode</label>
                  <select
                    className="input"
                    value={statusPayMethod}
                    onChange={(e) => setStatusPayMethod(e.target.value)}
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

              {selectedStatus === "partial" && (
                <div className="field">
                  <label>Total Amount Paid (₹)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={o.total}
                    value={customPaidAmount}
                    onChange={(e) => setCustomPaidAmount(e.target.value)}
                    placeholder={`e.g. ${Math.round(o.total / 2)}`}
                  />
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                    Remaining balance will be: {formatINR(Math.max(0, o.total - (parseFloat(customPaidAmount) || 0)))}
                  </div>
                </div>
              )}

              <div className="field">
                <label>Remarks / Reference (optional)</label>
                <input
                  className="input"
                  value={statusChangeNote}
                  onChange={(e) => setStatusChangeNote(e.target.value)}
                  placeholder="e.g. UTR / RTGS Ref / Bank Transfer Note"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowStatusModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => statusMutation.mutate()} disabled={statusMutation.isPending}>
                {statusMutation.isPending ? "Updating…" : "Apply Status Change"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Credit Terms Modal */}
      {showCreditModal && (
        <div className="modal-overlay" onClick={() => setShowCreditModal(false)}>
          <div className="modal" style={{ maxWidth: 440, width: "100%" }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Change Credit Days &amp; Due Date</h3>
              <button className="modal-close" onClick={() => setShowCreditModal(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
              <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
                Invoice: <strong>{o.ref_no || o.id}</strong> · {o.party_name}
              </p>

              <div className="field">
                <label>Credit Period Presets</label>
                <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap", marginTop: 4 }}>
                  {[0, 7, 15, 30, 45, 60].map(days => (
                    <button
                      key={days}
                      type="button"
                      className={`btn btn-sm ${creditDaysVal === days ? "btn-primary" : "btn-outline"}`}
                      onClick={() => setCreditDaysVal(days)}
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
                  value={creditDaysVal}
                  onChange={e => setCreditDaysVal(Math.max(0, parseInt(e.target.value) || 0))}
                  placeholder="e.g. 15"
                />
              </div>

              {/* Calculated preview */}
              {(() => {
                const baseDt = new Date(o.date || Date.now());
                const previewDue = new Date(baseDt.getTime() + creditDaysVal * 86400000);
                const now = new Date();
                const dueMidnight = new Date(previewDue.getFullYear(), previewDue.getMonth(), previewDue.getDate()).getTime();
                const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                const previewDaysLeft = Math.round((dueMidnight - nowMidnight) / 86400000);
                const isOverdue = o.balance > 0.5 && previewDaysLeft < 0;

                return (
                  <div style={{ background: "var(--surface-2)", padding: "var(--s3) var(--s4)", borderRadius: "var(--r-sm)", fontSize: 13 }}>
                    <div><strong>Calculated Due Date:</strong> {previewDue.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</div>
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                      <span><strong>Due Status:</strong></span>
                      {o.balance <= 0.5 ? (
                        <span className="badge badge-success">✓ Fully Cleared (₹0 Balance)</span>
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
              <button className="btn btn-outline" onClick={() => setShowCreditModal(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => creditMutation.mutate(creditDaysVal)}
                disabled={creditMutation.isPending}
              >
                {creditMutation.isPending ? "Updating…" : "Update Credit Terms"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Order Confirmation */}
      <ConfirmModal
        open={confirmDelete}
        title="Delete this order?"
        body="Stock changes from this order will be reversed. This cannot be undone."
        onConfirm={() => { setConfirmDelete(false); deleteMutation.mutate(); }}
        onCancel={() => setConfirmDelete(false)}
      />

      {/* Delete Single Payment Confirmation */}
      <ConfirmModal
        open={!!deletePaymentId}
        title="Delete payment entry?"
        body="This recorded payment will be removed and the order balance will recalculate accordingly."
        onConfirm={() => {
          if (deletePaymentId) {
            deletePayMutation.mutate(deletePaymentId);
          }
        }}
        onCancel={() => setDeletePaymentId(null)}
      />

      {/* WhatsApp Modal */}
      <WhatsAppModal
        open={showWhatsAppModal}
        onClose={() => setShowWhatsAppModal(false)}
        bill={whatsAppBill}
      />

      {/* Invoice Viewer Modal */}
      {showInvoiceViewer && o && (
        <InvoiceViewerModal
          order={o}
          onClose={() => setShowInvoiceViewer(false)}
          onInvoiceUpdated={() => {
            invalidateAll();
            refetch();
          }}
          onOpenReplace={() => {
            setShowInvoiceViewer(false);
            setShowInvoiceUpload(true);
          }}
        />
      )}

      {/* Invoice Upload / Replace Modal */}
      {showInvoiceUpload && o && (
        <InvoiceUploadModal
          order={o}
          onClose={() => setShowInvoiceUpload(false)}
          onSuccess={() => {
            invalidateAll();
            refetch();
          }}
        />
      )}
    </div>
  );
}

