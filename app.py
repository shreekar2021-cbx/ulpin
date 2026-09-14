from __future__ import annotations

import secrets
import os
import sqlite3
import hashlib
import time
import html
import getpass
import sys
from contextlib import contextmanager, closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import uvicorn

from data import (
    AUDIT_LOG,
    CONFLICT_CASES,
    PARCELS,
    AREAS,
    PACKAGES,
    clean_token,
    build_overlap_conflict,
    find_floor,
    find_parcel,
    utc_now_iso,
)
from intelligence import combined_statistics, parcel_intelligence, package_details, compare_targets, resolve_parcels, find_package


app = FastAPI(
    title="3D ULPIN Generation & Vertical Property Mapping System",
    description="Smart India Hackathon demo for 3D vertical property mapping.",
    version="1.0.0",
)

BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_PATH = BASE_DIR / "templates" / "index.html"

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

APP_STARTED_AT = datetime.now(timezone.utc)

AGRI_SOIL_MIN = 70
AGRI_SUITABILITY_MIN = 70
AGRI_RISK_MAX = 65
_pending_units_cache: Optional[int] = None

AUTH_DB = os.environ.get("ULPIN_AUTH_DB", str(BASE_DIR / "ulpin-auth.sqlite3"))
COOKIE = "ulpin_session"
SESSION_SECONDS = 12 * 60 * 60


@contextmanager
def auth_db():
    with closing(sqlite3.connect(AUTH_DB, timeout=10)) as db, db:
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('ADMIN','USER')))")
        db.execute("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, csrf TEXT NOT NULL, expires REAL NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS attempts (address TEXT NOT NULL, timestamp REAL NOT NULL)")
        yield db


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return salt + ":" + digest


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: str = Field(min_length=1, max_length=128)
    role: str = Field(default="", max_length=16)

    model_config = {"extra": "forbid"}


class AccountRequest(Credentials):
    role: Literal["ADMIN", "USER"] = "USER"


def create_account(payload):
    try:
        with auth_db() as db:
            db.execute("INSERT INTO users VALUES (?,?,?)", (payload.username.lower(), password_hash(payload.password), payload.role))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Username already exists")


