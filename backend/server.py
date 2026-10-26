from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, Body
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal
import uuid
from datetime import datetime, timezone, timedelta
import jwt
from passlib.context import CryptContext

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ.get('DB_NAME', 'soneja_crm')]

JWT_SECRET = os.environ.get('JWT_SECRET', 'soneja-crm-distribution-secret-key-2026')
JWT_ALGORITHM = os.environ.get('JWT_ALGORITHM', 'HS256')
TOKEN_MINUTES = int(os.environ.get('ACCESS_TOKEN_MINUTES', '43200'))

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)

app = FastAPI(title="Soneja CRM API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("soneja")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


def days_since(iso: str) -> int:
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0, (datetime.now(timezone.utc) - dt).days)
    except Exception:
        return 0


def clean(doc: dict) -> dict:
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class LoginIn(BaseModel):
    email: EmailStr
    password: str


class StaffCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    name: str = Field(min_length=1, max_length=100)


class StaffUpdate(BaseModel):
    name: Optional[str] = None
    active: Optional[bool] = None


class ProductIn(BaseModel):
    model: str
    sku: Optional[str] = None
    category: str = "Television"
    cost_price: float = 0        # GST-inclusive purchase cost / unit
    sell_price: float = 0        # default selling price / unit (editable per order)
    qty_on_hand: Optional[float] = None
    image: Optional[str] = None


class DealerIn(BaseModel):
    shop_name: str
    contact_person: Optional[str] = ""
    phone: Optional[str] = ""
    whatsapp: Optional[str] = ""
    area: Optional[str] = ""
    notes: Optional[str] = ""
    gstin: Optional[str] = ""
    address: Optional[str] = ""


class LineItem(BaseModel):
    product_id: str
    model: str
    qty: float
    rate: float                  # per-unit price (GST inclusive)


class OrderIn(BaseModel):
    party_id: Optional[str] = None   # dealer_id for sales, blank for purchases
    party_name: str                  # dealer name / supplier name
    ref_no: Optional[str] = None     # invoice no / PO no
    date: Optional[str] = None
    notes: Optional[str] = ""
    items: List[LineItem]
    initial_payment: Optional[float] = 0
    payment_status: Optional[str] = None  # "cleared" | "unpaid" | "partial"
    amount_paid: Optional[float] = None
    credit_days: Optional[int] = 15
    invoice_file: Optional[dict] = None


class PaymentIn(BaseModel):
    amount: float = Field(gt=0)
    date: Optional[str] = None
    note: Optional[str] = ""


class PaymentStatusUpdate(BaseModel):
    status: str                          # "cleared" | "unpaid" | "partial"
    amount_paid: Optional[float] = None
    note: Optional[str] = ""


class PaymentUpdate(BaseModel):
    amount: float = Field(gt=0)
    date: Optional[str] = None
    note: Optional[str] = ""


class OrderEdit(BaseModel):
    ref_no: Optional[str] = None
    date: Optional[str] = None
    party_id: Optional[str] = None
    party_name: Optional[str] = None
    notes: Optional[str] = None
    credit_days: Optional[int] = None
    invoice_file: Optional[dict] = None


class CreditDaysIn(BaseModel):
    credit_days: int = Field(ge=0, le=365)

class StockAdjustIn(BaseModel):
    qty_delta: Optional[float] = None
    new_qty: Optional[float] = None
    reason: Optional[str] = ""


class ExpenseIn(BaseModel):
    category: str
    amount: float = Field(gt=0)
    date: Optional[str] = None
    note: Optional[str] = ""


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def create_token(user: dict) -> str:
    now = datetime.now(timezone.utc)
    claims = {"sub": user["id"], "role": user["role"], "iat": now,
              "exp": now + timedelta(minutes=TOKEN_MINUTES)}
    return jwt.encode(claims, JWT_SECRET, algorithm=JWT_ALGORITHM)


def public_user(u: dict) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u["name"],
            "role": u["role"], "active": u.get("active", True)}


async def current_user(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer)):
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        uid = payload["sub"]
    except Exception:
        raise HTTPException(401, "Invalid or expired token")
    user = await db.users.find_one({"id": uid, "active": True})
    if not user:
        raise HTTPException(401, "User inactive or missing")
    return user


async def owner_only(user=Depends(current_user)):
    if user["role"] != "owner":
        raise HTTPException(403, "Owner role required")
    return user


@api_router.post("/auth/login")
async def login(body: LoginIn):
    user = await db.users.find_one({"email": body.email.lower()})
    valid = pwd_context.verify(body.password, user["password_hash"]) if user else False
    if not user or not user.get("active", True) or not valid:
        raise HTTPException(401, "Incorrect email or password")
    return {"access_token": create_token(user), "user": public_user(user)}


@api_router.get("/auth/me")
async def me(user=Depends(current_user)):
    return public_user(user)


@api_router.get("/staff")
async def list_staff(_=Depends(owner_only)):
    rows = await db.users.find({"role": "staff", "deleted_at": None}).to_list(500)
    return [public_user(r) for r in rows]


@api_router.post("/staff", status_code=201)
async def create_staff(body: StaffCreate, _=Depends(owner_only)):
    if await db.users.find_one({"email": body.email.lower()}):
        raise HTTPException(409, "Email already exists")
    doc = {"id": new_id(), "email": body.email.lower(), "name": body.name,
           "password_hash": pwd_context.hash(body.password), "role": "staff",
           "active": True, "deleted_at": None, "created_at": now_iso()}
    await db.users.insert_one(doc)
    return public_user(doc)


@api_router.patch("/staff/{staff_id}")
async def update_staff(staff_id: str, body: StaffUpdate, _=Depends(owner_only)):
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    if not changes:
        raise HTTPException(400, "No changes")
    r = await db.users.find_one_and_update({"id": staff_id, "role": "staff"},
                                           {"$set": changes}, return_document=True)
    if not r:
        raise HTTPException(404, "Staff not found")
    return public_user(r)


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------
async def _reconcile_products_inventory(products: list) -> list:
    orders = await db.orders.find({"deleted_at": None}).to_list(5000)
    stats = {}
    for o in orders:
        kind = o.get("kind", "sale")
        for it in o.get("items", []):
            pid = str(it.get("product_id") or "")
            model = (it.get("model") or "").strip().lower()
            qty = float(it.get("qty", 0))
            for key in (pid, model):
                if key:
                    if key not in stats:
                        stats[key] = {"purchased": 0.0, "sold": 0.0}
                    if kind == "purchase":
                        stats[key]["purchased"] += qty
                    elif kind == "sale":
                        stats[key]["sold"] += qty

    for p in products:
        pid = str(p.get("id") or "")
        model = (p.get("model") or "").strip().lower()
        pur = stats.get(pid, {}).get("purchased", 0.0) or stats.get(model, {}).get("purchased", 0.0)
        sld = stats.get(pid, {}).get("sold", 0.0) or stats.get(model, {}).get("sold", 0.0)
        opening = max(0.0, float(p.get("opening_stock", 0.0)))
        in_stock = opening + pur - sld
        p["purchased_qty"] = pur
        p["sold_qty"] = sld
        p["qty_on_hand"] = in_stock
    return products


