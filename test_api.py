"""Isolated authentication and existing HTTP contract checks (stdlib only)."""
import json
import os
import atexit
import tempfile
import threading
import secrets
import socket
import time
import re
from http.cookiejar import CookieJar
from urllib.request import Request, build_opener, HTTPCookieProcessor
from urllib.error import HTTPError
import uvicorn
import app

temporary = tempfile.TemporaryDirectory()
app.AUTH_DB = os.path.join(temporary.name, "auth.sqlite3")
password = secrets.token_urlsafe(24)
app.create_account(app.AccountRequest(username="testadmin", password=password, role="ADMIN"))
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
base = f"http://127.0.0.1:{port}"
server = uvicorn.Server(uvicorn.Config(app.app, log_level="error"))
thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
thread.start()
def cleanup():
    server.should_exit = True
    thread.join(timeout=10)
    sock.close()
    temporary.cleanup()
atexit.register(cleanup)
for _ in range(100):
    if server.started:
        break
    time.sleep(.05)
assert server.started
cookies = CookieJar()
opener = build_opener(HTTPCookieProcessor(cookies))
csrf = ""


def request(path, payload=None, method=None, expected=200):
    data = None if payload is None else json.dumps(payload).encode()
    req = Request(base + path, data=data,
                  headers={"Content-Type": "application/json", "X-CSRF-Token": csrf}, method=method)
    try:
        with opener.open(req, timeout=30) as response:
            assert response.status == expected
            content = response.read().decode()
            return json.loads(content) if "application/json" in response.headers.get("Content-Type", "") else content
    except HTTPError as error:
        assert error.code == expected, (path, error.code, error.read())


assert 'id="loginForm"' in request("/")
request("/api/parcels", expected=401)
request("/api/admin/dashboard", expected=401)
request("/api/auth/login", {"username": "testadmin", "password": "invalid-password", "role": "ADMIN"}, expected=401)
request("/api/auth/login", {"username": "testadmin", "password": password, "role": "USER"}, expected=401)
assert request("/api/auth/login", {"username": "testadmin", "password": password, "role": "ADMIN"})["redirect"] == "/admin"
admin_html = request("/admin")
csrf = re.search(r'data-csrf="([^"]+)"', admin_html)[1]
assert 'id="tab-admin"' in admin_html and 'id="approveBtn"' in admin_html
assert request("/api/admin/dashboard")["users"][0]["role"] == "ADMIN"
request("/api/admin/users", {"username": "testuser", "password": password, "role": "USER"}, expected=201)
request("/api/admin/users", {"username": "testuser", "password": password}, expected=409)
record = request("/api/verify/P-TS-001/F1", {"action": "request_resurvey", "officer_id": "FORGED"})
assert record["record"]["officer_id"] == "testadmin"
assert "/api/intelligence/analyze" in request("/openapi.json")["paths"]
admin_cookie = next(iter(cookies))
assert admin_cookie.has_nonstandard_attr("HttpOnly")
request("/api/auth/logout", {})
request("/api/admin/dashboard", expected=401)
request("/api/auth/login", {"username": "testuser", "password": password, "role": "ADMIN"}, expected=401)
request("/api/auth/login", {"username": "testuser", "password": "invalid-password", "role": "USER"}, expected=401)
assert request("/api/auth/login", {"username": "testuser", "password": password, "role": "USER"})["redirect"] == "/user"
user_html = request("/user")
csrf = re.search(r'data-csrf="([^"]+)"', user_html)[1]
for control in ('id="tab-admin"', 'id="approveBtn"', 'id="auditList"', 'id="officerNote"', 'id="propertyModal"'):
    assert control not in user_html, control
for control in ('id="tab-land"', 'id="tab-verify"', 'id="certificatePreview"'):
    assert control in user_html
assert request("/user") == user_html
request("/admin", expected=403)
request("/api/admin/dashboard", expected=403)
request("/api/admin/users", {"username": "attacker", "password": password, "role": "ADMIN"}, expected=403)
request("/api/verify/P-TS-001/F1", {"action": "approve"}, expected=403)
request("/api/audit", expected=403)
request("/openapi.json", expected=403)
saved_csrf, csrf = csrf, "forged"
request("/api/auth/logout", {}, expected=403)
csrf = saved_csrf
assert request("/api/health")["parcel_count"] == 84
assert request("/api/search?state=Punjab")["count"] == 12
assert request("/api/search?land_use=Agricultural")["count"] == 48
assert request("/api/search?area_id=ALP")["count"] == 12
assert request("/api/search?ulpin=ULPIN-IN-TS-001-F02")["count"] == 1
assert request("/api/search?survey_no=DOES-NOT-EXIST")["count"] == 0
assert request("/api/overlap/preview")["count"] == 5
assert request("/api/overlap/check", {"parcel_id": "P-TS-010"})["overlap_percent"] == 7.2
for component in ["soil", "agriculture", "weather", "risks", "suitability"]:
    assert request("/api/intelligence/parcels/P-PB-201/" + component)["data"]
assert request("/api/intelligence/aggregate", {"parcel_ids": ["P-TS-001"] * 2})["parcel_count"] == 1
request("/api/intelligence/aggregate", {"parcel_ids": []}, expected=422)
request("/api/intelligence/aggregate", {"parcel_ids": ["unknown"]}, expected=404)
request("/api/intelligence/aggregate", {"parcel_ids": ["P-TS-001"], "provider": "invalid"}, expected=422)
request("/api/packages", {"name": " ", "parcel_ids": ["P-TS-001"]}, expected=422)
result = request("/api/intelligence/compare", {"targets": [{"package_id": "PKG-LUD"}, {"package_id": "PKG-ALP"}, {"package_id": "PKG-JOD"}]})
assert len(result["items"]) == 3
assert request("/api/packages/PKG-LUD")["statistics"]["parcel_count"] == 8
request("/api/packages/not-found", expected=404)
assert len(request("/api/intelligence/tools")["tools"]) == 10
request("/api/auth/logout", {})
request("/api/parcels", expected=401)
assert 'id="loginForm"' in request("/user")
print("PASS: authentication, roles, server-rendered controls, CSRF, logout, persistence, search, conflict, detail, validation, packages, comparison, tools.")
