"""Pure, explainable screening tools for UI and future agent integrations."""
from concurrent.futures import ThreadPoolExecutor
from functools import partial

from fastapi import HTTPException
from data import AREAS, PACKAGES, find_parcel, utc_now_iso
from weather import get_weather

MODEL_VERSION = "demo-screening-1.0"


def mean(rows, getter):
    area = sum(r["area_ha"] for r in rows)
    return round(sum(getter(r) * r["area_ha"] for r in rows) / area, 2) if area else None


def score(value):
    return round(max(0, min(100, value)), 1)


def level(value):
    return "High" if value >= 65 else "Moderate" if value >= 35 else "Low"


def environmental_risks(parcel, weather):
    soil = parcel["soil"]
    area = next(a for a in AREAS if a["id"] == parcel["area_id"])
    rain = max(d["rainfall_mm"] for d in weather["forecast"])
    heat = max(d["temperature_max"] for d in weather["forecast"])
    # Contributions are screening points, not probabilities or calibrated hazard forecasts.
    factors = {
        "flood": [(rain >= 40, 30, "Heavy rainfall forecast (>=40 mm/day)"), (soil["drainage_score"] < 40, 25, "Poor drainage (<40/100)"),
                  (soil["moisture_pct"] >= 65, 20, "High soil moisture (>=65%)"), (parcel["elevation_m"] < 15, 20, "Low elevation (<15 m)")],
        "drought": [(soil["moisture_pct"] < 30, 35, "Low soil moisture (<30%)"), (sum(d["rainfall_mm"] for d in weather["forecast"]) < 25, 25, "Little rain in five-day outlook"),
                    ((parcel["agriculture"] or {}).get("water_availability", 70) < 45, 25, "Limited water availability"), (heat > 38, 10, "High evaporative heat")],
        "extreme_rainfall": [(rain >= 25, 25, "Forecast daily rainfall >=25 mm"), (rain >= 50, 40, "Forecast daily rainfall >=50 mm"), (rain >= 80, 25, "Forecast daily rainfall >=80 mm")],
        "heat": [(heat >= 32, 20, "Forecast maximum >=32 C"), (heat >= 38, 40, "Forecast maximum >=38 C"), (heat >= 42, 30, "Forecast maximum >=42 C")],
        "storm_cyclone": [(weather["wind_speed"] >= 25, 25, "Elevated wind (>=25 km/h)"), (weather["wind_speed"] >= 50, 40, "Strong wind (>=50 km/h)"),
                          (area["coastal"], 15, "Coastal exposure"), (rain >= 40, 20, "Heavy rainfall")],
        "landslide": [(parcel["slope_deg"] >= 15, 30, "Steep terrain (>=15 degrees)"), (rain >= 25, 25, "Rainfall on slopes"), (soil["moisture_pct"] > 55, 20, "Wet soil"), (rain >= 50, 20, "Heavy rainfall on slopes")],
        "wildfire": [(soil["moisture_pct"] < 30, 30, "Dry soil"), (heat >= 32, 30, "Hot forecast"), (weather["humidity"] < 40, 20, "Low humidity"), (weather["wind_speed"] > 25, 15, "Elevated wind")],
    }
    hazards = {}
    for name, inputs in factors.items():
        applicable = parcel["slope_deg"] >= 15 if name == "landslide" else area["forest"] if name == "wildfire" else True
        contributions = [{"points": points, "reason": reason} for condition, points, reason in inputs if condition] if applicable else []
        value = score(sum(c["points"] for c in contributions)) if applicable else None
        hazards[name] = {"score": value, "level": level(value) if applicable else "Not applicable", "applicable": applicable,
                         "contributions": contributions, "reasons": [c["reason"] for c in contributions] or ["No elevated screening factors" if applicable else "Outside modeled terrain / vegetation context"]}
    overall = max(h["score"] for h in hazards.values() if h["applicable"])
    return {"overall_score": overall, "level": level(overall), "hazards": hazards, "synthetic": True,
            "model_version": MODEL_VERSION, "method": "Maximum applicable hazard score; heuristic points, not event probabilities."}


def agricultural_suitability(parcel, weather, risks):
    ag, soil = parcel["agriculture"], parcel["soil"]
    if ag is None:
        return {"applicable": False, "score": None, "label": "Non-agricultural land", "stress": [], "components": {}}
    components = {"soil_quality": soil["quality"], "ph_fit": score(100 - abs(soil["ph"] - 6.7) * 30),
                  "moisture_fit": score(100 - abs(soil["moisture_pct"] - (65 if ag["crop"] == "Rice" else 45)) * 2),
                  "water": ag["water_availability"], "terrain": score(100 - parcel["slope_deg"] * 2),
                  "weather": 100 - risks["overall_score"]}
    weights = {"soil_quality": .25, "ph_fit": .15, "moisture_fit": .15, "water": .2, "terrain": .1, "weather": .15}
    value = score(sum(components[k] * weights[k] for k in weights))
    stress = [name.replace("_", " ") for name, h in risks["hazards"].items() if h["applicable"] and h["score"] >= 65]
    if components["ph_fit"] < 65:
        stress.append("pH outside screening target")
    return {"applicable": True, "score": value, "label": "Favorable" if value >= 75 else "Conditional" if value >= 55 else "Constrained",
            "stress": stress, "components": components, "weights": weights,
            "method": "Weighted soil, pH, moisture, water, terrain and weather screening; not crop yield prediction."}