@api_router.get("/products")
async def list_products(user=Depends(current_user)):
    rows = await db.products.find({"deleted_at": None}).sort("model", 1).to_list(1000)
    reconciled = await _reconcile_products_inventory([clean(r) for r in rows])
    return reconciled


@api_router.post("/products", status_code=201)
async def create_product(body: ProductIn, user=Depends(current_user)):
    doc = body.model_dump()
    doc["id"] = new_id()
    doc["sku"] = doc.get("sku") or doc["model"].upper().replace(" ", "-")[:24]
    opening = max(0.0, float(doc.get("qty_on_hand") or 0.0))
    doc["opening_stock"] = 0.0
    doc["qty_on_hand"] = opening
    doc["deleted_at"] = None
    doc["created_at"] = now_iso()
    await db.products.insert_one(doc)

    if opening > 0:
        rate = float(doc.get("cost_price", 0.0))
        amt = round(opening * rate, 2)
        po_doc = {
            "id": f"po_{new_id()[:8]}",
            "kind": "purchase",
            "party_id": None,
            "party_name": "Worldtech Distributor / Initial Lot",
            "ref_no": f"PO-INIT-{doc['sku'][:12]}",
            "date": now_iso(),
            "credit_days": 0,
            "due_date": now_iso(),
            "notes": f"Initial stock intake for {doc['model']}",
            "items": [{
                "product_id": doc["id"],
                "model": doc["model"],
                "qty": opening,
                "rate": rate,
                "cost": rate,
                "amount": amt,
            }],
            "total": amt,
            "payments": [{
                "id": new_id(),
                "amount": amt,
                "date": now_iso(),
                "note": "Stock intake settled"
            }],
            "invoice_file": None,
            "deleted_at": None,
            "created_at": now_iso()
        }
        await db.orders.insert_one(po_doc)

    return clean(doc)


@api_router.put("/products/{pid}")
async def update_product(pid: str, body: ProductIn, user=Depends(current_user)):
    changes = body.model_dump(exclude_unset=True)
    if "qty_on_hand" in changes:
        changes["opening_stock"] = max(0.0, float(changes["qty_on_hand"]))
    r = await db.products.find_one_and_update({"id": pid, "deleted_at": None},
                                              {"$set": changes}, return_document=True)
    if not r:
        raise HTTPException(404, "Product not found")
    return clean(r)


@api_router.post("/products/{pid}/adjust-stock")
async def adjust_product_stock(pid: str, body: StockAdjustIn, user=Depends(current_user)):
    prod = await db.products.find_one({"id": pid, "deleted_at": None})
    if not prod:
        raise HTTPException(404, "Product not found")
    if body.new_qty is not None:
        new_stock = max(0.0, float(body.new_qty))
    elif body.qty_delta is not None:
        new_stock = max(0.0, float(prod.get("qty_on_hand", 0)) + float(body.qty_delta))
    else:
        raise HTTPException(400, "Must provide qty_delta or new_qty")
    r = await db.products.find_one_and_update({"id": pid}, {"$set": {"qty_on_hand": new_stock, "opening_stock": new_stock}}, return_document=True)
    return clean(r)


@api_router.delete("/products/{pid}")
async def delete_product(pid: str, user=Depends(current_user)):
    await db.products.update_one({"id": pid}, {"$set": {"deleted_at": now_iso()}})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Dealers
# ---------------------------------------------------------------------------
@api_router.get("/dealers")
async def list_dealers(user=Depends(current_user)):
    rows = await db.dealers.find({"deleted_at": None}).sort("shop_name", 1).to_list(1000)
    return [clean(r) for r in rows]


@api_router.post("/dealers", status_code=201)
async def create_dealer(body: DealerIn, user=Depends(current_user)):
    doc = body.model_dump()
    doc["id"] = new_id()
    doc["deleted_at"] = None
    doc["created_at"] = now_iso()
    await db.dealers.insert_one(doc)
    return clean(doc)


@api_router.put("/dealers/{did}")
async def update_dealer(did: str, body: DealerIn, user=Depends(current_user)):
    r = await db.dealers.find_one_and_update({"id": did, "deleted_at": None},
                                             {"$set": body.model_dump()}, return_document=True)
    if not r:
        raise HTTPException(404, "Dealer not found")
    return clean(r)


@api_router.delete("/dealers/{did}")
async def delete_dealer(did: str, user=Depends(current_user)):
    await db.dealers.update_one({"id": did}, {"$set": {"deleted_at": now_iso()}})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Orders (sales + purchases share logic; kind = "sale" | "purchase")
