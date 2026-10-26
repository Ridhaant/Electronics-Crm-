import React, { useState, useEffect } from "react";
import { formatFileSize, getInvoiceFromIdb, saveInvoiceToIdb, deleteInvoiceFromIdb, type InvoiceAttachment } from "./invoiceStorage";
import { apiGet, apiDelete } from "./api";
import { formatDateTime } from "./format";
import { useToast } from "./toast";
import { Spinner } from "./ui";

interface InvoiceViewerModalProps {
  order: any;
  onClose: () => void;
  onInvoiceUpdated?: (updatedOrder: any) => void;
  onOpenReplace?: () => void;
}

export function InvoiceViewerModal({
  order,
  onClose,
  onInvoiceUpdated,
  onOpenReplace,
}: InvoiceViewerModalProps) {
  const { show } = useToast();
  const [invoice, setInvoice] = useState<InvoiceAttachment | null>(order.invoice_file || null);
  const [loading, setLoading] = useState(!order.invoice_file?.data_url);
  const [zoom, setZoom] = useState(1);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (order.invoice_file && order.invoice_file.data_url) {
        if (mounted) {
          setInvoice(order.invoice_file);
          setLoading(false);
        }
        return;
      }
      try {
        const idbInvoice = await getInvoiceFromIdb(order.id);
        if (mounted && idbInvoice?.data_url) {
          setInvoice(idbInvoice);
          setLoading(false);
          return;
        }

        // Check if API has full document
        try {
          const apiInv = await apiGet<InvoiceAttachment>(`/orders/${order.id}/invoice`);
          if (mounted && apiInv && (apiInv as any).data_url) {
            setInvoice(apiInv);
            saveInvoiceToIdb(order.id, apiInv).catch(() => {});
            setLoading(false);
            return;
          }
        } catch {}

        if (mounted) {
          if (idbInvoice) {
            setInvoice(idbInvoice);
          } else if (order.invoice_file) {
            setInvoice(order.invoice_file);
          }
          setLoading(false);
        }
      } catch {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, [order]);

  function handleDownload() {
    if (!invoice?.data_url) return;
    const a = document.createElement("a");
    a.href = invoice.data_url;
    a.download = invoice.name || `Invoice_${order.ref_no || order.id}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    show("Download started", "success");
  }

  function handleOpenNewTab() {
    if (!invoice?.data_url) return;
    const win = window.open();
    if (win) {
      if (invoice.type.includes("pdf")) {
        win.location.href = invoice.data_url;
      } else {
        win.document.write(
          `<html><head><title>${invoice.name}</title><style>body{margin:0;background:#0f172a;display:flex;justify-content:center;align-items:center;min-height:100vh;}</style></head><body><img src="${invoice.data_url}" style="max-width:98vw;max-height:98vh;object-fit:contain;box-shadow:0 10px 25px rgba(0,0,0,0.5);border-radius:4px;"/></body></html>`
        );
        win.document.close();
      }
    }
  }

  function handlePrint() {
    if (!invoice?.data_url) return;
    if (invoice.type.includes("pdf")) {
      const win = window.open(invoice.data_url);
      if (win) {
        win.focus();
        setTimeout(() => win.print(), 600);
      }
    } else {
      const win = window.open("");
      if (win) {
        win.document.write(
          `<html><head><title>${invoice.name}</title></head><body style="margin:0;display:flex;justify-content:center;align-items:center;"><img src="${invoice.data_url}" style="max-width:100%;height:auto;" onload="window.print();window.close();"/></body></html>`
        );
        win.document.close();
      }
    }
  }

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await deleteInvoiceFromIdb(order.id);
      const res = await apiDelete(`/orders/${order.id}/invoice`);
      show("Invoice attachment deleted", "info");
      if (onInvoiceUpdated) onInvoiceUpdated(res || { ...order, invoice_file: null });
      onClose();
    } catch (e: any) {
      show(e?.message || "Failed to remove invoice", "error");
    } finally {
      setIsDeleting(false);
      setShowConfirmDelete(false);
    }
  }

  const isPdf = invoice?.type?.includes("pdf") || invoice?.name?.toLowerCase().endsWith(".pdf");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.78)",
        backdropFilter: "blur(6px)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--s4)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--surface)",
          borderRadius: "var(--r-lg)",
          width: "100%",
          maxWidth: "1050px",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 60px rgba(0, 0, 0, 0.45)",
          border: "1px solid var(--border)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header Bar */}
        <div
          style={{
            padding: "var(--s3) var(--s4)",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "var(--s3)",
            background: "var(--surface-2)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", minWidth: 0 }}>
            <span style={{ fontSize: 24 }}>{isPdf ? "📄" : "🖼️"}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 800, fontSize: 16 }}>
                  {order.kind === "purchase" ? "Purchase Invoice" : "Sale Invoice Document"}
                </span>
                <span className="badge badge-brand" style={{ fontSize: 11 }}>
                  {order.ref_no || order.id}
                </span>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>· {order.party_name}</span>
              </div>
              {invoice && (
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600 }}>{invoice.name}</span>
                  <span>({formatFileSize(invoice.size)})</span>
                  {invoice.uploaded_at && <span>· Uploaded {formatDateTime(invoice.uploaded_at)}</span>}
                </div>
              )}
            </div>
          </div>

          {/* Action Toolbar */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
            {invoice?.data_url && (
              <>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={handleDownload}
                  title="Download invoice file to computer"
                >
                  ⬇️ Download
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm hide-mobile"
                  onClick={handlePrint}
                  title="Print invoice document"
                >
                  🖨️ Print
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm hide-mobile"
                  onClick={handleOpenNewTab}
                  title="Open in new window"
                >
                  ↗️ Fullscreen
                </button>
              </>
            )}
            {onOpenReplace && (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={onOpenReplace}
                title="Upload a new replacement invoice"
              >
                🔄 Replace
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ color: "var(--error)" }}
              onClick={() => setShowConfirmDelete(true)}
              title="Remove this invoice"
            >
              🗑️
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={onClose}
              style={{ fontSize: 18, marginLeft: 4 }}
              title="Close modal"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Modal Body: Document Viewer */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "var(--s4)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: isPdf ? "#334155" : "#0f172a",
            minHeight: "420px",
            position: "relative",
          }}
        >
          {loading ? (
            <div style={{ padding: "var(--s6)", color: "#fff" }}>
              <Spinner />
            </div>
          ) : !invoice?.data_url ? (
            <div style={{ textAlign: "center", color: "#94a3b8", padding: "var(--s6)" }}>
              <div style={{ fontSize: 42, marginBottom: 12 }}>⚠️</div>
              <h4>Invoice document data could not be loaded</h4>
              <p style={{ fontSize: 13, maxWidth: 400, margin: "8px auto" }}>
                The invoice metadata exists, but the file data was not found in browser storage.
              </p>
              {onOpenReplace && (
                <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={onOpenReplace}>
                  📤 Upload Fresh Copy
                </button>
              )}
            </div>
          ) : isPdf ? (
            <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
              <iframe
                src={invoice.data_url}
                title={invoice.name}
                style={{
                  width: "100%",
                  height: "72vh",
                  border: "none",
                  borderRadius: "var(--r-md)",
                  background: "#fff",
                }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 10,
                  fontSize: 12,
                  color: "#cbd5e1",
                }}
              >
                <span>PDF Document: {invoice.name}</span>
                <button
                  type="button"
                  className="btn btn-outline btn-xs"
                  style={{ color: "#fff", borderColor: "#64748b" }}
                  onClick={handleDownload}
                >
                  Can't see PDF? Click here to Download
                </button>
              </div>
            </div>
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
              }}
            >
              {/* Zoom Controls */}
              <div
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  display: "flex",
                  gap: 6,
                  background: "rgba(0,0,0,0.6)",
                  backdropFilter: "blur(4px)",
                  padding: "4px 8px",
                  borderRadius: "var(--r-md)",
                  zIndex: 10,
                }}
              >
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  style={{ color: "#fff" }}
                  onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
                  title="Zoom Out"
                >
                  🔍-
                </button>
                <span style={{ color: "#fff", fontSize: 11, alignSelf: "center", minWidth: 40, textAlign: "center" }}>
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  style={{ color: "#fff" }}
                  onClick={() => setZoom((z) => Math.min(3, z + 0.2))}
                  title="Zoom In"
                >
                  🔍+
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  style={{ color: "#fff" }}
                  onClick={() => setZoom(1)}
                  title="Reset Zoom"
                >
                  Reset
                </button>
              </div>

              <div
                style={{
                  maxHeight: "72vh",
                  maxWidth: "100%",
                  overflow: "auto",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  padding: 12,
                }}
              >
                <img
                  src={invoice.data_url}
                  alt={invoice.name}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "70vh",
                    objectFit: "contain",
                    transform: `scale(${zoom})`,
                    transformOrigin: "center center",
                    transition: "transform 0.15s ease-out",
                    boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
                    borderRadius: "var(--r-sm)",
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Delete Confirmation Overlay */}
        {showConfirmDelete && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0, 0, 0, 0.8)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "var(--s4)",
              zIndex: 10000,
            }}
          >
            <div
              className="card"
              style={{
                maxWidth: 420,
                width: "100%",
                background: "var(--surface)",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                gap: "var(--s3)",
              }}
            >
              <div style={{ fontSize: 32 }}>🗑️</div>
              <h3 style={{ margin: 0 }}>Remove Invoice Attachment?</h3>
              <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
                This will delete the attached invoice file <strong>{invoice?.name}</strong> from order{" "}
                <strong>{order.ref_no || order.id}</strong>.
              </p>
              <div style={{ display: "flex", gap: "var(--s2)", justifyContent: "center", marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => setShowConfirmDelete(false)}
                  disabled={isDeleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={handleDelete}
                  disabled={isDeleting}
                >
                  {isDeleting ? "Deleting..." : "Yes, Delete Invoice"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
