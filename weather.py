"""Location-based weather providers. Demo is deterministic; live failures are explicit."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import math
import random
import time
from urllib.parse import urlencode
from urllib.request import urlopen

from data import AREAS, utc_now_iso

_CACHE = {}


def demo_weather(parcel):
    area = next(a for a in AREAS if a["id"] == parcel["area_id"])
    rng = random.Random(parcel["id"] + "weather-v1")
    temp = round(area["temperature"] + rng.uniform(-2, 2), 1)
    rain = round(max(0, area["rainfall"] + rng.uniform(-4, 5)), 1)
    today = datetime.now(timezone.utc).date()
    forecast = [{"date": (today + timedelta(days=i)).isoformat(),
                 "temperature_max": round(temp + rng.uniform(0, 4), 1),
                 "rainfall_mm": round(max(0, rain + rng.uniform(-3, 10)), 1),
                 "rain_probability": min(98, round(rain * 2 + 12))} for i in range(5)]
    return {"source": "Synthetic demo", "synthetic": True, "observed_at": utc_now_iso(),
            "location": parcel["centroid"], "temperature": temp, "precipitation": round(rain / 12, 1),
            "humidity": min(96, round(35 + rain + rng.uniform(0, 15))),
            "wind_speed": round(rng.uniform(6, 32), 1), "conditions": "Rain" if rain > 20 else "Partly cloudy" if rain > 3 else "Clear",
            "forecast": forecast, "rain_probability": forecast[0]["rain_probability"],
            "expected_rainfall_mm": forecast[0]["rainfall_mm"], "fallback_reason": None}


def live_weather(parcel):
    params = {"latitude": parcel["centroid"]["lat"], "longitude": parcel["centroid"]["lon"],
              "current": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code",
              "daily": "temperature_2m_max,precipitation_sum,precipitation_probability_max",
              "forecast_days": 5, "timezone": "UTC"}
    with urlopen("https://api.open-meteo.com/v1/forecast?" + urlencode(params), timeout=4) as response:
        raw = json.load(response)
    current, daily = raw["current"], raw["daily"]
    def number(v):
        if v is None or not math.isfinite(float(v)):
            raise ValueError("Missing weather measurement")
        return float(v)
    forecast = [{"date": day, "temperature_max": number(daily["temperature_2m_max"][i]),
                 "rainfall_mm": number(daily["precipitation_sum"][i]),
                 "rain_probability": number(daily["precipitation_probability_max"][i])}
                for i, day in enumerate(daily["time"])]
    if len(forecast) != 5:
        raise ValueError("Incomplete forecast")
    code = number(current["weather_code"])
    return {"source": "Open-Meteo", "synthetic": False, "observed_at": current["time"] + "Z",
            "location": parcel["centroid"], "temperature": number(current["temperature_2m"]),
            "humidity": number(current["relative_humidity_2m"]), "precipitation": number(current["precipitation"]),
            "wind_speed": number(current["wind_speed_10m"]),
            "conditions": "Thunderstorm" if code >= 95 else "Precipitation" if code >= 51 else "Cloudy" if code > 1 else "Clear",
            "forecast": forecast, "rain_probability": forecast[0]["rain_probability"],
            "expected_rainfall_mm": forecast[0]["rainfall_mm"], "fallback_reason": None}


def get_weather(parcel, provider="demo"):
    if provider == "demo":
        return demo_weather(parcel)
    key = (parcel["id"], provider)
    cached = _CACHE.get(key)
    if cached and time.monotonic() - cached[0] < 900:
        return deepcopy(cached[1])
    try:
        result = live_weather(parcel)
    except (OSError, TimeoutError):
        # Network failure: use the deterministic fallback.
        result = demo_weather(parcel)
        result["fallback_reason"] = "Live provider unavailable or incomplete; synthetic fallback used."
    except (ValueError, KeyError, TypeError, IndexError) as e:
        import logging
        logging.getLogger(__name__).warning("Weather parse error: %s", e)
        # Data parsing failure: use the deterministic fallback.
        result = demo_weather(parcel)
        result["fallback_reason"] = "Live provider unavailable or incomplete; synthetic fallback used."
    _CACHE[key] = (time.monotonic(), result)
    return deepcopy(result)