# ---------------------------------------------------------------------------
def serialize_order(o: dict) -> dict:
    o = clean(o)
    payments = o.get("payments", [])
    paid = round(sum(p["amount"] for p in payments), 2)
    total = round(o.get("total", 0), 2)
    balance = round(total - paid, 2)
    if paid <= 0:
        pay_status = "unpaid"
    elif balance > 0.5:
        pay_status = "partial"
    else:
        pay_status = "cleared"
    o["amount_paid"] = paid
    o["balance"] = max(0, balance)
    o["pay_status"] = pay_status
    o["age_days"] = days_since(o.get("date", now_iso())) if balance > 0.5 else 0

    is_sale = o.get("kind") == "sale" or (not o.get("kind") and bool(o.get("party_id")))
    credit_days = int(o.get("credit_days", 15) or 15) if is_sale else 0
    date_str = o.get("date") or now_iso()
    due_date = o.get("due_date")
    days_left = 0
    try:
        dt = datetime.fromisoformat(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if not due_date:
            due_dt = dt + timedelta(days=credit_days)
            due_date = due_dt.isoformat()
        else:
            due_dt = datetime.fromisoformat(due_date)
            if due_dt.tzinfo is None:
                due_dt = due_dt.replace(tzinfo=timezone.utc)
        now_dt = datetime.now(timezone.utc)
        days_left = (due_dt.date() - now_dt.date()).days
    except Exception:
        pass

    o["credit_days"] = credit_days
    o["due_date"] = due_date
    o["days_left"] = days_left
    o["is_due_passed"] = days_left < 0 and balance > 0.5
    return o


async def _adjust_inventory(items: List[dict], sign: int):
    # sign +1 increases stock (purchase), -1 decreases (sale)
    for it in items:
        await db.products.update_one({"id": it["product_id"]},
                                     {"$inc": {"qty_on_hand": sign * it["qty"]}})


async def _create_order(kind: str, body: OrderIn):
    if not body.items:
        raise HTTPException(400, "Order must have at least one item")
    items = []
    total = 0.0
    for li in body.items:
        prod = await db.products.find_one({"id": li.product_id, "deleted_at": None})
        cost = float(prod.get("cost_price", 0)) if prod else 0.0
        amount = round(li.qty * li.rate, 2)
        total += amount
        items.append({"product_id": li.product_id, "model": li.model, "qty": li.qty,
                      "rate": li.rate, "cost": cost, "amount": amount})
    total = round(total, 2)
    payments = []
    p_status = (body.payment_status or "").lower().strip()
    if p_status == "cleared":
        payments.append({"id": new_id(), "amount": total, "date": body.date or now_iso(), "note": "Initial payment"})
    elif p_status == "unpaid":
        pass
    elif body.amount_paid is not None and body.amount_paid > 0:
        payments.append({"id": new_id(), "amount": round(body.amount_paid, 2),
                         "date": body.date or now_iso(), "note": "Initial payment"})
    elif body.initial_payment and body.initial_payment > 0:
        payments.append({"id": new_id(), "amount": round(body.initial_payment, 2),
                         "date": body.date or now_iso(), "note": "Initial payment"})

    is_sale = kind == "sale"
    credit_days = int(body.credit_days or 15) if is_sale else 0
    date_str = body.date or now_iso()
    try:
        dt = datetime.fromisoformat(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        due_date = (dt + timedelta(days=credit_days)).isoformat()
    except Exception:
        due_date = None

    doc = {"id": new_id(), "kind": kind, "party_id": body.party_id,
           "party_name": body.party_name, "ref_no": body.ref_no,
           "date": date_str, "credit_days": credit_days, "due_date": due_date,
           "notes": body.notes or "",
           "items": items, "total": total, "payments": payments,
           "invoice_file": body.invoice_file or None,
           "deleted_at": None, "created_at": now_iso()}
    await db.orders.insert_one(doc)
    await _adjust_inventory(items, +1 if kind == "purchase" else -1)
    return serialize_order(doc)


async def _update_order(oid: str, body: OrderIn):
    if not body.items:
        raise HTTPException(400, "Order must have at least one item")
    existing = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not existing:
        raise HTTPException(404, "Order not found")
    kind = existing["kind"]
    sign = 1 if kind == "purchase" else -1
    # reverse the inventory effect of the old items, then apply the new items
    await _adjust_inventory(existing.get("items", []), -sign)
    items = []
    total = 0.0
    for li in body.items:
        prod = await db.products.find_one({"id": li.product_id, "deleted_at": None})
        cost = float(prod.get("cost_price", 0)) if prod else 0.0
        amount = round(li.qty * li.rate, 2)
        total += amount
        items.append({"product_id": li.product_id, "model": li.model, "qty": li.qty,
                      "rate": li.rate, "cost": cost, "amount": amount})
    await _adjust_inventory(items, sign)
    changes = {"party_id": body.party_id, "party_name": body.party_name,
               "ref_no": body.ref_no, "date": body.date or existing.get("date"),
               "notes": body.notes or "", "items": items, "total": round(total, 2)}
    if body.invoice_file is not None:
        changes["invoice_file"] = body.invoice_file
    if body.credit_days is not None:
        c_days = max(0, body.credit_days)
        changes["credit_days"] = c_days
        effective_date = body.date or existing.get("date") or now_iso()
        try:
            dt = datetime.fromisoformat(effective_date)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            changes["due_date"] = (dt + timedelta(days=c_days)).isoformat()
        except Exception:
            pass

    if body.payment_status is not None or body.amount_paid is not None:
        p_status = (body.payment_status or "").lower().strip()
        if p_status == "cleared":
            changes["payments"] = [{"id": new_id(), "amount": round(total, 2), "date": body.date or now_iso(), "note": "Full payment"}]
        elif p_status == "unpaid":
            changes["payments"] = []
        elif p_status == "partial" or body.amount_paid is not None:
            amt = round(body.amount_paid or 0, 2)
            changes["payments"] = [{"id": new_id(), "amount": amt, "date": body.date or now_iso(), "note": "Updated payment"}] if amt > 0 else []
    await db.orders.update_one({"id": oid}, {"$set": changes})
    o = await db.orders.find_one({"id": oid})
    return serialize_order(o)


async def _list_orders(kind: str):
    rows = await db.orders.find({"kind": kind, "deleted_at": None}).sort("date", -1).to_list(2000)
    return [serialize_order(r) for r in rows]


# --- Sales ---
@api_router.get("/sales")
async def list_sales(user=Depends(current_user)):
    return await _list_orders("sale")


@api_router.post("/sales", status_code=201)
async def create_sale(body: OrderIn, user=Depends(current_user)):
    return await _create_order("sale", body)


@api_router.get("/sales/{oid}")
async def get_sale(oid: str, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "kind": "sale", "deleted_at": None})
    if not o:
        raise HTTPException(404, "Sale order not found")
    return serialize_order(o)


# --- Purchases ---
@api_router.get("/purchases")
async def list_purchases(user=Depends(current_user)):
    return await _list_orders("purchase")


@api_router.post("/purchases", status_code=201)
async def create_purchase(body: OrderIn, user=Depends(current_user)):
    return await _create_order("purchase", body)


@api_router.get("/purchases/{oid}")
async def get_purchase(oid: str, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "kind": "purchase", "deleted_at": None})
    if not o:
        raise HTTPException(404, "Purchase order not found")
    return serialize_order(o)