def parcel_intelligence(parcel_id, provider="demo"):
    p = find_parcel(parcel_id)
    weather = get_weather(p, provider)
    risks = environmental_risks(p, weather)
    return {"parcel_id": p["id"], "area_id": p["area_id"], "area_ha": p["area_ha"], "land_use": p["land_use"],
            "soil": p["soil"], "agriculture": p["agriculture"], "elevation_m": p["elevation_m"], "slope_deg": p["slope_deg"],
            "weather": weather, "risks": risks, "suitability": agricultural_suitability(p, weather, risks)}


def resolve_parcels(parcel_ids):
    ids = list(dict.fromkeys(parcel_ids))
    if not ids:
        raise HTTPException(422, "Select at least one parcel")
    return [find_parcel(pid) for pid in ids]


def find_package(package_id):
    package = next((p for p in PACKAGES if p["id"] == package_id), None)
    if not package:
        raise HTTPException(404, "Package not found")
    return package


def combined_statistics(parcel_ids, provider="demo"):
    parcels = resolve_parcels(parcel_ids)
    if provider == "live":
        with ThreadPoolExecutor(max_workers=12) as pool:
            _intel = partial(parcel_intelligence, provider=provider)
            items = list(pool.map(lambda p: _intel(p["id"]), parcels))
    else:
        items = [parcel_intelligence(p["id"], provider) for p in parcels]
    ag = [r for r in items if r["agriculture"]]
    composition = {}
    for p in parcels:
        composition[p["land_use"]] = round(composition.get(p["land_use"], 0) + p["area_ha"], 6)
    temp = mean(items, lambda r: r["weather"]["temperature"])
    rain = mean(items, lambda r: r["weather"]["expected_rainfall_mm"])
    hazard_summary = {}
    for hazard in items[0]["risks"]["hazards"]:
        applicable = [r for r in items if r["risks"]["hazards"][hazard]["applicable"]]
        hazard_summary[hazard] = {"mean_score": mean(applicable, lambda r: r["risks"]["hazards"][hazard]["score"]),
                                  "max_score": max((r["risks"]["hazards"][hazard]["score"] for r in applicable), default=None),
                                  "high_risk_parcels": [r["parcel_id"] for r in applicable if r["risks"]["hazards"][hazard]["score"] >= 65]}
    return {"parcel_ids": [p["id"] for p in parcels], "parcel_count": len(parcels), "area_count": len({p["area_id"] for p in parcels}),
            "total_area_ha": round(sum(p["area_ha"] for p in parcels), 6), "land_use_ha": composition,
            "agricultural_area_ha": round(sum(r["area_ha"] for r in ag), 6),
            "soil": {"types": sorted({p["soil"]["type"] for p in parcels}), "ph": mean(items, lambda r: r["soil"]["ph"]),
                     "moisture_pct": mean(items, lambda r: r["soil"]["moisture_pct"]), "quality": mean(items, lambda r: r["soil"]["quality"])},
            "water_availability": mean(ag, lambda r: r["agriculture"]["water_availability"]),
            "suitability_score": mean(ag, lambda r: r["suitability"]["score"]),
            "weather": {"temperature": temp, "expected_rainfall_mm": rain,
                        "humidity": mean(items, lambda r: r["weather"]["humidity"]), "wind_speed": mean(items, lambda r: r["weather"]["wind_speed"]),
                        "sources": sorted({r["weather"]["source"] for r in items}),
                        "different_conditions": [r["parcel_id"] for r in items if abs(r["weather"]["temperature"] - temp) >= 4 or abs(r["weather"]["expected_rainfall_mm"] - rain) >= 15],
                        "forecast": [{"date": items[0]["weather"]["forecast"][i]["date"],
                                      "temperature_max": mean(items, lambda r: r["weather"]["forecast"][i]["temperature_max"]),
                                      "rainfall_mm": mean(items, lambda r: r["weather"]["forecast"][i]["rainfall_mm"]),
                                      "rain_probability": mean(items, lambda r: r["weather"]["forecast"][i]["rain_probability"])} for i in range(5)]},
            "risks": {"overall_score": mean(items, lambda r: r["risks"]["overall_score"]),
                      "worst_parcel_score": max(r["risks"]["overall_score"] for r in items), "hazards": hazard_summary},
            "items": items, "assessed_at": utc_now_iso(), "model_version": MODEL_VERSION,
            "method": "Area-weighted means; land area counted once per unique parcel. Hazard maxima preserve localized risks. Collections are not proof of contiguity.",
            "disclosure": "Synthetic land, soil and heuristic risk scores. Weather provenance is reported per parcel. Not real-world predictions."}


def package_details(package_id, provider="demo"):
    package = find_package(package_id)
    return {**package, "statistics": combined_statistics(package["parcel_ids"], provider)}


def compare_targets(targets, provider="demo"):
    rows = []
    for target in targets:
        ids = find_package(target["package_id"])["parcel_ids"] if target.get("package_id") else target["parcel_ids"]
        name = find_package(target["package_id"])["name"] if target.get("package_id") else target.get("name", "Custom selection")
        rows.append({"name": name, "statistics": combined_statistics(ids, provider)})
    return {"items": rows, "method": "Compare total area, agricultural suitability and hazard exposure; no legal or financial ranking."}
