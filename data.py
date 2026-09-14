from __future__ import annotations

import hashlib
import math
import random
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from spatial import assign_spatial_layouts


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def clean_token(value: str, max_len: int = 40) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "", value or "")[:max_len]


def mask_owner(seed: str) -> str:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    suffix = int(digest[:8], 16) % 10000
    return f"OWNER-****-{suffix:04d}"


def generate_vertical_ulpin(state_code: str, parcel_number: int, floor_index: int) -> Dict[str, str]:
    """
    Produces:
      - machine_id: strict 14-character uppercase alphanumeric identifier
      - display_id: readable vertical ULPIN label following the requested example style

    machine_id layout:
      SS + PPP + HHHHHH + FF + C
      2  + 3   + 6      + 2  + 1 = 14 chars
    """
    state = clean_token(state_code.upper(), 2).ljust(2, "X")[:2]
    parcel = f"{parcel_number:03d}"[-3:]
    floor_code = f"F{floor_index:02d}"
    digest = hashlib.sha256(
        f"INDIA|{state}|{parcel}|{floor_code}|VERTICAL-ULPIN".encode("utf-8")
    ).hexdigest().upper()
    hash6 = digest[:6]
    base13 = f"{state}{parcel}{hash6}{floor_code}"
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    checksum_value = sum((i + 3) * ord(ch) for i, ch in enumerate(base13)) % len(alphabet)
    check = alphabet[checksum_value]
    machine_id = f"{base13}{check}"
    display_id = f"ULPIN-IN-{state}-{parcel}-{floor_code}"
    return {"machine_id": machine_id, "display_id": display_id}


def floor_payload(
    state_code: str,
    parcel_number: int,
    floor_index: int,
    area_sqft: float,
    usage: str,
    lat: float,
    lon: float,
    owner_seed: str,
    registration_date: str,
    verification_status: Optional[str] = None,
) -> Dict[str, Any]:
    ids = generate_vertical_ulpin(state_code, parcel_number, floor_index)
    return {
        "id": f"F{floor_index}",
        "floor_index": floor_index,
        "name": "Ground Floor" if floor_index == 0 else f"Floor {floor_index}",
        "machine_ulpin": ids["machine_id"],
        "ulpin": ids["display_id"],
        "owner_id": mask_owner(owner_seed),
        "area_sqft": round(area_sqft, 2),
        "area_sqm": round(area_sqft * 0.092903, 2),
        "usage": usage,
        "centroid": {"lat": round(lat, 7), "lon": round(lon, 7)},
        "registration_date": registration_date,
        "verification_status": verification_status
        or ("Verified" if floor_index < 4 else "Pending Officer Review"),
    }