# --- Payments (shared) ---
@api_router.post("/orders/{oid}/payments", status_code=201)
async def add_payment(oid: str, body: PaymentIn, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    pay = {"id": new_id(), "amount": round(body.amount, 2),
           "date": body.date or now_iso(), "note": body.note or ""}
    await db.orders.update_one({"id": oid}, {"$push": {"payments": pay}})
    o = await db.orders.find_one({"id": oid})
    return serialize_order(o)


@api_router.patch("/orders/{oid}/payment-status")
@api_router.patch("/purchases/{oid}/payment-status")
@api_router.patch("/sales/{oid}/payment-status")
async def update_payment_status(oid: str, body: PaymentStatusUpdate, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    status = body.status.lower().strip()
    total = round(o.get("total", 0), 2)
    payments = o.get("payments", [])
    current_paid = round(sum(p.get("amount", 0) for p in payments), 2)

    if status == "cleared":
        remaining = round(total - current_paid, 2)
        if remaining > 0:
            payments.append({"id": new_id(), "amount": remaining, "date": now_iso(), "note": body.note or "Payment cleared"})
        elif remaining < 0 or not payments:
            payments = [{"id": new_id(), "amount": total, "date": now_iso(), "note": body.note or "Payment cleared"}]
    elif status == "unpaid":
        payments = []
    elif status == "partial":
        amt = round(body.amount_paid if body.amount_paid is not None else current_paid, 2)
        if amt <= 0:
            payments = []
        else:
            payments = [{"id": new_id(), "amount": amt, "date": now_iso(), "note": body.note or "Partial payment"}]
    else:
        raise HTTPException(400, f"Invalid status '{body.status}'. Must be 'cleared', 'unpaid', or 'partial'.")

    await db.orders.update_one({"id": oid}, {"$set": {"payments": payments}})
    o = await db.orders.find_one({"id": oid})
    return serialize_order(o)


@api_router.put("/orders/{oid}/payments/{pid}")
async def edit_payment(oid: str, pid: str, body: PaymentUpdate, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    payments = o.get("payments", [])
    found = False
    for p in payments:
        if p.get("id") == pid:
            p["amount"] = round(body.amount, 2)
            if body.note is not None:
                p["note"] = body.note
            if body.date:
                p["date"] = body.date
            found = True
            break
    if not found:
        raise HTTPException(404, "Payment record not found")
    await db.orders.update_one({"id": oid}, {"$set": {"payments": payments}})
    o = await db.orders.find_one({"id": oid})
    return serialize_order(o)


@api_router.delete("/orders/{oid}/payments/{pid}")
async def delete_payment(oid: str, pid: str, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    payments = [p for p in o.get("payments", []) if p.get("id") != pid]
    await db.orders.update_one({"id": oid}, {"$set": {"payments": payments}})
    o = await db.orders.find_one({"id": oid})
    return serialize_order(o)



@api_router.patch("/orders/{oid}")
async def edit_order(oid: str, body: OrderEdit, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not changes:
        raise HTTPException(400, "No changes")
    if "credit_days" in changes:
        days = max(0, int(changes["credit_days"]))
        effective_date = changes.get("date") or o.get("date") or now_iso()
        try:
            dt = datetime.fromisoformat(effective_date)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            changes["due_date"] = (dt + timedelta(days=days)).isoformat()
        except Exception:
            pass
    await db.orders.update_one({"id": oid}, {"$set": changes})
    o = await db.orders.find_one({"id": oid})
    return serialize_order(o)


@api_router.patch("/orders/{oid}/credit-days")
async def update_order_credit_days(oid: str, body: CreditDaysIn, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    days = max(0, body.credit_days)
    date_str = o.get("date") or now_iso()
    try:
        dt = datetime.fromisoformat(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        due_date = (dt + timedelta(days=days)).isoformat()
    except Exception:
        due_date = None
    await db.orders.update_one({"id": oid}, {"$set": {"credit_days": days, "due_date": due_date}})
    updated_o = await db.orders.find_one({"id": oid})
    return serialize_order(updated_o)


@api_router.post("/orders/{oid}/invoice")
@api_router.patch("/orders/{oid}/invoice")
@api_router.post("/sales/{oid}/invoice")
@api_router.patch("/sales/{oid}/invoice")
@api_router.post("/purchases/{oid}/invoice")
@api_router.patch("/purchases/{oid}/invoice")
async def upload_order_invoice(oid: str, body: dict = Body(...), user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    inv = body.get("invoice_file") if isinstance(body, dict) and "invoice_file" in body else body
    await db.orders.update_one({"id": oid}, {"$set": {"invoice_file": inv, "updated_at": now_iso()}})
    updated_o = await db.orders.find_one({"id": oid})
    return serialize_order(updated_o)


@api_router.delete("/orders/{oid}/invoice")
@api_router.delete("/sales/{oid}/invoice")
@api_router.delete("/purchases/{oid}/invoice")
async def delete_order_invoice(oid: str, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    await db.orders.update_one({"id": oid}, {"$set": {"invoice_file": None, "updated_at": now_iso()}})
    updated_o = await db.orders.find_one({"id": oid})
    return serialize_order(updated_o)


@api_router.get("/orders/{oid}/invoice")
@api_router.get("/sales/{oid}/invoice")
@api_router.get("/purchases/{oid}/invoice")
async def get_order_invoice(oid: str, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    return o.get("invoice_file")



@api_router.get("/orders/{oid}")
async def get_order(oid: str, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    return serialize_order(o)


@api_router.put("/orders/{oid}")
async def update_order(oid: str, body: OrderIn, user=Depends(current_user)):
    return await _update_order(oid, body)


@api_router.put("/sales/{oid}")
async def update_sale_order(oid: str, body: OrderIn, user=Depends(current_user)):
    return await _update_order(oid, body)


@api_router.put("/purchases/{oid}")
async def update_purchase_order(oid: str, body: OrderIn, user=Depends(current_user)):
    return await _update_order(oid, body)


@api_router.delete("/orders/{oid}")
async def delete_order(oid: str, user=Depends(current_user)):
    o = await db.orders.find_one({"id": oid, "deleted_at": None})
    if not o:
        raise HTTPException(404, "Order not found")
    await _adjust_inventory(o["items"], -1 if o["kind"] == "purchase" else +1)
    await db.orders.update_one({"id": oid}, {"$set": {"deleted_at": now_iso()}})
    return {"ok": True}


@api_router.delete("/sales/{oid}")
async def delete_sale_order(oid: str, user=Depends(current_user)):
    return await delete_order(oid, user)


@api_router.delete("/purchases/{oid}")
async def delete_purchase_order(oid: str, user=Depends(current_user)):
    return await delete_order(oid, user)


# ---------------------------------------------------------------------------
# Expenses
# ---------------------------------------------------------------------------
@api_router.get("/expenses")
async def list_expenses(user=Depends(current_user)):
    rows = await db.expenses.find({"deleted_at": None}).sort("date", -1).to_list(2000)
    return [clean(r) for r in rows]


@api_router.post("/expenses", status_code=201)
async def create_expense(body: ExpenseIn, user=Depends(current_user)):
    doc = body.model_dump()
    doc["id"] = new_id()
    doc["date"] = doc.get("date") or now_iso()
    doc["deleted_at"] = None
    doc["created_at"] = now_iso()
    await db.expenses.insert_one(doc)
    return clean(doc)


@api_router.put("/expenses/{eid}")
async def update_expense(eid: str, body: ExpenseIn, user=Depends(current_user)):
    changes = body.model_dump()
    changes["date"] = changes.get("date") or now_iso()
    r = await db.expenses.find_one_and_update({"id": eid, "deleted_at": None},
                                              {"$set": changes}, return_document=True)
    if not r:
        raise HTTPException(404, "Expense not found")
    return clean(r)


@api_router.delete("/expenses/{eid}")
async def delete_expense(eid: str, user=Depends(current_user)):
    await db.expenses.update_one({"id": eid}, {"$set": {"deleted_at": now_iso()}})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Dashboard + Reports
# ---------------------------------------------------------------------------
async def _compute_summary():
    sales = await db.orders.find({"kind": "sale", "deleted_at": None}).to_list(5000)
    purchases = await db.orders.find({"kind": "purchase", "deleted_at": None}).to_list(5000)
    expenses = await db.expenses.find({"deleted_at": None}).to_list(5000)
    products_raw = await db.products.find({"deleted_at": None}).to_list(2000)
    products = await _reconcile_products_inventory([clean(p) for p in products_raw])

    total_sales = round(sum(o.get("total", 0) for o in sales), 2)
    total_purchases = round(sum(o.get("total", 0) for o in purchases), 2)
    total_expenses = round(sum(e.get("amount", 0) for e in expenses), 2)
    cogs = round(sum(li.get("cost", 0) * li.get("qty", 0) for o in sales for li in o.get("items", [])), 2)

    receivable = round(sum(max(0, o.get("total", 0) - sum(p["amount"] for p in o.get("payments", []))) for o in sales), 2)
    payable = round(sum(max(0, o.get("total", 0) - sum(p["amount"] for p in o.get("payments", []))) for o in purchases), 2)

    inventory_value = round(sum(max(0.0, float(p.get("qty_on_hand", 0))) * float(p.get("cost_price", 0)) for p in products), 2)
    units_in_stock = int(sum(max(0.0, float(p.get("qty_on_hand", 0))) for p in products))
    net_profit = round(total_sales - cogs - total_expenses, 2)

    # Monthly aggregation
    sales_by_month = {}
    purchases_by_month = {}
    months_set = set()
    for o in sales:
        m = (o.get("date") or "")[:7]
        if m:
            sales_by_month[m] = round(sales_by_month.get(m, 0.0) + float(o.get("total", 0)), 2)
            months_set.add(m)
    for o in purchases:
        m = (o.get("date") or "")[:7]
        if m:
            purchases_by_month[m] = round(purchases_by_month.get(m, 0.0) + float(o.get("total", 0)), 2)
            months_set.add(m)

    # Chronological GST carryover calculation (Sales and purchases are GST-inclusive @ 18%):
    # Taxable base = (sales - purchase) / 1.18
    # Raw GST = (sales - purchase) * 18 / 118
    # If purchase > sales, this difference is negative -> this is GST Receivable (ITC balance on portal).
    # GST Receivable NEVER changes or increases net profit (0 subtracted).
    # Carried forward GST receivable is subtracted from next month's GST payable.
    # If next month's GST payable > carried receivable, only then does the remaining payable impact that month's net profit!
    accumulated_credit = 0.0
    monthly_gst_breakdown = []
    for m in sorted(list(months_set)):
        ms = sales_by_month.get(m, 0.0)
        mp = purchases_by_month.get(m, 0.0)
        diff = round(ms - mp, 2)
        taxable_base = round(diff / 1.18, 2)
        raw_gst = round((diff * 18) / 118, 2)
        opening_credit = accumulated_credit
        month_payable = 0.0
        credit_used = 0.0
        month_receivable = 0.0

        if raw_gst < 0:
            month_receivable = abs(raw_gst)
            accumulated_credit = round(accumulated_credit + month_receivable, 2)
            month_payable = 0.0
            credit_used = 0.0
        elif raw_gst > 0:
            if raw_gst > accumulated_credit:
                month_payable = round(raw_gst - accumulated_credit, 2)
                credit_used = accumulated_credit
                accumulated_credit = 0.0
            else:
                month_payable = 0.0
                credit_used = raw_gst
                accumulated_credit = round(accumulated_credit - raw_gst, 2)

        monthly_gst_breakdown.append({
            "month": m,
            "sales": ms,
            "purchases": mp,
            "net_diff": diff,
            "taxable_base": taxable_base,
            "gst_rate": 0.18,
            "raw_gst": raw_gst,
            "opening_credit": opening_credit,
            "credit_used": credit_used,
            "gst_receivable": month_receivable,
            "accumulated_credit": accumulated_credit,
            "gst_payable": month_payable,
        })

    total_gst_payable = round(sum(mb["gst_payable"] for mb in monthly_gst_breakdown), 2)
    active_gst_receivable = accumulated_credit
    net_profit_before_gst = net_profit
    # Net profit after GST = net_profit - total_gst_payable (receivable never increases profit)
    net_profit_after_gst = round(net_profit - total_gst_payable, 2)

    current_month_key = datetime.now(timezone.utc).strftime("%Y-%m")
    cur_m = next((item for item in monthly_gst_breakdown if item["month"] == current_month_key), None)
    if not cur_m:
        cur_m_diff = round(sales_by_month.get(current_month_key, 0.0) - purchases_by_month.get(current_month_key, 0.0), 2)
        cur_m = {
            "month": current_month_key,
            "sales": sales_by_month.get(current_month_key, 0.0),
            "purchases": purchases_by_month.get(current_month_key, 0.0),
            "net_diff": cur_m_diff,
            "taxable_base": round(cur_m_diff / 1.18, 2),
            "gst_rate": 0.18,
            "raw_gst": round((cur_m_diff * 18) / 118, 2),
            "opening_credit": accumulated_credit,
            "credit_used": 0.0,
            "gst_receivable": 0.0,
            "accumulated_credit": accumulated_credit,
            "gst_payable": 0.0,
        }

    negative_stock = [clean(p) for p in products if float(p.get("qty_on_hand", 0)) < 0]
    negative_stock.sort(key=lambda p: p.get("qty_on_hand", 0))

    low_stock = [clean(p) for p in products if 0 < float(p.get("qty_on_hand", 0)) <= 2]
    low_stock.sort(key=lambda p: p.get("qty_on_hand", 0))

    return {
        "total_sales": total_sales,
        "total_purchases": total_purchases,
        "total_expenses": total_expenses,
        "cogs": cogs,
        "gross_profit": round(total_sales - cogs, 2),
        "net_profit": net_profit,
        "net_profit_before_gst": net_profit_before_gst,
        "gst_rate": 0.18,
        "gst_taxable_base": round((total_sales - total_purchases) / 1.18, 2),
        "gst_payable": total_gst_payable,
        "gst_receivable": active_gst_receivable,
        "accumulated_credit": active_gst_receivable,
        "net_profit_after_gst": net_profit_after_gst,
        "receivable": receivable,
        "payable": payable,
        "inventory_value": inventory_value,
        "units_in_stock": units_in_stock,
        "sales_count": len(sales),
        "purchases_count": len(purchases),
        "low_stock": low_stock,
        "negative_stock": negative_stock,
        "monthly_gst_breakdown": monthly_gst_breakdown,
        "current_month_gst": cur_m,
    }


@api_router.get("/dashboard")
async def dashboard(user=Depends(current_user)):
    summary = await _compute_summary()
    recent = await db.orders.find({"kind": "sale", "deleted_at": None}).sort("date", -1).limit(5).to_list(5)
    summary["recent_sales"] = [serialize_order(r) for r in recent]
    return summary


@api_router.get("/reports")
async def reports(user=Depends(current_user)):
    summary = await _compute_summary()
    sales = await db.orders.find({"kind": "sale", "deleted_at": None}).to_list(5000)
    purchases = await db.orders.find({"kind": "purchase", "deleted_at": None}).to_list(5000)
    expenses = await db.expenses.find({"deleted_at": None}).to_list(5000)

    # Helper for month key
    def get_month_key(date_str):
        try:
            if not date_str:
                return datetime.now(timezone.utc).strftime("%Y-%m")
            dt = datetime.fromisoformat(date_str)
            return dt.strftime("%Y-%m")
        except Exception:
            return datetime.now(timezone.utc).strftime("%Y-%m")

    sales_by_month = {}
    purchases_by_month = {}
    sales_units_by_month = {}
    model_monthly_map = {}
    monthly_metrics = {}

    for o in sales:
        m = get_month_key(o.get("date"))
        sales_by_month[m] = round(sales_by_month.get(m, 0.0) + o.get("total", 0.0), 2)
        if m not in monthly_metrics:
            monthly_metrics[m] = {"month": m, "sales": 0.0, "purchases": 0.0, "cogs": 0.0, "gross_profit": 0.0, "units": 0}
        monthly_metrics[m]["sales"] = round(monthly_metrics[m]["sales"] + o.get("total", 0.0), 2)

        for it in o.get("items", []):
            qty = it.get("qty", 0)
            rate = it.get("rate", 0.0)
            amt = it.get("amount", qty * rate)
            cost = it.get("cost", rate * 0.9) * qty

            sales_units_by_month[m] = sales_units_by_month.get(m, 0) + qty
            monthly_metrics[m]["units"] += qty
            monthly_metrics[m]["cogs"] = round(monthly_metrics[m]["cogs"] + cost, 2)

            model = it.get("model", "Unknown")
            if model not in model_monthly_map:
                model_monthly_map[model] = {}
            if m not in model_monthly_map[model]:
                model_monthly_map[model][m] = {"qty": 0, "amount": 0.0}
            model_monthly_map[model][m]["qty"] += qty
            model_monthly_map[model][m]["amount"] = round(model_monthly_map[model][m]["amount"] + amt, 2)

    for o in purchases:
        m = get_month_key(o.get("date"))
        purchases_by_month[m] = round(purchases_by_month.get(m, 0.0) + o.get("total", 0.0), 2)
        if m not in monthly_metrics:
            monthly_metrics[m] = {"month": m, "sales": 0.0, "purchases": 0.0, "cogs": 0.0, "gross_profit": 0.0, "units": 0}
        monthly_metrics[m]["purchases"] = round(monthly_metrics[m]["purchases"] + o.get("total", 0.0), 2)

    for m in monthly_metrics:
        monthly_metrics[m]["gross_profit"] = round(monthly_metrics[m]["sales"] - monthly_metrics[m]["cogs"], 2)
        top_m = ""
        top_qty = 0
        for model, m_data in model_monthly_map.items():
            if m in m_data and m_data[m]["qty"] > top_qty:
                top_qty = m_data[m]["qty"]
                top_m = model
        monthly_metrics[m]["top_model"] = top_m or "None"

    expenses_by_month = {}
    for e in expenses:
        em = get_month_key(e.get("date"))
        expenses_by_month[em] = round(expenses_by_month.get(em, 0.0) + e.get("amount", 0.0), 2)

    month_keys = sorted(list(set(list(sales_by_month.keys()) + list(purchases_by_month.keys()))))
    if not month_keys:
        month_keys = [datetime.now(timezone.utc).strftime("%Y-%m")]

    model_series = []
    for model, m_data in model_monthly_map.items():
        total_units = sum(v["qty"] for v in m_data.values())
        total_revenue = round(sum(v["amount"] for v in m_data.values()), 2)
        model_series.append({
            "model": model,
            "monthly_data": m_data,
            "total_units": total_units,
            "total_revenue": total_revenue,
        })
    model_series.sort(key=lambda x: x["total_units"], reverse=True)

    gst_by_month = {item["month"]: item for item in summary.get("monthly_gst_breakdown", [])}
    monthly_breakdown = []
    for m in month_keys:
        ms = sales_by_month.get(m, 0.0)
        mp = purchases_by_month.get(m, 0.0)
        mu = sales_units_by_month.get(m, 0)
        mcogs = monthly_metrics.get(m, {}).get("cogs", 0.0)
        mgross = monthly_metrics.get(m, {}).get("gross_profit", 0.0)
        mexp = expenses_by_month.get(m, 0.0)
        mnet_pre = round(mgross - mexp, 2)
        gst_item = gst_by_month.get(m, {})
        mgst_pay = gst_item.get("gst_payable", 0.0)
        mnet_post = round(mnet_pre - mgst_pay, 2)
        masp = round(ms / mu, 2) if mu > 0 else 0.0
        mtop = monthly_metrics.get(m, {}).get("top_model", "None")
        monthly_breakdown.append({
            "month": m,
            "sales": ms,
            "purchases": mp,
            "units": mu,
            "cogs": mcogs,
            "gross_profit": mgross,
            "expenses": mexp,
            "net_profit": mnet_pre,
            "net_profit_before_gst": mnet_pre,
            "gst_payable": mgst_pay,
            "net_profit_after_gst": mnet_post,
            "avg_selling_price": masp,
            "top_model": mtop,
            "accumulated_credit": gst_item.get("accumulated_credit", 0.0),
        })

    mom_comparison = None
    if len(monthly_breakdown) >= 2:
        curr = monthly_breakdown[-1]
        prev = monthly_breakdown[-2]
        s_growth = round(((curr["sales"] - prev["sales"]) / prev["sales"] * 100), 1) if prev["sales"] > 0 else (100.0 if curr["sales"] > 0 else 0.0)
        u_growth = round(((curr["units"] - prev["units"]) / prev["units"] * 100), 1) if prev["units"] > 0 else (100.0 if curr["units"] > 0 else 0.0)
        p_growth = round(((curr["gross_profit"] - prev["gross_profit"]) / abs(prev["gross_profit"]) * 100), 1) if prev["gross_profit"] != 0 else (100.0 if curr["gross_profit"] > 0 else 0.0)
        np_growth = round(((curr["net_profit_after_gst"] - prev["net_profit_after_gst"]) / abs(prev["net_profit_after_gst"]) * 100), 1) if prev["net_profit_after_gst"] != 0 else (100.0 if curr["net_profit_after_gst"] > 0 else 0.0)
        curr_asp = curr["avg_selling_price"]
        prev_asp = prev["avg_selling_price"]
        asp_growth = round(((curr_asp - prev_asp) / prev_asp * 100), 1) if prev_asp > 0 else 0.0
        mom_comparison = {
            "current_month": curr["month"],
            "previous_month": prev["month"],
            "current_sales": curr["sales"],
            "previous_sales": prev["sales"],
            "sales_growth_pct": s_growth,
            "current_units": curr["units"],
            "previous_units": prev["units"],
            "units_growth_pct": u_growth,
            "current_profit": curr["gross_profit"],
            "previous_profit": prev["gross_profit"],
            "profit_growth_pct": p_growth,
            "current_net_profit": curr["net_profit_after_gst"],
            "previous_net_profit": prev["net_profit_after_gst"],
            "net_profit_growth_pct": np_growth,
            "current_asp": curr_asp,
            "previous_asp": prev_asp,
            "asp_growth_pct": asp_growth,
        }

    # Top wholesale dealers leaderboard
    dealer_map = {}
    for o in sales:
        p_name = o.get("party_name") or "Unknown Dealer"
        p_id = o.get("party_id") or p_name
        if p_id not in dealer_map:
            dealer_map[p_id] = {
                "party_name": p_name,
                "party_id": o.get("party_id"),
                "orders_count": 0,
                "total_revenue": 0.0,
                "total_units": 0,
                "amount_paid": 0.0,
                "balance": 0.0,
            }
        dealer_map[p_id]["orders_count"] += 1
        dealer_map[p_id]["total_revenue"] = round(dealer_map[p_id]["total_revenue"] + o.get("total", 0.0), 2)
        paid = sum(p.get("amount", 0.0) for p in o.get("payments", []))
        dealer_map[p_id]["amount_paid"] = round(dealer_map[p_id]["amount_paid"] + paid, 2)
        bal = max(0.0, o.get("total", 0.0) - paid)
        dealer_map[p_id]["balance"] = round(dealer_map[p_id]["balance"] + bal, 2)
        for it in o.get("items", []):
            dealer_map[p_id]["total_units"] += it.get("qty", 0)
    top_dealers = sorted(list(dealer_map.values()), key=lambda x: x["total_revenue"], reverse=True)

    # Screen size & category distribution
    import re
    cat_map = {}
    tot_sales_units = 0
    tot_sales_rev = 0.0
    for o in sales:
        for it in o.get("items", []):
            model = it.get("model", "")
            if re.search(r'\b32\b', model, re.I):
                cat = '32" HD/Smart'
            elif re.search(r'\b43\b', model, re.I):
                cat = '43" FHD/4K Smart'
            elif re.search(r'\b50\b', model, re.I):
                cat = '50" 4K Smart'
            elif re.search(r'\b55\b', model, re.I):
                cat = '55" 4K UHD'
            elif re.search(r'\b58\b', model, re.I):
                cat = '58" 4K QLED'
            elif re.search(r'\b65\b', model, re.I):
                cat = '65" 4K QLED/WebOS'
            elif re.search(r'\b75\b', model, re.I):
                cat = '75" Ultra Premium'
            else:
                cat = "Other TV"

            qty = it.get("qty", 0)
            amt = it.get("amount", qty * it.get("rate", 0.0))
            tot_sales_units += qty
            tot_sales_rev += amt

            if cat not in cat_map:
                cat_map[cat] = {"category": cat, "units": 0, "revenue": 0.0, "share_pct": 0.0}
            cat_map[cat]["units"] += qty
            cat_map[cat]["revenue"] = round(cat_map[cat]["revenue"] + amt, 2)

    category_breakdown = []
    for c in cat_map.values():
        c["share_pct"] = round((c["revenue"] / tot_sales_rev * 100), 1) if tot_sales_rev > 0 else 0.0
        category_breakdown.append(c)
    category_breakdown.sort(key=lambda x: x["revenue"], reverse=True)

    # Executive KPIs
    tot_paid = sum(sum(p.get("amount", 0.0) for p in o.get("payments", [])) for o in sales)
    sorted_by_rev = sorted(model_series, key=lambda x: x["total_revenue"], reverse=True)
    executive_kpis = {
        "top_model_by_volume": {"model": model_series[0]["model"], "units": model_series[0]["total_units"]} if model_series else None,
        "top_model_by_revenue": {"model": sorted_by_rev[0]["model"], "revenue": sorted_by_rev[0]["total_revenue"]} if sorted_by_rev else None,
        "avg_order_value": round(tot_sales_rev / len(sales), 2) if sales else 0.0,
        "avg_selling_price_per_tv": round(tot_sales_rev / tot_sales_units, 2) if tot_sales_units > 0 else 0.0,
        "collection_rate": round((tot_paid / tot_sales_rev * 100), 1) if tot_sales_rev > 0 else 0.0,
        "total_sales_units": tot_sales_units,
        "total_collected": round(tot_paid, 2),
        "net_profit_before_gst": summary.get("net_profit_before_gst", summary.get("net_profit", 0.0)),
        "net_profit_after_gst": summary.get("net_profit_after_gst", 0.0),
    }

    # expense by category
    exp_cat = {}
    for e in expenses:
        exp_cat[e["category"]] = round(exp_cat.get(e["category"], 0.0) + e["amount"], 2)

    # overdue receivables/payables
    def overdue(rows):
        out = []
        for o in rows:
            so = serialize_order(dict(o))
            if so["balance"] > 0.5:
                out.append({
                    "id": so["id"],
                    "party_name": so.get("party_name"),
                    "ref_no": so.get("ref_no"),
                    "balance": round(so["balance"], 2),
                    "credit_days": so.get("credit_days", 15),
                    "due_date": so.get("due_date"),
                    "days_left": so.get("days_left", 0),
                    "is_due_passed": so.get("is_due_passed", False),
                    "age_days": so.get("age_days", 0),
                })
        out.sort(key=lambda x: x["age_days"], reverse=True)
        return out

    return {
        "summary": summary,
        "sales_by_month": sales_by_month,
        "purchases_by_month": purchases_by_month,
        "sales_units_by_month": sales_units_by_month,
        "month_keys": month_keys,
        "model_series": model_series,
        "monthly_breakdown": monthly_breakdown,
        "mom_comparison": mom_comparison,
        "top_dealers": top_dealers,
        "category_breakdown": category_breakdown,
        "executive_kpis": executive_kpis,
        "expense_by_category": exp_cat,
        "overdue_receivables": overdue(sales),
        "overdue_payables": overdue(purchases),
    }


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------
SEED_PRODUCTS = [
    ("32 Worldtech SM", 9200), ("24 Worldtech", 4800), ("32 Worldtech BT", 10100),
    ("32 Worldtech Glsm BT", 11200), ("43 Worldtech SM", 14600), ("43 Worldtech BT", 15800),
    ("43 Worldtech Glass BT", 16700), ("43 Worldtech Webos 4K", 19000),
    ("50 Worldtech Qled Webos", 25300), ("58 Worldtech 4K QLED Webos", 31500),
    ("65 Worldtech Qled 4K Webos", 42500), ("43 Worldtech 2K Webos", 17000),
]
SEED_PO_QTY = {
    "32 Worldtech SM": 12, "24 Worldtech": 5, "32 Worldtech BT": 12,
    "32 Worldtech Glsm BT": 12, "43 Worldtech SM": 10, "43 Worldtech BT": 10,
    "43 Worldtech Glass BT": 10, "43 Worldtech Webos 4K": 4,
    "50 Worldtech Qled Webos": 4, "58 Worldtech 4K QLED Webos": 2,
    "65 Worldtech Qled 4K Webos": 2, "43 Worldtech 2K Webos": 4,
}
SEED_DEALERS = [
    ("Shree Samartha Electronics", "Nitin Mane", "9653190285", "Tagore Nagar, Vikhroli (E), Mumbai - 400083"),
    ("Hreenkar Electronics", "Sales", "9321934104", "Gokhale Rd (S), Prabhadevi, Mumbai - 25"),
    ("Keni Electronics", "Rohit / Chinmay", "9870456654", "Opp. Sahakar Cinema, Tilak Nagar, Chembur, Mumbai - 89"),
    ("Maruti Electronics", "R.C. Purohit", "9022237138", "Dharavi Main Road, Mumbai - 17"),
    ("Darsh Electronics", "Owner", "9820958939", "Sardar Nagar No. 2, Sion (E), Mumbai - 400022"),
    ("Sagar Electronics", "Babubhai Jain", "8291255388", "Sane Guruji Road, Mumbai - 400011"),
    ("Seagull Electronics", "V. Thangamani", "7498127917", "Shop NO A/41, Motial Nehru Nagar, Sion Koliwada Antop Hill, Mumbai - 400037", "27AGTPD8605K1ZX"),
    ("Samsung Smart Plaza (Samyak Sales)", "Sales", "08080032950", "Lalbaug, Mumbai - 400012"),
    ("Sona Electronics", "Suresh J. Surana", "7208560043", "Lower Parel (E), Mumbai - 400013"),
    ("Rishabh Appliances", "Hardik Jain", "8879252866", "Antop Hill, Mumbai - 400037"),
    ("Relation Electronics", "Boss", "9821357913", "M. G. Road, Ghatkopar (W), Mumbai - 86"),
    ("Jai Bhavani Mobile NX", "Owner", "9152568204", "Mulund Check Naka, Thane (W) - 400604"),
    ("Maharashtra Radio Electronics", "Ramakant Sharma", "9892144704", "L. J. Road, Mahim (W), Mumbai - 400016"),
    ("Torero Electroshoppee", "Naresh Jain", "9323004243", "Mumbai"),
    ("Veer LED TV Screen Guard", "Subhash Sonawane", "9224686091", "LBS Marg, Kurla (W), Mumbai - 400070"),
    ("Millennium Collection", "Owner", "9158021000", "Sewri Naka, Sewri, Mumbai - 15"),
]


async def seed():
    # Owner user
    if not await db.users.find_one({"email": "owner@soneja.com"}):
        await db.users.insert_one({
            "id": new_id(), "email": "owner@soneja.com", "name": "Soneja Owner",
            "password_hash": pwd_context.hash("Soneja@123"), "role": "owner",
            "active": True, "deleted_at": None, "created_at": now_iso()})
        logger.info("Seeded owner user")

    # Products
    prod_map = {}
    if await db.products.count_documents({"deleted_at": None}) == 0:
        for model, cost in SEED_PRODUCTS:
            pid = new_id()
            await db.products.insert_one({
                "id": pid, "model": model, "sku": model.upper().replace(" ", "-")[:24],
                "category": "Television", "cost_price": cost,
                "sell_price": round(cost * 1.1 / 100) * 100, "qty_on_hand": 0,
                "image": "", "deleted_at": None, "created_at": now_iso()})
            prod_map[model] = pid
        logger.info("Seeded products")
    else:
        for p in await db.products.find({"deleted_at": None}).to_list(1000):
            prod_map[p["model"]] = p["id"]

    # Dealers
    if await db.dealers.count_documents({"deleted_at": None}) == 0:
        for item in SEED_DEALERS:
            shop, person, phone, area = item[0], item[1], item[2], item[3]
            gstin = item[4] if len(item) > 4 else ""
            await db.dealers.insert_one({
                "id": new_id(), "shop_name": shop, "contact_person": person,
                "phone": phone, "whatsapp": phone, "area": area, "address": area, "gstin": gstin, "notes": "",
                "deleted_at": None, "created_at": now_iso()})
        logger.info("Seeded dealers")

    # First purchase order (sets inventory)
    if await db.orders.count_documents({"kind": "purchase", "deleted_at": None}) == 0:
        items = []
        total = 0.0
        cost_by_model = dict(SEED_PRODUCTS)
        for model, qty in SEED_PO_QTY.items():
            rate = cost_by_model[model]
            amount = qty * rate
            total += amount
            pid = prod_map.get(model)
            items.append({"product_id": pid, "model": model, "qty": qty,
                          "rate": rate, "cost": rate, "amount": amount})
            if pid:
                await db.products.update_one({"id": pid}, {"$inc": {"qty_on_hand": qty}})
        await db.orders.insert_one({
            "id": new_id(), "kind": "purchase", "party_id": None,
            "party_name": "Worldtech Distributor", "ref_no": "PO-27.08.26",
            "date": "2026-08-27T00:00:00+00:00", "notes": "Opening purchase order",
            "items": items, "total": round(total, 2), "payments": [],
            "deleted_at": None, "created_at": now_iso()})
        logger.info("Seeded opening purchase order")


@app.on_event("startup")
async def on_startup():
    await db.users.create_index("email", unique=True)
    await seed()


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