@app.middleware("http")
async def authenticate(request: Request, call_next):
    path = request.url.path
    request.state.account = None
    request.state.csrf = ""
    token = request.cookies.get(COOKIE, "")
    if token and not path.startswith("/static/"):
        with auth_db() as db:
            row = db.execute("SELECT users.username, users.role, sessions.csrf FROM sessions JOIN users USING(username) WHERE token=? AND expires>?", (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        if row:
            request.state.account = dict(row)
            request.state.csrf = row["csrf"]
    public = path in ("/login", "/api/auth/login") or path.startswith("/static/")
    if not public:
        if not request.state.account:
            return JSONResponse({"detail": "Authentication required"}, 401) if path.startswith("/api/") else RedirectResponse("/login", 303)
        admin = path == "/admin" or path.startswith(("/admin/", "/api/admin", "/api/verify", "/api/audit")) or path in ("/docs", "/redoc", "/openapi.json")
        if admin and request.state.account["role"] != "ADMIN":
            return JSONResponse({"detail": "Administrator access required"}, 403)
        if request.method not in ("GET", "HEAD", "OPTIONS") and not secrets.compare_digest(request.headers.get("X-CSRF-Token", ""), request.state.csrf):
            return JSONResponse({"detail": "Invalid CSRF token"}, 403)
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and origin != str(request.base_url).rstrip("/"):
            return JSONResponse({"detail": "Invalid request origin"}, 403)
    response = await call_next(request)
    if not path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
    return response


@app.post("/api/auth/login")
def login(payload: Credentials, request: Request):
    now = time.time()
    address = request.client.host if request.client else "unknown"
    with auth_db() as db:
        db.execute("DELETE FROM attempts WHERE timestamp<?", (now - 900,))
        if db.execute("SELECT COUNT(*) FROM attempts WHERE address=?", (address,)).fetchone()[0] >= 30:
            raise HTTPException(429, "Too many login attempts. Try again later.")
        db.execute("INSERT INTO attempts VALUES (?,?)", (address, now))
        row = db.execute("SELECT * FROM users WHERE username=?", (payload.username.lower(),)).fetchone()
    stored = row["password"] if row else "0" * 32 + ":" + "0" * 128
    requested_role = payload.role.upper()
    valid_password = secrets.compare_digest(password_hash(payload.password, stored.split(":")[0]), stored)
    valid_role = bool(row and requested_role in ("ADMIN", "USER") and row["role"] == requested_role)
    if not (valid_password and valid_role):
        raise HTTPException(401, "Invalid credentials or role")
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    with auth_db() as db:
        db.execute("DELETE FROM sessions WHERE expires<=?", (now,))
        db.execute("DELETE FROM sessions WHERE token=?", (hashlib.sha256(request.cookies.get(COOKIE, "").encode()).hexdigest(),))
        db.execute("INSERT INTO sessions VALUES (?,?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), row["username"], csrf, now + SESSION_SECONDS))
    response = JSONResponse({"redirect": "/admin" if row["role"] == "ADMIN" else "/user"})
    response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True, samesite="strict", secure=request.url.scheme == "https" or os.environ.get("ULPIN_SECURE_COOKIE") == "1")
    return response


@app.post("/api/auth/logout")
def logout(request: Request):
    with auth_db() as db:
        db.execute("DELETE FROM sessions WHERE token=?", (hashlib.sha256(request.cookies.get(COOKIE, "").encode()).hexdigest(),))
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE)
    return response


@app.get("/api/admin/dashboard")
def admin_dashboard():
    global _pending_units_cache
    with auth_db() as db:
        users = [dict(row) for row in db.execute("SELECT username, role FROM users ORDER BY username")]
    if _pending_units_cache is None:
        _pending_units_cache = sum(f["verification_status"] != "Verified" for p in PARCELS for f in p["floors"])
    return {"users": users, "pending_units": _pending_units_cache, "audit_events": len(AUDIT_LOG)}


@app.post("/api/admin/users", status_code=201)
def add_account(payload: AccountRequest, request: Request):
    create_account(payload)
    AUDIT_LOG.append({"event": "account_created", "officer_id": request.state.account["username"], "timestamp": utc_now_iso()})
    return {"username": payload.username.lower(), "role": payload.role}


class OfficerAction(BaseModel):
    action: str
    officer_id: Optional[str] = "OFFICER-DEMO-001"
    note: Optional[str] = ""


class SelectionRequest(BaseModel):
    parcel_ids: list[str] = Field(min_length=1, max_length=200)
    provider: Literal["demo", "live"] = "demo"


class PackageRequest(SelectionRequest):
    name: str = Field(min_length=1, max_length=80)


class CompareTarget(BaseModel):
    name: str = Field(default="Custom selection", max_length=80)
    package_id: Optional[str] = None
    parcel_ids: list[str] = Field(default_factory=list, max_length=200)


class CompareRequest(BaseModel):
    targets: list[CompareTarget] = Field(min_length=2, max_length=8)
    provider: Literal["demo", "live"] = "demo"


class AnalysisRequest(SelectionRequest):
    question: Literal["best_agriculture", "highest_flood", "favorable_soil_weather"]


class OverlapRequest(BaseModel):
    parcel_id: str = Field(default="", max_length=40, pattern=r"^[A-Za-z0-9_-]*$")


@app.get("/api/areas")
def list_areas():
    return {"items": [{**a, "parcel_count": sum(p["area_id"] == a["id"] for p in PARCELS)} for a in AREAS]}


@app.get("/api/packages")
def list_packages():
    return {"items": PACKAGES}


@app.get("/api/packages/{package_id}")
def get_package(package_id: str, provider: Literal["demo", "live"] = "demo"):
    return package_details(package_id, provider)


@app.post("/api/packages", status_code=201)
def create_package(payload: PackageRequest, request: Request):
    parcels = resolve_parcels(payload.parcel_ids)
    if not payload.name.strip():
        raise HTTPException(422, "Package name cannot be blank")
    package = {"id": "PKG-" + secrets.token_hex(5).upper(), "name": payload.name.strip(),
               "description": "Session collection", "parcel_ids": [p["id"] for p in parcels], "predefined": False,
               "created_by": request.state.account["username"]}
    PACKAGES.append(package)
    return package


@app.put("/api/packages/{package_id}")
def update_package(package_id: str, payload: PackageRequest, request: Request):
    package = find_package(package_id)
    if request.state.account["role"] != "ADMIN" and package.get("created_by") != request.state.account["username"]:
        raise HTTPException(403, "Only the collection creator or an administrator can edit it")
    if package["predefined"]:
        raise HTTPException(409, "Save a new collection to modify a predefined package")
    parcels = resolve_parcels(payload.parcel_ids)
    if not payload.name.strip():
        raise HTTPException(422, "Package name cannot be blank")
    package.update(name=payload.name.strip(), parcel_ids=[p["id"] for p in parcels])
    return package


@app.post("/api/intelligence/aggregate")
def aggregate(payload: SelectionRequest):
    return combined_statistics(payload.parcel_ids, payload.provider)


@app.get("/api/intelligence/parcels/{parcel_id}")
def details(parcel_id: str, provider: Literal["demo", "live"] = "demo"):
    return parcel_intelligence(parcel_id, provider)


@app.get("/api/intelligence/parcels/{parcel_id}/{component}")
def component_details(parcel_id: str, component: Literal["soil", "agriculture", "weather", "risks", "suitability"], provider: Literal["demo", "live"] = "demo"):
    return {"parcel_id": parcel_id, "component": component, "data": parcel_intelligence(parcel_id, provider)[component]}


@app.post("/api/intelligence/compare")
def compare(payload: CompareRequest):
    for target in payload.targets:
        if bool(target.package_id) == bool(target.parcel_ids):
            raise HTTPException(422, "Each target requires either package_id or parcel_ids")
    return compare_targets([t.model_dump() for t in payload.targets], payload.provider)


@app.post("/api/intelligence/analyze")
def analyze(payload: AnalysisRequest):
    selection = combined_statistics(payload.parcel_ids, payload.provider)
    rows = selection["items"]
    if payload.question == "best_agriculture":
        selected = set(payload.parcel_ids)
        candidates = [{"package_id": p["id"], "name": p["name"], "statistics": combined_statistics(p["parcel_ids"], payload.provider)}
                      for p in PACKAGES if set(p["parcel_ids"]).issubset(selected)]
        candidates = sorted([p for p in candidates if p["statistics"]["suitability_score"] is not None],
                            key=lambda p: p["statistics"]["suitability_score"], reverse=True)
        result = [{"id": p["package_id"], "name": p["name"], "score": p["statistics"]["suitability_score"],
                   "reason": f"Area-weighted suitability; worst parcel risk {p['statistics']['risks']['worst_parcel_score']}/100"} for p in candidates]
    elif payload.question == "highest_flood":
        result = [{"id": r["parcel_id"], "score": r["risks"]["hazards"]["flood"]["score"],
                   "reason": "; ".join(r["risks"]["hazards"]["flood"]["reasons"])}
                  for r in sorted(rows, key=lambda r: r["risks"]["hazards"]["flood"]["score"], reverse=True)]
    else:
        result = [{"id": r["parcel_id"], "score": r["suitability"]["score"], "reason": "Soil quality >=70, suitability >=70 and weather hazard score <65"}
                  for r in sorted(rows, key=lambda r: r["suitability"]["score"] or 0, reverse=True)
                  if r["agriculture"] and r["soil"]["quality"] >= AGRI_SOIL_MIN and r["suitability"]["score"] >= AGRI_SUITABILITY_MIN and r["risks"]["overall_score"] < AGRI_RISK_MAX]
    return {"question": payload.question, "items": result, "scope": selection["parcel_ids"], "assessed_at": selection["assessed_at"],
            "model_version": selection["model_version"], "disclosure": selection["disclosure"],
            "workflow": ["Observe selected records", "Analyze soil/weather", "Reason with explicit screening rules", "Rank matching candidates", "Present recommendation", "Reassess with refreshed weather"]}


@app.get("/api/intelligence/tools")
def intelligence_tools():
    return {"schema": "/openapi.json", "model_version": "demo-screening-1.0", "tools": [
        {"name": "get_parcel", "method": "GET", "path": "/api/parcels/{parcel_id}"},
        {"name": "get_package", "method": "GET", "path": "/api/packages/{package_id}"},
        *[{"name": "get_" + name, "method": "GET", "path": "/api/intelligence/parcels/{parcel_id}/" + name} for name in ["soil", "agriculture", "weather", "risks", "suitability"]],
        *[{"name": name, "method": "POST", "path": "/api/intelligence/" + name} for name in ["aggregate", "compare", "analyze"]]]}


@app.get("/api/health")
def health() -> Dict[str, Any]:
    uptime = (datetime.now(timezone.utc) - APP_STARTED_AT).total_seconds()
    return {
        "status": "ok",
        "spatial_engine": "active",
        "parcel_count": len(PARCELS),
        "uptime_seconds": round(uptime, 2),
        "server_time_utc": utc_now_iso(),
    }


@app.get("/api/parcels")
def list_parcels() -> Dict[str, Any]:
    return {"count": len(PARCELS), "items": PARCELS}


@app.get("/api/parcels/{parcel_id}")
def get_parcel(parcel_id: str) -> Dict[str, Any]:
    return find_parcel(parcel_id)


@app.get("/api/search")
def search_parcels(
    state: str = Query(default=""),
    district: str = Query(default=""),
    survey_no: str = Query(default=""),
    ulpin: str = Query(default=""),
    area_id: str = Query(default=""),
    land_use: str = Query(default=""),
) -> Dict[str, Any]:
    state_q = state.strip().lower()
    district_q = district.strip().lower()
    survey_q = survey_no.strip().lower()
    ulpin_q = ulpin.strip().lower()

    results = []
    for parcel in PARCELS:
        if area_id and parcel["area_id"] != area_id:
            continue
        if land_use and parcel["land_use"].lower() != land_use.lower():
            continue
        searchable_ulpins = " ".join(
            [
                parcel["parcel_ulpin"],
                parcel["parcel_display_ulpin"],
                *[f["machine_ulpin"] for f in parcel["floors"]],
                *[f["ulpin"] for f in parcel["floors"]],
            ]
        ).lower()
        if state_q and state_q not in parcel["state"].lower():
            continue
        if district_q and district_q not in parcel["district"].lower():
            continue
        if survey_q and survey_q not in parcel["survey_no"].lower():
            continue
        if ulpin_q and ulpin_q not in searchable_ulpins:
            continue
        results.append(parcel)

    return {"count": len(results), "items": results}


@app.get("/api/overlap/preview")
def overlap_preview() -> Dict[str, Any]:
    conflicts = [
        build_overlap_conflict(a_id, checked=False, other_id=b_id)
        for a_id, b_id, _ in CONFLICT_CASES
    ]
    return {"count": len(conflicts), "items": conflicts}


@app.post("/api/overlap/check")
def overlap_check(payload: OverlapRequest) -> Dict[str, Any]:
    parcel_id = payload.parcel_id or PARCELS[0]["id"]
    conflict = build_overlap_conflict(parcel_id, checked=True)

    AUDIT_LOG.append(
        {
            "event": "overlap_check",
            "parcel_id": parcel_id,
            "conflict_id": conflict["id"],
            "timestamp": utc_now_iso(),
        }
    )
    return conflict


@app.post("/api/verify/{parcel_id}/{floor_id}")
def officer_action(parcel_id: str, floor_id: str, payload: OfficerAction, request: Request) -> Dict[str, Any]:
    parcel = find_parcel(parcel_id)
    floor = find_floor(parcel, floor_id)
    allowed = {
        "flag_conflict": "Spatial Boundary Conflict Flagged",
        "request_resurvey": "On-Site Re-Survey Requested",
        "approve": "Approved & Digital Property Card Issued",
    }
    action = payload.action.strip().lower()
    if action not in allowed:
        raise HTTPException(status_code=400, detail="Unsupported officer action")

    if action == "approve":
        floor["verification_status"] = "Verified"
    elif action == "flag_conflict":
        floor["verification_status"] = "Conflict Flagged"
    else:
        floor["verification_status"] = "Re-Survey Requested"
    global _pending_units_cache
    _pending_units_cache = None

    record = {
        "event_id": secrets.token_hex(6).upper(),
        "parcel_id": parcel_id,
        "floor_id": floor_id,
        "ulpin": floor["ulpin"],
        "machine_ulpin": floor["machine_ulpin"],
        "officer_id": request.state.account["username"],
        "action": action,
        "status": allowed[action],
        "note": (payload.note or "").strip()[:240],
        "timestamp": utc_now_iso(),
    }
    AUDIT_LOG.append(record)
    return {
        "ok": True,
        "record": record,
        "property_card": {
            "card_id": f"DVP-{record['event_id']}",
            "issued_at": record["timestamp"],
            "parcel": parcel,
            "floor": floor,
        }
        if action == "approve"
        else None,
    }


@app.get("/api/audit")
def audit_log(limit: int = Query(default=20, ge=1, le=100)) -> Dict[str, Any]:
    return {"items": list(reversed(AUDIT_LOG[-limit:]))}


def role_block(source, name, include):
    start, end = f"<!-- {name}:START -->", f"<!-- {name}:END -->"
    while start in source:
        before, remaining = source.split(start, 1)
        try:
            block, after = remaining.split(end, 1)
        except ValueError as exc:
            raise RuntimeError(f"Malformed {name} template block: missing {end}") from exc
        source = before + (block if include else "") + after
    return source


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return RedirectResponse("/admin" if request.state.account["role"] == "ADMIN" else "/user", 303)


@app.get("/login", response_class=HTMLResponse)
@app.get("/user", response_class=HTMLResponse)
@app.get("/admin", response_class=HTMLResponse)
def dashboard_page(request: Request):
    account = request.state.account
    if request.url.path == "/login" and account:
        return index(request)
    content = TEMPLATE_PATH.read_text(encoding="utf-8")
    content = role_block(content, "LOGIN", not account)
    content = role_block(content, "APP", bool(account))
    content = role_block(content, "ADMIN", bool(account and account["role"] == "ADMIN"))
    for key, value in {"AUTH_ROLE": account["role"] if account else "", "AUTH_USERNAME": account["username"] if account else "", "AUTH_CSRF": request.state.csrf}.items():
        content = content.replace("{{" + key + "}}", html.escape(value, quote=True))
    return HTMLResponse(
        content=content,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        },
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    # Keeps API failures machine-readable without exposing an internal traceback.
    if isinstance(exc, HTTPException):
        raise exc
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "type": exc.__class__.__name__},
    )


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "create-admin":
        password = getpass.getpass("Administrator password (12+ characters): ")
        if password != getpass.getpass("Confirm password: "):
            raise SystemExit("Passwords do not match")
        create_account(AccountRequest(username=sys.argv[2], password=password, role="ADMIN"))
        raise SystemExit("Administrator created.")
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8000,
        log_level="info",
        access_log=True,
    )