PARCEL_SEEDS = [
    {
        "id": "P-TS-001",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "SY-48/A",
        "parcel_number": 1,
        "property_type": "Commercial",
        "centroid": {"lat": 17.385044, "lon": 78.486671},
        "position": {"x": -8.5, "z": 0.0},
        "size": {"w": 10.5, "d": 9.0},
        "building": {"w": 7.2, "d": 6.2, "floor_h": 2.0},
        "floor_usages": ["Retail", "Office", "Office", "Co-working", "Training", "Terrace Utility"],
        "base_area": 1490,
        "reg": "2024-02-18",
    },
    {
        "id": "P-TS-002",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "SY-219/7",
        "parcel_number": 2,
        "property_type": "Residential",
        "centroid": {"lat": 17.392118, "lon": 78.491244},
        "position": {"x": 4.0, "z": -1.8},
        "size": {"w": 11.0, "d": 10.0},
        "building": {"w": 7.8, "d": 6.8, "floor_h": 2.0},
        "floor_usages": ["Lobby", "Residential", "Residential", "Residential", "Residential", "Amenities"],
        "base_area": 1325,
        "reg": "2023-11-04",
    },
    {
        "id": "P-TS-003",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "GAT-771/B",
        "parcel_number": 3,
        "property_type": "Industrial",
        "centroid": {"lat": 17.381932, "lon": 78.497805},
        "position": {"x": 1.5, "z": 10.0},
        "size": {"w": 12.0, "d": 9.5},
        "building": {"w": 8.4, "d": 6.4, "floor_h": 2.1},
        "floor_usages": ["Dispatch", "Light Industrial", "R&D", "Office", "Storage", "Utilities"],
        "base_area": 1710,
        "reg": "2024-05-29",
    },
    {
        "id": "P-TS-004",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "NDMC-88/C",
        "parcel_number": 4,
        "property_type": "Mixed-Use",
        "centroid": {"lat": 17.375441, "lon": 78.477912},
        "position": {"x": -19.5, "z": -12.0},
        "size": {"w": 9.5, "d": 8.5},
        "building": {"w": 6.5, "d": 5.9, "floor_h": 1.85},
        "floor_usages": ["Retail", "Office", "Co-working", "Residential", "Residential", "Amenities", "Terrace Utility"],
        "floor_statuses": ["Verified", "Verified", "Conflict Flagged", "Conflict Flagged", "Pending Officer Review", "Pending Officer Review", "Re-Survey Requested"],
        "base_area": 1210,
        "reg": "2022-09-13",
        "status": "Disputed Boundary",
    },
    {
        "id": "P-TS-005",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "TP-17/554",
        "parcel_number": 5,
        "property_type": "Commercial",
        "centroid": {"lat": 17.367824, "lon": 78.483566},
        "position": {"x": -9.0, "z": -14.5},
        "size": {"w": 12.5, "d": 10.5},
        "building": {"w": 8.8, "d": 7.3, "floor_h": 1.95},
        "floor_usages": ["Retail", "Office", "Office", "Office", "Co-working", "Training", "Utilities", "Terrace Utility"],
        "floor_statuses": ["Verified", "Verified", "Verified", "Verified", "Verified", "Pending Officer Review", "Pending Officer Review", "Pending Officer Review"],
        "base_area": 1845,
        "reg": "2023-03-02",
        "status": "Spatially Indexed",
    },
    {
        "id": "P-TS-006",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "TSLR-12/9",
        "parcel_number": 6,
        "property_type": "Residential",
        "centroid": {"lat": 17.371255, "lon": 78.501338},
        "position": {"x": 10.0, "z": -13.5},
        "size": {"w": 10.8, "d": 9.8},
        "building": {"w": 7.4, "d": 6.6, "floor_h": 1.9},
        "floor_usages": ["Lobby", "Residential", "Residential", "Residential", "Residential", "Amenities"],
        "floor_statuses": ["Verified", "Verified", "Re-Survey Requested", "Re-Survey Requested", "Pending Officer Review", "Pending Officer Review"],
        "base_area": 1360,
        "reg": "2021-12-19",
        "status": "Under Review",
    },
    {
        "id": "P-TS-007",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "KMC-4B/221",
        "parcel_number": 7,
        "property_type": "Public",
        "centroid": {"lat": 17.389747, "lon": 78.508912},
        "position": {"x": 20.0, "z": -8.0},
        "size": {"w": 11.6, "d": 9.2},
        "building": {"w": 7.8, "d": 6.1, "floor_h": 1.8},
        "floor_usages": ["Public Service", "Office", "Training", "Storage", "Utilities"],
        "floor_statuses": ["Verified", "Verified", "Pending Officer Review", "Pending Officer Review", "Pending Officer Review"],
        "base_area": 1590,
        "reg": "2024-07-07",
        "status": "Evidence Pending",
    },
    {
        "id": "P-TS-008",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "JDA-909/A",
        "parcel_number": 8,
        "property_type": "Institutional",
        "centroid": {"lat": 17.398062, "lon": 78.472388},
        "position": {"x": -20.5, "z": 8.0},
        "size": {"w": 13.2, "d": 11.0},
        "building": {"w": 9.1, "d": 7.8, "floor_h": 1.85},
        "floor_usages": ["Training", "Office", "Office", "R&D", "Amenities", "Utilities"],
        "floor_statuses": ["Verified", "Verified", "Verified", "Verified", "Pending Officer Review", "Pending Officer Review"],
        "base_area": 2020,
        "reg": "2020-04-26",
        "status": "Spatially Indexed",
    },
    {
        "id": "P-TS-009",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "SEC-142/77",
        "parcel_number": 9,
        "property_type": "Commercial",
        "centroid": {"lat": 17.405614, "lon": 78.486054},
        "position": {"x": -4.0, "z": 20.0},
        "size": {"w": 12.8, "d": 10.2},
        "building": {"w": 8.9, "d": 7.0, "floor_h": 1.92},
        "floor_usages": ["Retail", "Office", "Office", "Office", "Co-working", "Co-working", "R&D", "Utilities", "Terrace Utility"],
        "floor_statuses": ["Verified", "Verified", "Verified", "Conflict Flagged", "Conflict Flagged", "Pending Officer Review", "Pending Officer Review", "Pending Officer Review", "Pending Officer Review"],
        "base_area": 1895,
        "reg": "2025-01-16",
        "status": "Disputed Boundary",
    },
    {
        "id": "P-TS-010",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "VYT-35/2",
        "parcel_number": 10,
        "property_type": "Residential",
        "centroid": {"lat": 17.412982, "lon": 78.499721},
        "position": {"x": 11.5, "z": 16.5},
        "size": {"w": 10.2, "d": 8.6},
        "building": {"w": 7.1, "d": 5.8, "floor_h": 1.82},
        "floor_usages": ["Lobby", "Residential", "Residential", "Residential", "Amenities"],
        "floor_statuses": ["Pending Officer Review", "Pending Officer Review", "Pending Officer Review", "Pending Officer Review", "Pending Officer Review"],
        "base_area": 1130,
        "reg": "2026-06-30",
        "status": "Unverified Intake",
    },
    {
        "id": "P-TS-011",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "BDA-61/D",
        "parcel_number": 11,
        "property_type": "Industrial",
        "centroid": {"lat": 17.402441, "lon": 78.513606},
        "position": {"x": 21.0, "z": 9.5},
        "size": {"w": 13.8, "d": 10.4},
        "building": {"w": 9.6, "d": 7.1, "floor_h": 2.05},
        "floor_usages": ["Dispatch", "Light Industrial", "Light Industrial", "Storage", "Utilities", "Office"],
        "floor_statuses": ["Verified", "Verified", "Verified", "Verified", "Re-Survey Requested", "Conflict Flagged"],
        "base_area": 2140,
        "reg": "2019-10-11",
        "status": "Disputed Boundary",
    },
    {
        "id": "P-TS-012",
        "state": "Telangana",
        "state_code": "TS",
        "district": "Hyderabad",
        "survey_no": "GMDA-19/8",
        "parcel_number": 12,
        "property_type": "Public",
        "centroid": {"lat": 17.363995, "lon": 78.494207},
        "position": {"x": 2.5, "z": -23.0},
        "size": {"w": 9.0, "d": 8.0},
        "building": {"w": 6.1, "d": 5.5, "floor_h": 1.75},
        "floor_usages": ["Public Service", "Office", "Storage", "Utilities"],
        "floor_statuses": ["Verified", "Pending Officer Review", "Pending Officer Review", "Pending Officer Review"],
        "base_area": 980,
        "reg": "2025-08-05",
        "status": "Evidence Pending",
    },
]


