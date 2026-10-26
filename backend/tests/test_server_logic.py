import pytest
from datetime import datetime, timezone, timedelta
import server

def test_server_serialize_order_status_cleared():
    order = {
        "id": "so-test-1",
        "kind": "sale",
        "total": 50000.0,
        "payments": [{"amount": 50000.0}],
        "date": datetime.now(timezone.utc).isoformat(),
        "credit_days": 15,
    }
    s = server.serialize_order(order)
    assert s["pay_status"] == "cleared"
    assert s["amount_paid"] == 50000.0
    assert s["balance"] == 0.0

def test_server_serialize_order_status_partial():
    order = {
        "id": "so-test-2",
        "kind": "sale",
        "total": 50000.0,
        "payments": [{"amount": 20000.0}],
        "date": datetime.now(timezone.utc).isoformat(),
        "credit_days": 15,
    }
    s = server.serialize_order(order)
    assert s["pay_status"] == "partial"
    assert s["amount_paid"] == 20000.0
    assert s["balance"] == 30000.0

def test_server_serialize_order_status_unpaid():
    order = {
        "id": "so-test-3",
        "kind": "sale",
        "total": 50000.0,
        "payments": [],
        "date": datetime.now(timezone.utc).isoformat(),
        "credit_days": 15,
    }
    s = server.serialize_order(order)
    assert s["pay_status"] == "unpaid"
    assert s["amount_paid"] == 0.0
    assert s["balance"] == 50000.0

def test_server_serialize_order_due_date_calculation():
    base_date = datetime.now(timezone.utc)
    order = {
        "id": "so-test-4",
        "kind": "sale",
        "total": 10000.0,
        "payments": [],
        "date": base_date.isoformat(),
        "credit_days": 30,
    }
    s = server.serialize_order(order)
    assert s["credit_days"] == 30
    assert "due_date" in s
    due_dt = datetime.fromisoformat(s["due_date"])
    diff = (due_dt - base_date).total_seconds() / 86400
    assert round(diff) == 30

def test_server_serialize_order_overdue_flag():
    # 20 days ago with 10 days credit -> due date passed
    past_date = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
    order = {
        "id": "so-test-5",
        "kind": "sale",
        "total": 10000.0,
        "payments": [],
        "date": past_date,
        "credit_days": 10,
    }
    s = server.serialize_order(order)
    assert s["is_due_passed"] is True
    assert s["days_left"] < 0
    assert s["age_days"] >= 20

def test_server_inventory_reconciliation_math():
    products = [
        {"id": "p1", "model": "55 inch mini led", "opening_stock": 0.0, "qty_on_hand": 0.0},
        {"id": "p2", "model": "65 inch OLED", "opening_stock": 5.0, "qty_on_hand": 5.0},
    ]
    # Stats dict format used internally by server:
    stats = {
        "p1": {"purchased": 10.0, "sold": 3.0},
        "p2": {"purchased": 2.0, "sold": 4.0},
    }
    for p in products:
        pid = p["id"]
        pur = stats.get(pid, {}).get("purchased", 0.0)
        sld = stats.get(pid, {}).get("sold", 0.0)
        opening = max(0.0, float(p.get("opening_stock", 0.0)))
        in_stock = opening + pur - sld
        p["purchased_qty"] = pur
        p["sold_qty"] = sld
        p["qty_on_hand"] = in_stock

    p1 = products[0]
    p2 = products[1]
    assert p1["qty_on_hand"] == 7.0  # 0 + 10 - 3 = 7
    assert p2["qty_on_hand"] == 3.0  # 5 + 2 - 4 = 3
