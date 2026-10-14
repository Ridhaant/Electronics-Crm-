// Soneja Electronics - Firebase Real-Time Synchronization Engine
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  getDatabase,
  type Database,
  ref,
  set,
  remove,
  onValue,
  get,
} from "firebase/database";
import type { QueryClient } from "@tanstack/react-query";
import {
  getActiveFirebaseConfig,
  type FirebaseConfig,
  DEFAULT_FIREBASE_CONFIG,
} from "./firebaseConfig";
import {
  SEED_PRODUCTS,
  SEED_DEALERS,
  SEED_ORDERS,
  SEED_EXPENSES,
  recalculateAllInventory,
} from "./mockData";

let rtdbInstance: Database | null = null;
let firebaseAppInstance: FirebaseApp | null = null;
let activeUnsubscribers: (() => void)[] = [];
let isSeeding = false;
let syncStatusListeners: ((status: SyncStatus) => void)[] = [];

export interface SyncStatus {
  connected: boolean;
  mode: "rtdb" | "none";
  projectId: string;
  lastSyncedAt: Date | null;
  activeCollectionCounts: {
    orders: number;
    products: number;
    dealers: number;
    expenses: number;
  };
  error: string | null;
}

let currentStatus: SyncStatus = {
  connected: false,
  mode: "none",
  projectId: "",
  lastSyncedAt: null,
  activeCollectionCounts: { orders: 0, products: 0, dealers: 0, expenses: 0 },
  error: null,
};

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

export function subscribeToSyncStatus(listener: (status: SyncStatus) => void): () => void {
  syncStatusListeners.push(listener);
  listener(currentStatus);
  return () => {
    syncStatusListeners = syncStatusListeners.filter((l) => l !== listener);
  };
}

function notifyStatusUpdate(patch: Partial<SyncStatus>) {
  currentStatus = { ...currentStatus, ...patch };
  syncStatusListeners.forEach((l) => l(currentStatus));
}

function sanitizeForFirebase(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(sanitizeForFirebase);
  if (typeof obj === "object" && !(obj instanceof Date)) {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) {
        res[k] = sanitizeForFirebase(v);
      }
    }
    return res;
  }
  return obj;
}

export function getRtdbInstance(): Database | null {
  if (rtdbInstance) return rtdbInstance;

  const config = getActiveFirebaseConfig() || DEFAULT_FIREBASE_CONFIG;
  if (!config || !config.apiKey || !config.projectId) {
    notifyStatusUpdate({ connected: false, mode: "none", error: null });
    return null;
  }

  try {
    const app = getApps().length === 0 ? initializeApp(config) : getApp();
    firebaseAppInstance = app;

    const dbUrl = config.databaseURL || `https://${config.projectId}-default-rtdb.firebaseio.com`;
    rtdbInstance = getDatabase(app, dbUrl);

    notifyStatusUpdate({
      connected: true,
      mode: "rtdb",
      projectId: config.projectId,
      error: null,
    });

    return rtdbInstance;
  } catch (err: any) {
    console.error("Firebase Realtime Database init failed:", err);
    notifyStatusUpdate({ connected: false, mode: "none", error: err.message });
    return null;
  }
}

export function isFirebaseConnected(): boolean {
  return rtdbInstance !== null;
}