def build_parcels() -> List[Dict[str, Any]]:
    parcels: List[Dict[str, Any]] = []
    for seed in PARCEL_SEEDS:
        floors = []
        floor_usages = seed["floor_usages"]
        floor_statuses = seed.get("floor_statuses", [])
        for floor_index, usage in enumerate(floor_usages):
            area_factor = 1.0 - (floor_index * 0.025)
            lat = seed["centroid"]["lat"] + (floor_index * 0.000006)
            lon = seed["centroid"]["lon"] + (floor_index * 0.000004)
            floors.append(
                floor_payload(
                    state_code=seed["state_code"],
                    parcel_number=seed["parcel_number"],
                    floor_index=floor_index,
                    area_sqft=seed["base_area"] * area_factor,
                    usage=usage,
                    lat=lat,
                    lon=lon,
                    owner_seed=f"{seed['id']}|{floor_index}|owner",
                    registration_date=seed["reg"],
                    verification_status=(
                        floor_statuses[floor_index]
                        if floor_index < len(floor_statuses)
                        else None
                    ),
                )
            )

        parcel_ids = generate_vertical_ulpin(seed["state_code"], seed["parcel_number"], 0)
        parcels.append(
            {
                "id": seed["id"],
                "state": seed["state"],
                "state_code": seed["state_code"],
                "district": seed["district"],
                "survey_no": seed["survey_no"],
                "parcel_number": seed["parcel_number"],
                "land_use": seed.get("land_use", seed["property_type"]),
                "property_type": seed["property_type"],
                "parcel_ulpin": parcel_ids["machine_id"],
                "parcel_display_ulpin": parcel_ids["display_id"].rsplit("-F00", 1)[0],
                "centroid": seed["centroid"],
                "position": seed["position"],
                "size": seed["size"],
                "building": dict(seed["building"]),
                "registered_area_sqft": round(seed["size"]["w"] * seed["size"]["d"] * 180.0, 2),
                "floors": floors,
                "status": seed.get("status", "Spatially Indexed"),
                # Regional soil context for the Hyderabad demo area. This is not a
                # field-tested engineering soil report; it is intended for site-screening.
                "soil": {
                    "type": "Red loamy / Chalka soil",
                    "region": "Southern Telangana / Hyderabad region",
                    "suitability": 78,
                    "source_note": "Regional government soil classification; field testing required for final engineering decisions.",
                },
            }
        )
    return parcels


