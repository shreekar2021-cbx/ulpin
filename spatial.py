"""Deterministic local demo geometry, independent of analytical land records."""

import math
import random


def building_type(floors):
    usages = {f["usage"] for f in floors}
    if "Residential" in usages:
        return "Mixed-use building" if "Retail" in usages else "Residential building"
    if usages & {"Industrial", "Light Industrial", "Dispatch"}:
        return "Industrial building"
    if usages & {"Public Service", "Public"}:
        return "Civic building"
    if "Mixed-Use" in usages:
        return "Mixed-use building"
    if "Training" in usages and "Retail" not in usages:
        return "Institutional building"
    return "Commercial building"


def polygon(x, z, w, d, angle=0, clipped=False):
    corners = [(-w / 2, -d / 2), (w / 2, -d / 2),
               (w / 2, d / 2), (-w / 2, d / 2)]
    if clipped:
        corners = [(-w / 2, -d * .28), (-w * .28, -d / 2),
                   (w / 2, -d / 2), (w / 2, d * .32),
                   (w * .3, d / 2), (-w / 2, d / 2)]
    c, s = math.cos(angle), math.sin(angle)
    return [{"x": round(x + px * c - pz * s, 4),
             "z": round(z + px * s + pz * c, 4)} for px, pz in corners]


def assign_spatial_layouts(parcels, areas):
    for area in areas:
        aid = area["id"]
        local = [p for p in parcels if p["area_id"] == aid]
        roads = []

        def road(points, width=1.8, kind="road"):
            roads.append({"points": [{"x": x, "z": z} for x, z in points],
                          "width": width, "kind": kind})

        if aid == "HYD":
            road([(-29, -23), (29, -23), (31, 4), (27, 27)], 2.6)
            road([(-29, -23), (-29, 27), (27, 27)], 2)
            road([(-29, 4), (-15, 4), (-3, 6), (15, 5), (31, 4)], 1.3)
        elif aid == "JOD":
            ring = [(round(25 * math.cos(t * math.pi / 8), 3),
                     round(20 * math.sin(t * math.pi / 8), 3)) for t in range(17)]
            road(ring, 1.4, "track")
            road([(-58, 0), (-25, 0), (0, 0), (25, 0), (60, -8)], 2.2)
            road([(0, -46), (0, -20), (0, 0), (0, 20), (8, 48)], 1, "track")
        elif aid == "NIL":
            road([(-45, 25), (-22, 17), (12, 14), (36, 4), (12, -1),
                  (-24, -5), (-36, -15), (-9, -22), (34, -24)], 1.5)
        else:
            bend = {"WAR": 8, "LUD": 0, "NAS": -10, "ALP": 4}[aid]
            road([(-48, bend), (-20, 0), (12, 0), (46, -bend)], 2.1)
            road([(-7, -38), (-7, 0), (-7 + bend, 38)],
                 2.8 if aid in ("ALP", "LUD") else 1.3,
                 "canal" if aid in ("ALP", "LUD") else "track")

        area["spatial"] = {"coordinate_system": "local schematic units",
                           "source": "Synthetic demonstration", "roads": roads}
        for i, p in enumerate(local):
            rng = random.Random(f"spatial:{aid}:{p['id']}")
            angle = 0
            if aid != "HYD":
                farm = bool(p["agriculture"])
                w = 9 + math.sqrt(p["area_ha"]) * 2.1 if farm else 8 + rng.random() * 4
                d = w * rng.uniform(.65, 1.1)
                if aid == "JOD":
                    if farm:
                        t = (i + .5) * math.pi / 4
                        x, z = 43 * math.cos(t), 35 * math.sin(t)
                        angle = t * .3
                    else:
                        x, z = (-10 if i % 2 == 0 else 10), (-9 if i < 10 else 9)
                        angle = rng.uniform(-.22, .22)
                elif aid == "NIL":
                    x = -30 + (i % 4) * 20
                    z = -30 + (i // 4) * 24 + math.sin(i % 4) * 6
                    w, d, angle = w * 1.1, d * .48, -.22 + (i % 4) * .12
                elif aid == "ALP":
                    x, z = -32 + (i % 4) * 23, -25 + (i // 4) * 26
                    w, d, angle = w * .63, d * 1.25, .08
                elif aid == "LUD":
                    x, z = -33 + (i % 4) * 24, -26 + (i // 4) * 27
                    w, d = w * 1.1, d * .9
                elif aid == "NAS":
                    x, z = -34 + (i % 4) * 25, -27 + (i // 4) * 28 + (i % 2) * 4
                    w, d, angle = w * .7, d * 1.05, -.28
                else:
                    x, z = -34 + (i % 4) * 24 + (i // 4) * 4, -27 + (i // 4) * 27
                    angle = rng.uniform(-.18, .18)
                p["position"] = {"x": round(x, 4), "z": round(z, 4)}
                p["size"] = {"w": round(w, 4), "d": round(d, 4)}
                p["building"] = {"w": round(w * rng.uniform(.48, .65), 4),
                                 "d": round(d * rng.uniform(.5, .66), 4),
                                 "floor_h": .25 if farm else round(rng.uniform(.85, 1.2) if aid == "JOD" else rng.uniform(1.4, 2.3), 3)}
            x, z = p["position"]["x"], p["position"]["z"]
            w, d = p["size"]["w"], p["size"]["d"]
            p["boundary"] = polygon(x, z, w, d, angle, aid != "LUD" and i % 3 != 0)
            # Size is the world-aligned envelope used by camera and conflict tools.
            p["size"] = {"w": round(max(v["x"] for v in p["boundary"]) - min(v["x"] for v in p["boundary"]), 4),
                         "d": round(max(v["z"] for v in p["boundary"]) - min(v["z"] for v in p["boundary"]), 4)}
            building = p["building"]
            building["offset"] = {"x": round(w * .035 * math.cos(angle), 4), "z": round(d * .04, 4)}
            building["footprint"] = polygon(0, 0, building["w"], building["d"], angle, i % 2 == 1)
            # Legacy building dimensions and parcel.floors remain API-compatible.
            # Only buildings[] describes physical structures; cultivation F0 is a land record.
            building.update(id=f"{p['id']}-B1", parcel_id=p["id"],
                            type=building_type(p["floors"]) if not p["agriculture"] else None,
                            floors=p["floors"] if not p["agriculture"] else [],
                            position={"x": round(x + building["offset"]["x"], 4),
                                      "y": 0, "z": round(z + building["offset"]["z"], 4)})
            building["height"] = round(len(building["floors"]) * building["floor_h"], 4)
            p["buildings"] = [building] if building["floors"] else []
            if p["agriculture"]:
                p["cultivation_pattern"] = {"kind": "orchard" if aid == "NAS" else "terraces" if aid == "NIL" else "rows",
                                             "spacing": {"JOD": 2.8, "NAS": 2.4, "NIL": .65, "ALP": 1.2}.get(aid, .9),
                                             "angle": angle, "fallow": p["agriculture"]["cultivation_status"] == "Fallow"}