// Tombstone tracking helpers for permanent deletions across devices
export function getLocalDeletedIds(collection: string): Set<string> {
  try {
    const raw = localStorage.getItem(`soneja_demo_deleted_${collection}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function recordLocalDeletedId(collection: string, id: string) {
  try {
    const set = getLocalDeletedIds(collection);
    set.add(id);
    localStorage.setItem(`soneja_demo_deleted_${collection}`, JSON.stringify(Array.from(set)));
  } catch {}
}

export function startRealtimeSync(queryClient: QueryClient) {
  stopRealtimeSync();

  const rtdb = getRtdbInstance();
  if (!rtdb) return;

  const STORAGE_PREFIX = "soneja_demo_";

  function getLocalStore<T>(key: string, defaultVal: T): T {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw ? JSON.parse(raw) : defaultVal;
    } catch {
      return defaultVal;
    }
  }

  function updateLocalStore(key: string, data: any[]) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(data));
    } catch {}
  }

  // 0. Deleted Items Listeners (Tombstones from Cloud)
  const unsubDeletedOrders = onValue(
    ref(rtdb, "deleted_orders"),
    (snapshot) => {
      const val = snapshot.val();
      if (val) {
        const deletedSet = getLocalDeletedIds("orders");
        Object.keys(val).forEach((id) => deletedSet.add(id));
        try {
          localStorage.setItem("soneja_demo_deleted_orders", JSON.stringify(Array.from(deletedSet)));
        } catch {}
        const currentOrders = getLocalStore<any[]>("orders", []);
        const filtered = currentOrders.filter((o) => o && o.id && !deletedSet.has(o.id));
        if (filtered.length !== currentOrders.length) {
          updateLocalStore("orders", filtered);
          const currentProducts = getLocalStore<any[]>("products", SEED_PRODUCTS);
          const reconciled = recalculateAllInventory(currentProducts, filtered);
          updateLocalStore("products", reconciled);

          queryClient.invalidateQueries({ queryKey: ["sales"] });
          queryClient.invalidateQueries({ queryKey: ["purchases"] });
          queryClient.invalidateQueries({ queryKey: ["orders"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          queryClient.invalidateQueries({ queryKey: ["reports"] });
          queryClient.invalidateQueries({ queryKey: ["products"] });
        }
      }
    }
  );
  activeUnsubscribers.push(unsubDeletedOrders);

  // 1. Orders listener
  const unsubOrders = onValue(
    ref(rtdb, "orders"),
    (snapshot) => {
      const val = snapshot.val();
      const allOrders = val ? Object.values(val) : [];
      const deletedIds = getLocalDeletedIds("orders");

      // Strictly filter out any deleted orders so they never show or re-save
      const orders = (allOrders as any[])
        .filter((o) => o && o.id && !deletedIds.has(o.id) && !o.deleted_at);
      orders.sort((a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());

      // If any order in RTDB is found in deletedIds, actively purge it from RTDB
      for (const o of allOrders as any[]) {
        if (o && o.id && deletedIds.has(o.id)) {
          remove(ref(rtdb, `orders/${o.id}`)).catch(() => {});
        }
      }

      updateLocalStore("orders", orders);

      // Ledger-based inventory recomputation on incoming order changes
      const currentProducts = getLocalStore<any[]>("products", SEED_PRODUCTS);
      const reconciled = recalculateAllInventory(currentProducts, orders);
      updateLocalStore("products", reconciled);

      notifyStatusUpdate({
        mode: "rtdb",
        lastSyncedAt: new Date(),
        activeCollectionCounts: {
          ...currentStatus.activeCollectionCounts,
          orders: orders.length,
          products: reconciled.length,
        },
      });

      // Invalidate all related queries so UI immediately re-renders
      queryClient.invalidateQueries({ queryKey: ["sales"] });
      queryClient.invalidateQueries({ queryKey: ["purchases"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
    (err) => {
      console.warn("RTDB orders listener error:", err);
      notifyStatusUpdate({ error: err.message });
    }
  );
  activeUnsubscribers.push(unsubOrders);

  // 2. Products listener
  const unsubProducts = onValue(
    ref(rtdb, "products"),
    (snapshot) => {
      const val = snapshot.val();
      const allProducts = val ? Object.values(val) : [];
      const deletedIds = getLocalDeletedIds("products");
      const products = (allProducts as any[])
        .filter((p) => p && p.id && !deletedIds.has(p.id) && !p.deleted_at);

      const currentOrders = getLocalStore<any[]>("orders", []);
      const reconciled = recalculateAllInventory(products, currentOrders);
      updateLocalStore("products", reconciled);

      notifyStatusUpdate({
        lastSyncedAt: new Date(),
        activeCollectionCounts: {
          ...currentStatus.activeCollectionCounts,
          products: reconciled.length,
        },
      });

      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    (err) => {
      console.warn("RTDB products listener error:", err);
    }
  );
  activeUnsubscribers.push(unsubProducts);

  // 3. Dealers listener
  const unsubDealers = onValue(
    ref(rtdb, "dealers"),
    (snapshot) => {
      const val = snapshot.val();
      const allDealers = val ? Object.values(val) : [];
      const deletedIds = getLocalDeletedIds("dealers");
      const dealers = (allDealers as any[])
        .filter((d) => d && d.id && !deletedIds.has(d.id) && !d.deleted_at);
      updateLocalStore("dealers", dealers);

      notifyStatusUpdate({
        lastSyncedAt: new Date(),
        activeCollectionCounts: {
          ...currentStatus.activeCollectionCounts,
          dealers: dealers.length,
        },
      });

      queryClient.invalidateQueries({ queryKey: ["dealers"] });
    },
    (err) => {
      console.warn("RTDB dealers listener error:", err);
    }
  );
  activeUnsubscribers.push(unsubDealers);

  // 4. Expenses listener
  const unsubExpenses = onValue(
    ref(rtdb, "expenses"),
    (snapshot) => {
      const val = snapshot.val();
      const allExpenses = val ? Object.values(val) : [];
      const deletedIds = getLocalDeletedIds("expenses");
      const expenses = (allExpenses as any[])
        .filter((e) => e && e.id && !deletedIds.has(e.id) && !e.deleted_at);
      expenses.sort((a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
      updateLocalStore("expenses", expenses);

      notifyStatusUpdate({
        lastSyncedAt: new Date(),
        activeCollectionCounts: {
          ...currentStatus.activeCollectionCounts,
          expenses: expenses.length,
        },
      });

      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    (err) => {
      console.warn("RTDB expenses listener error:", err);
    }
  );
  activeUnsubscribers.push(unsubExpenses);
}

export function stopRealtimeSync() {
  activeUnsubscribers.forEach((unsub) => {
    try {
      unsub();
    } catch {}
  });
  activeUnsubscribers = [];
}

// Initial seeder for Realtime Database (guarded by meta/seeded so it never re-seeds over deletions)
async function seedRtdb(db: Database, queryClient: QueryClient) {
  if (isSeeding) return;
  isSeeding = true;
  try {
    const metaSnap = await get(ref(db, "meta/seeded"));
    if (!metaSnap.exists()) {
      console.info("Seeding Firebase Realtime Database with initial data...");
      const pMap: Record<string, any> = {};
      SEED_PRODUCTS.forEach((p) => { pMap[p.id] = sanitizeForFirebase(p); });
      const dMap: Record<string, any> = {};
      SEED_DEALERS.forEach((d) => { dMap[d.id] = sanitizeForFirebase(d); });
      const oMap: Record<string, any> = {};
      SEED_ORDERS.forEach((o) => { oMap[o.id] = sanitizeForFirebase(o); });
      const eMap: Record<string, any> = {};
      SEED_EXPENSES.forEach((e) => { eMap[e.id] = sanitizeForFirebase(e); });

      await set(ref(db, "products"), pMap);
      await set(ref(db, "dealers"), dMap);
      await set(ref(db, "orders"), oMap);
      await set(ref(db, "expenses"), eMap);
      await set(ref(db, "meta/seeded"), true);
      queryClient.invalidateQueries();
    }
  } catch (err) {
    console.warn("RTDB seeding error:", err);
  } finally {
    isSeeding = false;
  }
}

// Write-through mutations directly to Realtime Database with Tombstones
export async function syncOrderToFirestore(order: any) {
  const rtdb = getRtdbInstance();
  if (!rtdb || !order || !order.id) return;
  try {
    await set(ref(rtdb, `orders/${order.id}`), sanitizeForFirebase(order));
  } catch (e) {
    console.error("RTDB syncOrder failed:", e);
  }
}

export async function deleteOrderFromFirestore(orderId: string) {
  recordLocalDeletedId("orders", orderId);
  const rtdb = getRtdbInstance();
  if (!rtdb || !orderId) return;
  try {
    await set(ref(rtdb, `deleted_orders/${orderId}`), Date.now());
    await remove(ref(rtdb, `orders/${orderId}`));
  } catch (e) {
    console.error("RTDB deleteOrder failed:", e);
  }
}

export async function syncProductToFirestore(product: any) {
  const rtdb = getRtdbInstance();
  if (!rtdb || !product || !product.id) return;
  try {
    await set(ref(rtdb, `products/${product.id}`), sanitizeForFirebase(product));
  } catch (e) {
    console.error("RTDB syncProduct failed:", e);
  }
}

export async function syncProductsBatchToFirestore(products: any[]) {
  const rtdb = getRtdbInstance();
  if (!rtdb || !products || products.length === 0) return;
  try {
    const pMap: Record<string, any> = {};
    products.forEach((p) => {
      if (p.id) pMap[p.id] = sanitizeForFirebase(p);
    });
    await set(ref(rtdb, "products"), pMap);
  } catch (e) {
    console.error("RTDB syncProductsBatch failed:", e);
  }
}

export async function deleteProductFromFirestore(productId: string) {
  recordLocalDeletedId("products", productId);
  const rtdb = getRtdbInstance();
  if (!rtdb || !productId) return;
  try {
    await set(ref(rtdb, `deleted_products/${productId}`), Date.now());
    await remove(ref(rtdb, `products/${productId}`));
  } catch (e) {
    console.error("RTDB deleteProduct failed:", e);
  }
}

export async function syncDealerToFirestore(dealer: any) {
  const rtdb = getRtdbInstance();
  if (!rtdb || !dealer || !dealer.id) return;
  try {
    await set(ref(rtdb, `dealers/${dealer.id}`), sanitizeForFirebase(dealer));
  } catch (e) {
    console.error("RTDB syncDealer failed:", e);
  }
}

export async function deleteDealerFromFirestore(dealerId: string) {
  recordLocalDeletedId("dealers", dealerId);
  const rtdb = getRtdbInstance();
  if (!rtdb || !dealerId) return;
  try {
    await set(ref(rtdb, `deleted_dealers/${dealerId}`), Date.now());
    await remove(ref(rtdb, `dealers/${dealerId}`));
  } catch (e) {
    console.error("RTDB deleteDealer failed:", e);
  }
}

export async function syncExpenseToFirestore(expense: any) {
  const rtdb = getRtdbInstance();
  if (!rtdb || !expense || !expense.id) return;
  try {
    await set(ref(rtdb, `expenses/${expense.id}`), sanitizeForFirebase(expense));
  } catch (e) {
    console.error("RTDB syncExpense failed:", e);
  }
}

export async function deleteExpenseFromFirestore(expenseId: string) {
  recordLocalDeletedId("expenses", expenseId);
  const rtdb = getRtdbInstance();
  if (!rtdb || !expenseId) return;
  try {
    await set(ref(rtdb, `deleted_expenses/${expenseId}`), Date.now());
    await remove(ref(rtdb, `expenses/${expenseId}`));
  } catch (e) {
    console.error("RTDB deleteExpense failed:", e);
  }
}