AREA_SPECS = [
    ("HYD", "Hyderabad urban register", "Telangana", "TS", "Hyderabad", "Deccan urban", 17.385, 78.487, 520, 2, "Red loam", 29, 8, False, False),
    ("WAR", "Warangal cultivation belt", "Telangana", "TS", "Warangal", "Deccan plateau", 17.97, 79.59, 270, 3, "Black cotton", 31, 12, False, False),
    ("LUD", "Ludhiana canal command", "Punjab", "PB", "Ludhiana", "Northern alluvial plains", 30.90, 75.85, 250, 1, "Alluvial loam", 28, 5, False, False),
    ("NAS", "Nashik horticulture belt", "Maharashtra", "MH", "Nashik", "Western plateau", 20.00, 73.79, 580, 6, "Black loam", 27, 9, False, False),
    ("ALP", "Alappuzha lowland farms", "Kerala", "KL", "Alappuzha", "Coastal lowlands", 9.49, 76.34, 3, 1, "Clay loam", 30, 55, True, False),
    ("JOD", "Jodhpur dryland mosaic", "Rajasthan", "RJ", "Jodhpur", "Arid west", 26.24, 73.02, 230, 4, "Sandy loam", 40, 0, False, False),
    ("NIL", "Nilgiris upland estates", "Tamil Nadu", "TN", "Nilgiris", "Southern highlands", 11.41, 76.70, 1900, 24, "Lateritic loam", 22, 32, False, True),
]
AREAS = [dict(zip(("id", "name", "state", "state_code", "district", "region", "lat", "lon", "elevation", "slope", "soil_type", "temperature", "rainfall", "coastal", "forest"), spec)) for spec in AREA_SPECS]


