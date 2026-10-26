// Comprehensive Test Suite for CRM Logic, Storage, and Edge Cases
import assert from "assert";

// Mock localStorage for Node environment
class MockLocalStorage {
  constructor() {
    this.store = {};
  }
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  }
  setItem(key, value) {
    this.store[key] = String(value);
  }
  removeItem(key) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
}

globalThis.localStorage = new MockLocalStorage();

// Import mockData handlers dynamically
async function runTests() {
  console.log("==================================================================");
  console.log("STARTING CRM THOROUGH LOGIC & BOUNDARY CONDITION VERIFICATION");
  console.log("==================================================================\n");

  const { handleMockApi, recalculateAllInventory } = await import("./src/mockData.ts");

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(`    Error: ${err.message}`);
      failed++;
    }
  }

  // 1. Boundary: Product Creation with ZERO stock
  test("Product creation with qty_on_hand = 0 does NOT create purchase order", () => {
    const pZero = handleMockApi("/products", "POST", {
      model: "24 Worldtech Basic Zero",
      sku: "WT-24-ZERO",
      category: "Television",
      cost_price: 5000,
      sell_price: 6500,
      qty_on_hand: 0,
    });
    assert.strictEqual(pZero.model, "24 Worldtech Basic Zero");
    assert.strictEqual(pZero.qty_on_hand, 0);

    const purchases = handleMockApi("/purchases", "GET");
    const matchingPO = purchases.find((p) => (p.items || []).some((it) => it.product_id === pZero.id));
    assert.strictEqual(matchingPO, undefined, "Expected no purchase order for 0 initial stock");
  });

  // 2. Boundary: Product Creation with POSITIVE initial stock (e.g. 55 inch mini led)
  test("Product creation with qty_on_hand > 0 automatically creates intake PO in purchases", () => {
    const pStock = handleMockApi("/products", "POST", {
      model: "55 inch mini led Pro Test",
      sku: "WT-55-MINI-LED",
      category: "Television",
      cost_price: 28000,
      sell_price: 34000,
      qty_on_hand: 10,
    });
    assert.strictEqual(pStock.model, "55 inch mini led Pro Test");
    assert.strictEqual(pStock.qty_on_hand, 10);

    const purchases = handleMockApi("/purchases", "GET");
    const matchingPO = purchases.find((p) => (p.items || []).some((it) => it.product_id === pStock.id));
    assert.ok(matchingPO, "Purchase order must be created for initial stock intake");
    assert.strictEqual(matchingPO.items[0].qty, 10);
    assert.strictEqual(matchingPO.items[0].rate, 28000);
    assert.strictEqual(matchingPO.total, 280000);
    assert.strictEqual(matchingPO.pay_status, "cleared");
    assert.strictEqual(matchingPO.party_name, "Worldtech Distributor / Initial Lot");
  });

  // 3. Boundary: Product Creation with negative or string stock values
  test("Product creation handles negative or malformed stock gracefully", () => {
    const pNeg = handleMockApi("/products", "POST", {
      model: "Negative Stock Test Model",
      sku: "WT-NEG-01",
      cost_price: "4500",
      sell_price: "6000",
      qty_on_hand: -15,
    });
    assert.strictEqual(pNeg.qty_on_hand, 0, "Negative stock on creation should normalize to 0");
  });

  // 4. Sales Order Creation with Registered Dealer
  test("Sale order creation with dealer decrements stock and computes aging", () => {
    const prodsBefore = handleMockApi("/products", "GET");
    const targetProd = prodsBefore.find((p) => p.model === "55 inch mini led Pro Test");
    assert.ok(targetProd);
    const startStock = targetProd.qty_on_hand;

    const newSale = handleMockApi("/sales", "POST", {
      party_id: "d1",
      party_name: "Shree Samartha Electronics",
      ref_no: "INV-TEST-001",
      date: new Date().toISOString(),
      credit_days: 15,
      items: [
        {
          product_id: targetProd.id,
          model: targetProd.model,
          qty: 3,
          rate: 34000,
        },
      ],
      initial_payment: 50000,
    });

    assert.strictEqual(newSale.total, 102000);
    assert.strictEqual(newSale.amount_paid, 50000);
    assert.strictEqual(newSale.balance, 52000);
    assert.strictEqual(newSale.pay_status, "partial");
    assert.strictEqual(newSale.credit_days, 15);
    assert.ok(newSale.due_date, "Due date must be generated");

    // Verify stock decremented
    const prodsAfter = handleMockApi("/products", "GET");
    const targetAfter = prodsAfter.find((p) => p.id === targetProd.id);
    assert.strictEqual(targetAfter.qty_on_hand, startStock - 3);
  });

  // 5. Sales Order Creation for Walk-in / Counter Sale (party_id = null)
  test("Walk-in / Counter sale without party_id is permitted and updates ledger", () => {
    const prodsBefore = handleMockApi("/products", "GET");
    const targetProd = prodsBefore.find((p) => p.model === "55 inch mini led Pro Test");
    const startStock = targetProd.qty_on_hand;

    const counterSale = handleMockApi("/sales", "POST", {
      party_id: null,
      party_name: "Walk-in Retail Buyer (Cash)",
      ref_no: "CS-TEST-999",
      date: new Date().toISOString(),
      credit_days: 0,
      items: [
        {
          product_id: targetProd.id,
          model: targetProd.model,
          qty: 1,
          rate: 34000,
        },
      ],
      initial_payment: 34000,
    });

    assert.strictEqual(counterSale.party_name, "Walk-in Retail Buyer (Cash)");
    assert.strictEqual(counterSale.total, 34000);
    assert.strictEqual(counterSale.balance, 0);
    assert.strictEqual(counterSale.pay_status, "cleared");

    const prodsAfter = handleMockApi("/products", "GET");
    const targetAfter = prodsAfter.find((p) => p.id === targetProd.id);
    assert.strictEqual(targetAfter.qty_on_hand, startStock - 1);
  });

  // 6. Boundary: Sale exceeding available stock (deficit/backorder allowance)
  test("Sale order exceeding on-hand stock is accepted with correct deficit tracking", () => {
    const prodsBefore = handleMockApi("/products", "GET");
    const targetProd = prodsBefore.find((p) => p.model === "55 inch mini led Pro Test");
    const startStock = targetProd.qty_on_hand; // e.g. 6

    const bigSale = handleMockApi("/sales", "POST", {
      party_name: "Wholesale Bulk Dealer",
      ref_no: "INV-BIG-01",
      items: [
        {
          product_id: targetProd.id,
          model: targetProd.model,
          qty: startStock + 5, // 11 units
          rate: 33000,
        },
      ],
      initial_payment: 0,
    });

    assert.strictEqual(bigSale.total, (startStock + 5) * 33000);
    const prodsAfter = handleMockApi("/products", "GET");
    const targetAfter = prodsAfter.find((p) => p.id === targetProd.id);
    assert.strictEqual(targetAfter.qty_on_hand, -5, "Stock correctly reflects deficit of -5 units");
  });

  // 7. Multi-line Items Order Calculation
  test("Multi-line sales order sums totals and decrements all respective product stocks", () => {
    const products = handleMockApi("/products", "GET");
    const p1 = products[0];
    const p2 = products[1];
    const p1Start = p1.qty_on_hand;
    const p2Start = p2.qty_on_hand;

    const multiSale = handleMockApi("/sales", "POST", {
      party_name: "Multi Item Electronics",
      ref_no: "INV-MULTI-01",
      items: [
        { product_id: p1.id, model: p1.model, qty: 2, rate: p1.sell_price },
        { product_id: p2.id, model: p2.model, qty: 3, rate: p2.sell_price },
      ],
    });

    const expectedTotal = Math.round((2 * p1.sell_price + 3 * p2.sell_price) * 100) / 100;
    assert.strictEqual(multiSale.total, expectedTotal);

    const prodsAfter = handleMockApi("/products", "GET");
    const p1After = prodsAfter.find((p) => p.id === p1.id);
    const p2After = prodsAfter.find((p) => p.id === p2.id);
    assert.strictEqual(p1After.qty_on_hand, p1Start - 2);
    assert.strictEqual(p2After.qty_on_hand, p2Start - 3);
  });

  // 8. Order Deletion Restores Stock
  test("Deleting a sale order completely restores inventory stock levels", () => {
    const prodsBefore = handleMockApi("/products", "GET");
    const p = prodsBefore[0];
    const initialQty = p.qty_on_hand;

    const tempSale = handleMockApi("/sales", "POST", {
      party_name: "Temporary Sale",
      items: [{ product_id: p.id, model: p.model, qty: 4, rate: p.sell_price }],
    });

    const pMid = handleMockApi("/products", "GET").find((x) => x.id === p.id);
    assert.strictEqual(pMid.qty_on_hand, initialQty - 4);

    // Delete the order
    handleMockApi(`/orders/${tempSale.id}`, "DELETE");

    const pRestored = handleMockApi("/products", "GET").find((x) => x.id === p.id);
    assert.strictEqual(pRestored.qty_on_hand, initialQty, "Inventory restored to original stock");
  });

  // 9. Payment Status Transitions
  test("Payment status transitions between unpaid, partial, and cleared", () => {
    const testOrder = handleMockApi("/sales", "POST", {
      party_name: "Payment Flow Dealer",
      items: [{ model: "TV", qty: 1, rate: 20000 }],
      initial_payment: 0,
    });
    assert.strictEqual(testOrder.pay_status, "unpaid");
    assert.strictEqual(testOrder.balance, 20000);

    // Patch to partial
    const partOrder = handleMockApi(`/orders/${testOrder.id}/payment-status`, "PATCH", {
      status: "partial",
      amount_paid: 8000,
    });
    assert.strictEqual(partOrder.pay_status, "partial");
    assert.strictEqual(partOrder.amount_paid, 8000);
    assert.strictEqual(partOrder.balance, 12000);

    // Patch to cleared
    const clearOrder = handleMockApi(`/orders/${testOrder.id}/payment-status`, "PATCH", {
      status: "cleared",
    });
    assert.strictEqual(clearOrder.pay_status, "cleared");
    assert.strictEqual(clearOrder.balance, 0);
    assert.strictEqual(clearOrder.amount_paid, 20000);

    // Patch back to unpaid
    const unpOrder = handleMockApi(`/orders/${testOrder.id}/payment-status`, "PATCH", {
      status: "unpaid",
    });
    assert.strictEqual(unpOrder.pay_status, "unpaid");
    assert.strictEqual(unpOrder.balance, 20000);
    assert.strictEqual(unpOrder.amount_paid, 0);
  });

  // 10. Credit Days and Due Date Updates
  test("Updating credit days correctly recalculates due date and overdue flags", () => {
    const baseDate = new Date("2026-10-01T10:00:00.000Z").toISOString();
    const credOrder = handleMockApi("/sales", "POST", {
      party_name: "Credit Terms Dealer",
      date: baseDate,
      credit_days: 10,
      items: [{ model: "TV", qty: 1, rate: 10000 }],
    });

    assert.strictEqual(credOrder.credit_days, 10);
    // Base Oct 1 + 10 days = Oct 11. Today is Oct 26, so due date passed!
    assert.strictEqual(credOrder.is_due_passed, true);
    assert.ok(credOrder.days_left < 0);

    // Update credit days to 45 days (Oct 1 + 45 days = Nov 15)
    const updatedCred = handleMockApi(`/orders/${credOrder.id}/credit-days`, "PATCH", {
      credit_days: 45,
    });
    assert.strictEqual(updatedCred.credit_days, 45);
    assert.strictEqual(updatedCred.is_due_passed, false);
    assert.ok(updatedCred.days_left > 0);
  });

  // 11. Invoice Attachment Storage Sanitization (Prevents QuotaExceededError)
  test("Invoice attachment strips bulky data_url from localStorage while preserving metadata", () => {
    const orderWithInv = handleMockApi("/sales", "POST", {
      party_name: "Invoice Test Dealer",
      items: [{ model: "TV", qty: 1, rate: 15000 }],
    });

    const fakeBulkyDataUrl = "data:image/jpeg;base64," + "A".repeat(50000); // 50KB base64 chunk
    const invAttachment = {
      name: "tax_invoice_2026.pdf",
      type: "application/pdf",
      size: 512000,
      data_url: fakeBulkyDataUrl,
      uploaded_at: new Date().toISOString(),
    };

    // Attach invoice
    const saved = handleMockApi(`/orders/${orderWithInv.id}/invoice`, "POST", {
      invoice_file: invAttachment,
    });

    assert.ok(saved.invoice_file);
    assert.strictEqual(saved.invoice_file.name, "tax_invoice_2026.pdf");

    // Inspect raw localStorage string
    const rawOrders = JSON.parse(globalThis.localStorage.getItem("soneja_demo_orders"));
    const storedOrder = rawOrders.find((o) => o.id === orderWithInv.id);
    assert.ok(storedOrder);
    assert.strictEqual(storedOrder.invoice_file.data_url, undefined, "Bulky data_url MUST be stripped from localStorage");
    assert.strictEqual(storedOrder.invoice_file.has_attachment, true);
    assert.strictEqual(storedOrder.invoice_file.name, "tax_invoice_2026.pdf");

    // Test invoice deletion
    const delRes = handleMockApi(`/orders/${orderWithInv.id}/invoice`, "DELETE");
    assert.strictEqual(delRes.invoice_file, null);
  });

  // 12. Dashboard & Financial Reports Aggregation
  test("Dashboard and reports aggregate revenues, expenses, payables and stock value", () => {
    const dash = handleMockApi("/dashboard", "GET");
    assert.ok(dash.total_sales > 0, "Total sales must be non-zero");
    assert.ok(typeof dash.receivable === "number");
    assert.ok(typeof dash.payable === "number");
    assert.ok(typeof dash.inventory_value === "number");
    assert.ok(typeof dash.units_in_stock === "number");

    const reports = handleMockApi("/reports", "GET");
    assert.ok(reports.summary);
    assert.ok(reports.sales_by_month);
    assert.ok(reports.top_products);
  });

  // 13. Payment Addition via POST /orders/:id/payments
  test("Adding single payment increments amount_paid and decrements balance", () => {
    const o = handleMockApi("/sales", "POST", {
      party_name: "Add Payment Test Dealer",
      items: [{ model: "TV", qty: 1, rate: 30000 }],
      initial_payment: 0,
    });
    assert.strictEqual(o.balance, 30000);

    const paidOrder = handleMockApi(`/orders/${o.id}/payments`, "POST", {
      amount: 12000,
      note: "Partial RTGS advance",
      date: new Date().toISOString(),
    });
    assert.strictEqual(paidOrder.amount_paid, 12000);
    assert.strictEqual(paidOrder.balance, 18000);
    assert.strictEqual(paidOrder.pay_status, "partial");
    assert.strictEqual(paidOrder.payments.length, 1);
  });

  // 14. Payment Editing via PUT /orders/:id/payments/:pid
  test("Editing payment amount updates order balance accordingly", () => {
    const o = handleMockApi("/sales", "POST", {
      party_name: "Edit Payment Test Dealer",
      items: [{ model: "TV", qty: 1, rate: 25000 }],
      initial_payment: 5000,
    });
    const pid = o.payments[0].id;
    assert.strictEqual(o.amount_paid, 5000);

    // Edit payment from 5000 to 10000
    const editedOrder = handleMockApi(`/orders/${o.id}/payments/${pid}`, "PUT", {
      amount: 10000,
      note: "Corrected amount via bank statement",
    });
    assert.strictEqual(editedOrder.amount_paid, 10000);
    assert.strictEqual(editedOrder.balance, 15000);
  });

  // 15. Payment Deletion via DELETE /orders/:id/payments/:pid
  test("Deleting a recorded payment removes it and restores balance", () => {
    const o = handleMockApi("/sales", "POST", {
      party_name: "Delete Payment Test Dealer",
      items: [{ model: "TV", qty: 1, rate: 20000 }],
      initial_payment: 7000,
    });
    const pid = o.payments[0].id;

    const afterDel = handleMockApi(`/orders/${o.id}/payments/${pid}`, "DELETE");
    assert.strictEqual(afterDel.payments.length, 0);
    assert.strictEqual(afterDel.amount_paid, 0);
    assert.strictEqual(afterDel.balance, 20000);
    assert.strictEqual(afterDel.pay_status, "unpaid");
  });

  // 16. Manual Stock Adjustment via POST /products/:pid/adjust-stock
  test("Manual stock adjustment updates qty_on_hand and recalculates inventory", () => {
    const prods = handleMockApi("/products", "GET");
    const p = prods[0];

    const adjusted = handleMockApi(`/products/${p.id}/adjust-stock`, "POST", {
      new_qty: 99,
      reason: "Physical godown audit count",
    });
    assert.strictEqual(adjusted.qty_on_hand, 99);

    const checkProds = handleMockApi("/products", "GET");
    const updatedP = checkProds.find((x) => x.id === p.id);
    assert.strictEqual(updatedP.qty_on_hand, 99);
  });

  // 17. Product Price Updates via PUT /products/:pid
  test("Updating product sell_price and cost_price persists cleanly without mutating historical order lines", () => {
    const p = handleMockApi("/products", "POST", {
      model: "Price Change TV",
      cost_price: 10000,
      sell_price: 13000,
      qty_on_hand: 5,
    });

    const o = handleMockApi("/sales", "POST", {
      party_name: "Dealer Before Price Change",
      items: [{ product_id: p.id, model: p.model, qty: 1, rate: 13000 }],
    });
    assert.strictEqual(o.total, 13000);

    // Update product prices
    const updatedProd = handleMockApi(`/products/${p.id}`, "PUT", {
      ...p,
      cost_price: 11000,
      sell_price: 14500,
    });
    assert.strictEqual(updatedProd.sell_price, 14500);

    // Verify existing order kept its historical rate of 13000
    const oCheck = handleMockApi(`/sales/${o.id}`, "GET");
    assert.strictEqual(oCheck.items[0].rate, 13000);
  });

  // 18. Floating-point Decimal Accuracy on Orders
  test("Decimal quantity and rate calculations avoid JavaScript IEEE 754 precision errors", () => {
    const decOrder = handleMockApi("/sales", "POST", {
      party_name: "Decimal Accuracy Dealer",
      items: [
        { model: "Cable", qty: 3, rate: 19.99 },
        { model: "Remote", qty: 7, rate: 149.5 },
      ],
      initial_payment: 0.1,
    });
    // 3 * 19.99 = 59.97; 7 * 149.5 = 1046.5; total = 1106.47
    assert.strictEqual(decOrder.total, 1106.47);
    assert.strictEqual(decOrder.amount_paid, 0.1);
    assert.strictEqual(decOrder.balance, 1106.37);
  });

  // 19. Overpayment Boundary Condition
  test("Overpayment sets balance to 0 and pay_status to cleared", () => {
    const o = handleMockApi("/sales", "POST", {
      party_name: "Overpayment Dealer",
      items: [{ model: "TV", qty: 1, rate: 10000 }],
      initial_payment: 12000, // Paid more than total
    });
    assert.strictEqual(o.pay_status, "cleared");
    assert.strictEqual(o.balance, 0, "Balance should never be negative");
  });

  console.log("\n==================================================================");
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("FATAL ERROR IN TEST SUITE:", err);
  process.exit(1);
});