def expand_parcels() -> List[Dict[str, Any]]:
    """Keep legacy records byte-compatible in identity; add deterministic regional plots."""
    parcels = build_parcels()
    uses = ["Agricultural"] * 8 + ["Residential", "Commercial", "Industrial", "Mixed-Use"]
    crops = {"WAR": ["Rice", "Cotton", "Maize"], "LUD": ["Rice", "Wheat", "Maize"],
             "NAS": ["Grapes", "Onion", "Millet"], "ALP": ["Rice", "Coconut"],
             "JOD": ["Millet", "Mustard"], "NIL": ["Tea", "Potato"]}
    for ai, area in enumerate(AREAS[1:], 1):
        for i in range(12):
            rng = random.Random(f"{area['id']}:{i}")
            number = ai * 100 + i + 1
            pid = f"P-{area['state_code']}-{number:03d}"
            lat, lon = round(area["lat"] + (i // 4) * .003, 6), round(area["lon"] + (i % 4) * .003, 6)
            agricultural = uses[i] == "Agricultural"
            hectares = round(rng.uniform(1.2, 24) if agricultural else rng.uniform(.15, 2.5), 4)
            ids = generate_vertical_ulpin(area["state_code"], number, 0)
            floors = [floor_payload(area["state_code"], number, f, hectares * 107639.104 / (1 if agricultural else 2),
                                    "Cultivation" if agricultural else uses[i], lat, lon, f"{pid}:{f}", "2025-03-12")
                      for f in range(1 if agricultural else 3)]
            if agricultural:
                floors[0]["name"] = "Ground land record"
            parcels.append({"id": pid, "area_id": area["id"], "state": area["state"], "state_code": area["state_code"],
                            "district": area["district"], "survey_no": f"AGR-{number}/A", "parcel_number": number,
                            "land_use": uses[i], "property_type": uses[i], "parcel_ulpin": ids["machine_id"],
                            "parcel_display_ulpin": ids["display_id"].rsplit("-F00", 1)[0],
                            "centroid": {"lat": lat, "lon": lon},
                            "position": {"x": 48 + ((ai - 1) % 3) * 56 + (i % 4) * 12, "z": -26 + ((ai - 1) // 3) * 55 + (i // 4) * 13},
                            "size": {"w": 9 + rng.random() * 2, "d": 10},
                            "building": {"w": 8, "d": 8, "floor_h": .25 if agricultural else 1.8},
                            "registered_area_sqft": round(hectares * 107639.104, 2), "floors": floors, "status": "Spatially Indexed"})
    for p in parcels:
        area = next(a for a in AREAS if a["id"] == p.get("area_id", "HYD"))
        rng = random.Random(p["id"])
        p.update(area_id=area["id"], region=area["region"], data_source="Synthetic demonstration",
                 area_ha=round(p["registered_area_sqft"] * .09290304 / 10000, 6),
                 elevation_m=round(max(0, area["elevation"] + rng.uniform(-2, 12)), 1),
                 slope_deg=round(max(0, area["slope"] + rng.uniform(-1, 3)), 1))
        moisture = rng.randint(65, 90) if area["coastal"] else rng.randint(12, 28) if area["id"] == "JOD" else rng.randint(32, 65)
        quality = rng.randint(55, 92)
        drainage = rng.randint(15, 40) if area["coastal"] else rng.randint(55, 92)
        p["soil"] = {"type": area["soil_type"], "region": area["region"], "quality": quality,
                     "condition": "Good" if quality >= 75 else "Moderate", "ph": round(rng.uniform(5.5, 8.1), 1),
                     "moisture_pct": moisture, "fertility": quality, "drainage_score": drainage,
                     "drainage": "Poor" if drainage < 40 else "Moderate" if drainage < 65 else "Good",
                     "suitability": quality, "source_note": "Synthetic soil profile; no field measurements."}
        p["agriculture"] = None
        if p["land_use"] == "Agricultural":
            irrigation = rng.choice(["Canal", "Drip", "Borewell", "Rainfed"])
            water = rng.randint(20, 45) if area["id"] == "JOD" else rng.randint(55, 95)
            p["agriculture"] = {"crop": crops[area["id"]][p["parcel_number"] % len(crops[area["id"]])],
                                "irrigation": irrigation, "irrigation_available": irrigation != "Rainfed",
                                "water_availability": water, "cultivation_status": rng.choice(["Growing", "Growing", "Sown", "Fallow"])}
    return parcels


PARCELS = expand_parcels()
assign_spatial_layouts(PARCELS, AREAS)
PARCEL_INDEX: Dict[str, Any] = {p["id"]: p for p in PARCELS}
PACKAGES = [{"id": f"PKG-{a['id']}", "name": a["name"], "description": a["region"],
             "parcel_ids": [p["id"] for p in PARCELS if p["area_id"] == a["id"] and (a["id"] == "HYD" or p["agriculture"])],
             "predefined": True} for a in AREAS]
PACKAGES.append({"id": "PKG-DIVERSE", "name": "Multi-region agriculture portfolio", "description": "Non-contiguous comparison portfolio",
                 "parcel_ids": [p["id"] for p in PARCELS if p["agriculture"] and p["parcel_number"] % 100 == 1], "predefined": True})
AUDIT_LOG: List[Dict[str, Any]] = []

CONFLICT_CASES = [
    ("P-TS-010", "P-TS-011", 7.2),
    ("P-TS-004", "P-TS-005", 6.6),
    ("P-TS-007", "P-TS-006", 5.4),
    ("P-TS-009", "P-TS-011", 8.3),
    ("P-TS-007", "P-TS-012", 3.9),
]


def find_parcel(parcel_id: str) -> Dict[str, Any]:
    parcel = PARCEL_INDEX.get(parcel_id)
    if not parcel:
        raise HTTPException(status_code=404, detail="Parcel not found")
    return parcel


def find_floor(parcel: Dict[str, Any], floor_id: str) -> Dict[str, Any]:
    records = [*parcel["floors"], *(f for b in parcel.get("buildings", []) for f in b["floors"])]
    for floor in records:
        if floor["id"] == floor_id:
            return floor
    raise HTTPException(status_code=404, detail="Floor not found")


def build_overlap_conflict(
    parcel_id: str, checked: bool = True, other_id: Optional[str] = None
) -> Dict[str, Any]:
    parcel = find_parcel(parcel_id)

    matched_case = next(
        (
            case
            for case in CONFLICT_CASES
            if parcel_id in case[:2] and (other_id is None or other_id in case[:2])
        ),
        None,
    )
    if matched_case:
        a_id, b_id, seeded_overlap = matched_case
        other_id = b_id if parcel_id == a_id else a_id
    else:
        neighbors = [p for p in PARCELS if p["area_id"] == parcel["area_id"]]
        parcel_index = next((i for i, item in enumerate(neighbors) if item["id"] == parcel_id), 0)
        other_id = neighbors[(parcel_index + 1) % len(neighbors)]["id"]
        seeded_overlap = None

    other = find_parcel(other_id)
    seed_text = f"{parcel_id}|{other_id}|overlap-v1"
    digest = hashlib.sha256(seed_text.encode("utf-8")).hexdigest()
    overlap_percent = (
        seeded_overlap
        if seeded_overlap is not None
        else round(2.4 + (int(digest[:4], 16) % 42) / 10.0, 1)
    )

    px, pz = parcel["position"]["x"], parcel["position"]["z"]
    ox, oz = other["position"]["x"], other["position"]["z"]
    conflict_x = (px + ox) / 2.0
    conflict_z = (pz + oz) / 2.0
    max_floor_h = max(parcel["building"]["floor_h"], other["building"]["floor_h"])

    return {
        "id": f"CLASH-{parcel_id}-{other_id}",
        "synthetic": True,
        "parcel_a": parcel_id,
        "parcel_b": other_id,
        "overlap_percent": overlap_percent,
        "centroid": {
            "lat": round((parcel["centroid"]["lat"] + other["centroid"]["lat"]) / 2.0, 7),
            "lon": round((parcel["centroid"]["lon"] + other["centroid"]["lon"]) / 2.0, 7),
        },
        "scene_volume": {
            "x": round(conflict_x, 3),
            "y": round(max_floor_h * 2.6, 3),
            "z": round(conflict_z, 3),
            "w": round(2.2 + overlap_percent * 0.12, 3),
            "h": round(max_floor_h * (4.2 + overlap_percent * 0.16), 3),
            "d": round(2.9 + overlap_percent * 0.10, 3),
        },
        "severity": "High" if overlap_percent >= 6.0 else "Medium" if overlap_percent >= 4.0 else "Low",
        "status": "checked" if checked else "preflight",
        "message": (
            f"Detected {overlap_percent:.1f}% spatial boundary overlap between "
            f"{parcel_id} and {other_id}. Vertical title geometry requires officer review."
        ),
        "checked_at": utc_now_iso() if checked else None,
    }
